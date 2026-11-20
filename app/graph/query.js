// Reads over the memory graph: a budgeted neighborhood query, paths, explain, entity and decisions. A name that matches
// several nodes is refused with the candidates; nothing here guesses.

// how strongly an edge kind and a provenance carry relevance from one node to the next
const KIND_W = { decision_about: 1, decided_in: 0.9, attended: 0.9, works_on: 0.9, member_of: 0.9, about: 0.9, contradicts: 0.8, supersedes: 0.7, embeds: 0.7, mentions: 0.6, links_to: 0.6, tagged: 0.3, in_folder: 0.15 };
const PROV_W = { person: 1, explicit: 1, rule: 0.8, model: 0.6 };
const HOP = 0.7;
// a folder or a tag can join thousands of notes: it is reached, never expanded
const HUB_KINDS = new Set(['folder', 'tag']);
const MAX_VISIT = 5000;
export const DEFAULT_BUDGET = 1500;

// rough tokens for an item as a tool would print it (4 characters a token)
export const tokensOf = (x) => Math.ceil(JSON.stringify(x).length / 4);
const brief = (n) => (n ? { id: n.id, kind: n.kind, name: n.name, rel: n.rel ?? null } : null);
const edgeOut = (e, nameOf) => ({ id: e.id, src: e.src, srcName: nameOf(e.src), dst: e.dst, dstName: nameOf(e.dst), kind: e.kind, provenance: e.provenance, source_rel: e.source_rel, source_line: e.source_line, confidence: e.confidence, valid_from: e.valid_from, valid_to: e.valid_to, superseded_by: e.superseded_by, ...(e.props && Object.keys(e.props).length ? { props: e.props } : {}) });

// keep items in order until the budget is spent; say what was left out and the budget that would show everything
export function fit(items, budget = DEFAULT_BUDGET) {
  let used = 0;
  let need = 0;
  const shown = [];
  for (const it of items) {
    const t = tokensOf(it);
    need += t;
    if (used + t <= budget || !shown.length) { shown.push(it); used += t; }
  }
  return { shown, truncated: { shown: shown.length, total: items.length, budgetNeeded: need } };
}

// fit over rows made into items only as they are shown, so a node with thousands of edges costs what the budget shows.
// Stops at the first item that does not fit; budgetNeeded counts the rest at the shown items' average
function fitLazy(rows, toItem, budget, total = null) {
  let used = 0;
  const shown = [];
  for (const r of rows) {
    const it = toItem(r);
    const t = tokensOf(it);
    if (used + t > budget && shown.length) break;
    shown.push(it);
    used += t;
  }
  const all = total ?? (Array.isArray(rows) ? rows.length : shown.length);
  const per = shown.length ? used / shown.length : 0;
  return { shown, used, truncated: { shown: shown.length, total: all, budgetNeeded: Math.ceil(used + per * (all - shown.length)) } };
}

// sections share one budget by turns, so each keeps its first items: { key: [row] } -> { out: { key: [item] }, used }
function share(sections, toItem, budget) {
  const order = Object.keys(sections);
  const out = Object.fromEntries(order.map((k) => [k, []]));
  let left = budget;
  let used = 0;
  for (let round = 0; left > 0; round++) {
    let added = false;
    for (const k of order) {
      const row = sections[k][round];
      if (row === undefined) continue;
      const it = toItem(k, row);
      const t = tokensOf(it);
      if (t > left) { left = 0; break; }
      out[k].push(it);
      left -= t;
      used += t;
      added = true;
    }
    if (!added) break;
  }
  return { out, used };
}

export function createQuery(store) {
  const nameOf = (id) => store.node(id)?.name ?? id;
  const current = (e) => e.superseded_by == null;

  // a node id, a vault path, or a name: one node, or why there is not one
  function resolveRef(ref, { kind = null } = {}) {
    const r = String(ref ?? '').trim();
    if (!r) return { notFound: r };
    const byId = store.node(r);
    if (byId) return { node: byId };
    if (/\.md$/i.test(r)) {
      const rows = store.nodesByRel(r);
      const n = rows.find((x) => x.kind !== 'note' && (!kind || [].concat(kind).includes(x.kind))) ?? rows.find((x) => x.kind === 'note');
      if (n) return { node: n };
    }
    const hits = store.find(r, { kind });
    if (!hits.length) return { notFound: r };
    // a tag or folder named like a person, project or note gives way to it: #quorum next to the Quorum project is not a
    // second meaning. A match on the start of a name only is a candidate, never the answer
    const named = hits.length > 1 ? hits.filter((x) => x.kind !== 'tag' && x.kind !== 'folder') : hits;
    if (named.length === 1 && !named[0].prefix) return { node: named[0] };
    return { ambiguous: hits.map(brief) };
  }

  function graphQuery({ q = '', seeds = [], budget = DEFAULT_BUDGET, depth = 2, kinds = null, current: cur = true } = {}) {
    const start = [];
    for (const s of seeds ?? []) {
      const r = resolveRef(s);
      if (r.node) start.push(r.node.id);
    }
    if (q && String(q).trim()) {
      const r = resolveRef(q);
      if (r.ambiguous && !start.length) return { ambiguous: r.ambiguous };
      if (r.node) start.push(r.node.id);
    }
    const seedIds = [...new Set(start)];
    if (!seedIds.length) return { seeds: [], nodes: [], edges: [], truncated: { shown: 0, total: 0, budgetNeeded: 0 } };
    // best-first over the neighborhood: a node's score is the strongest path to it from a seed
    const score = new Map(seedIds.map((id) => [id, 1]));
    const hops = new Map(seedIds.map((id) => [id, 0]));
    const seen = new Map();
    let frontier = seedIds;
    for (let d = 0; d < depth && frontier.length && score.size < MAX_VISIT; d++) {
      const next = [];
      for (const id of frontier) {
        const n = store.node(id);
        if (d > 0 && n && HUB_KINDS.has(n.kind)) continue;
        for (const e of store.edgesOf(id, { kinds, current: cur })) {
          seen.set(e.id, e);
          const other = e.src === id ? e.dst : e.src;
          const s = score.get(id) * (KIND_W[e.kind] ?? 0.5) * (PROV_W[e.provenance] ?? 0.5) * (e.confidence ?? 1) * HOP;
          if (!score.has(other)) { next.push(other); hops.set(other, d + 1); }
          if (s > (score.get(other) ?? 0)) score.set(other, s);
          if (score.size >= MAX_VISIT) break;
        }
      }
      frontier = next;
    }
    // the order needs only the scores: nodes and edges are read out for what the budget shows
    const rounded = new Map([...score].map(([id, s]) => [id, Math.round(s * 1000) / 1000]));
    const order = [...rounded.keys()].sort((a, b) => rounded.get(b) - rounded.get(a) || hops.get(a) - hops.get(b) || a.localeCompare(b));
    const names = new Map();
    const named = (id) => { if (!names.has(id)) names.set(id, nameOf(id)); return names.get(id); };
    const nodeItem = (id) => ({ ...brief(store.node(id) ?? { id, kind: id.split(':')[0], name: id }), score: rounded.get(id), depth: hops.get(id) });
    const nf = fitLazy(order, nodeItem, Math.floor(budget * 0.7), order.length);
    const keep = new Set(nf.shown.map((n) => n.id));
    const edges = [...seen.values()].filter((e) => keep.has(e.src) && keep.has(e.dst)).sort((a, b) => (KIND_W[b.kind] ?? 0) - (KIND_W[a.kind] ?? 0) || a.id - b.id);
    const ef = fitLazy(edges, (e) => edgeOut(e, named), Math.max(0, budget - nf.used), edges.length);
    const perEdge = ef.shown.length ? ef.used / ef.shown.length : 0;
    return {
      seeds: seedIds,
      nodes: nf.shown,
      edges: ef.shown,
      truncated: { shown: nf.truncated.shown, total: nf.truncated.total, budgetNeeded: Math.ceil(nf.truncated.budgetNeeded + perEdge * seen.size), edgesShown: ef.shown.length, edgesTotal: seen.size },
    };
  }

  function graphPath(a, b, { undirected = true, kinds = null, current: cur = true, maxDepth = 6 } = {}) {
    const ra = resolveRef(a);
    if (!ra.node) return ra.ambiguous ? { ambiguous: ra.ambiguous, for: 'a' } : { notFound: String(a) };
    const rb = resolveRef(b);
    if (!rb.node) return rb.ambiguous ? { ambiguous: rb.ambiguous, for: 'b' } : { notFound: String(b) };
    const from = ra.node.id, to = rb.node.id;
    if (from === to) return { path: [brief(ra.node)], edges: [] };
    const prev = new Map([[from, null]]);
    let frontier = [from];
    for (let d = 0; d < maxDepth && frontier.length && !prev.has(to); d++) {
      const next = [];
      for (const id of frontier) {
        const n = store.node(id);
        if (id !== from && n && HUB_KINDS.has(n.kind)) continue;
        for (const e of store.edgesOf(id, { dir: undirected ? 'both' : 'out', kinds, current: cur })) {
          const other = e.src === id ? e.dst : e.src;
          if (prev.has(other)) continue;
          prev.set(other, e);
          next.push(other);
          if (other === to) break;
        }
        if (prev.has(to)) break;
      }
      frontier = next;
    }
    if (!prev.has(to)) return { path: null, edges: [] };
    const path = [];
    const edges = [];
    for (let id = to; id; ) {
      path.unshift(brief(store.node(id) ?? { id, kind: id.split(':')[0], name: id }));
      const e = prev.get(id);
      if (!e) break;
      edges.unshift(edgeOut(e, nameOf));
      id = e.src === id ? e.dst : e.src;
    }
    return { path, edges };
  }

  // a folder or a tag can have thousands of edges: they share the budget by turns, and only the shown ones are read out
  function explain(ref, { budget = DEFAULT_BUDGET } = {}) {
    const r = resolveRef(ref);
    if (!r.node) return r;
    const n = r.node;
    const all = store.edgesOf(n.id, { current: false });
    const head = { node: n, source: n.rel ? { rel: n.rel } : null, aliases: store.aliasesOf(n.id), community: store.community(n.id) };
    const sections = { out: all.filter((e) => e.src === n.id && current(e)), in: all.filter((e) => e.dst === n.id && current(e)), history: all.filter((e) => !current(e)) };
    const toItem = (k, e) => (k === 'history' ? { ...edgeOut(e, nameOf), supersededBy: e.superseded_by ? edgeOut(store.edge(e.superseded_by) ?? { id: e.superseded_by }, nameOf) : null } : edgeOut(e, nameOf));
    const headT = tokensOf(head);
    const { out, used } = share(sections, toItem, Math.max(0, budget - headT));
    const shown = out.out.length + out.in.length + out.history.length;
    const per = shown ? used / shown : 0;
    return {
      ...head, ...out,
      truncated: { shown, total: all.length, budgetNeeded: Math.ceil(headT + used + per * (all.length - shown)), sections: Object.fromEntries(Object.keys(sections).map((k) => [k, { shown: out[k].length, total: sections[k].length }])) },
    };
  }

  // a decision node as the tools show it
  function decisionOut(d) {
    const out = store.edgesOf(d.id, { dir: 'out', current: false });
    const about = out.filter((e) => e.kind === 'decision_about');
    const inMeeting = out.find((e) => e.kind === 'decided_in');
    const superseded = about.find((e) => e.superseded_by != null);
    const by = superseded ? store.edge(superseded.superseded_by) : null;
    return {
      id: d.id, text: d.props?.text ?? d.name, date: d.props?.date ?? null, rel: d.rel, line: d.props?.line ?? null,
      // a superseded decision keeps what it was about: its own edges are history then, not gone
      about: [...new Map((about.some(current) ? about.filter(current) : about).map((e) => [e.dst, { id: e.dst, name: nameOf(e.dst) }])).values()],
      decidedIn: inMeeting ? { id: inMeeting.dst, name: nameOf(inMeeting.dst) } : null,
      supersededBy: by ? { id: by.src, text: store.node(by.src)?.props?.text ?? nameOf(by.src) } : null,
      // where the decision came from: a line the note states (explicit), the model pass's reading of its prose (model,
      // with its confidence), or a reading a person approved in Review (person)
      provenance: (inMeeting ?? about[0])?.provenance ?? null,
      ...((inMeeting ?? about[0])?.provenance === 'model' ? { confidence: (inMeeting ?? about[0]).confidence } : {}),
    };
  }
  const isCurrentDecision = (id) => !store.edgesOf(id, { dir: 'out', kinds: ['decision_about'], current: false }).some((e) => e.superseded_by != null);
  const byDate = (a, b) => (b.date ?? 0) - (a.date ?? 0) || String(a.id).localeCompare(String(b.id));

  // every decision, newest first, a page at a time from SQL: the current filter and the date order run there, and only
  // the shown decisions are read out
  const PAGE = 50;
  const decisionPage = (cur, t) => {
    const where = "n.kind = 'decision' and (? = 0 or not exists (select 1 from edges e where e.src = n.id and e.kind = 'decision_about' and e.superseded_by is not null)) and (? is null or coalesce(json_extract(n.props, '$.date'), 0) >= ?)";
    const rows = store.db().prepare(`select n.id from nodes n where ${where} order by coalesce(json_extract(n.props, '$.date'), 0) desc, n.id limit ? offset ?`);
    const count = store.db().prepare(`select count(*) as n from nodes n where ${where}`);
    const args = [cur ? 1 : 0, t, t];
    return {
      total: count.get(...args).n,
      *[Symbol.iterator]() {
        for (let off = 0; ; off += PAGE) {
          const page = rows.all(...args, PAGE, off).map((r) => store.node(r.id)).filter(Boolean).map((d) => ({ ...d, date: d.props?.date ?? null })).sort(byDate);
          yield* page;
          if (page.length < PAGE) return;
        }
      },
    };
  };

  function decisions({ about = null, since = null, current: cur = true, budget = DEFAULT_BUDGET } = {}) {
    const t0 = since ? (typeof since === 'number' ? since : Date.parse(String(since))) : null;
    const t = t0 == null || Number.isNaN(t0) ? null : t0;
    if (!about) {
      const page = decisionPage(cur, t);
      const { shown, truncated } = fitLazy(page, decisionOut, budget, page.total);
      return { about: null, decisions: shown, truncated };
    }
    const r = resolveRef(about);
    if (!r.node) return r;
    const subject = r.node;
    const ids = new Set();
    for (const e of store.edgesOf(subject.id, { dir: 'in', kinds: ['decision_about', 'decided_in'], current: false })) ids.add(e.src);
    // decisions made in the notes about it, and in its own note
    const notes = new Set(store.edgesOf(subject.id, { dir: 'in', kinds: ['about'] }).map((e) => e.src));
    if (subject.rel) notes.add(`note:${subject.rel}`);
    for (const nid of notes) {
      for (const e of store.edgesOf(nid, { dir: 'in', kinds: ['decided_in'] })) ids.add(e.src);
      const meeting = nid.startsWith('note:') ? store.edgesOf(nid, { dir: 'out', kinds: ['about'] }).find((e) => e.dst.startsWith('meeting:')) : null;
      if (meeting) for (const e of store.edgesOf(meeting.dst, { dir: 'in', kinds: ['decided_in'] })) ids.add(e.src);
    }
    const rows = [...ids].map((id) => store.node(id)).filter((d) => d && d.kind === 'decision')
      .filter((d) => t == null || (d.props?.date ?? 0) >= t)
      .filter((d) => !cur || isCurrentDecision(d.id))
      .map((d) => ({ ...d, date: d.props?.date ?? null }))
      .sort(byDate);
    const { shown, truncated } = fitLazy(rows, decisionOut, budget);
    return { about: brief(subject), decisions: shown, truncated };
  }

  // a person, project or company with the meetings, decisions, notes and people around it
  function entity(name, { budget = DEFAULT_BUDGET } = {}) {
    const r = resolveRef(name, { kind: ['person', 'project', 'company', 'topic'] });
    if (!r.node) return r;
    const n = r.node;
    const own = n.rel ? `note:${n.rel}` : null;
    const edges = [...store.edgesOf(n.id), ...(own ? store.edgesOf(own, { dir: 'in' }) : [])];
    const meetings = new Map();
    const notes = new Map();
    const people = new Map();
    const projects = new Map();
    const dated = (id, e) => ({ ...brief(store.node(id) ?? { id, kind: id.split(':')[0], name: id }), date: e.valid_from ?? store.node(id)?.props?.date ?? null, via: e.kind });
    for (const e of edges) {
      const other = e.src === n.id || e.src === own ? e.dst : e.src;
      if (other === n.id || other === own) continue;
      const k = other.split(':')[0];
      if (k === 'meeting') meetings.set(other, dated(other, e));
      else if (k === 'note') { const o = store.node(other); const m = o && store.edgesOf(other, { dir: 'out', kinds: ['about'] }).find((x) => x.dst.startsWith('meeting:')); if (m) meetings.set(m.dst, dated(m.dst, e)); else notes.set(other, dated(other, e)); }
      else if (k === 'person') people.set(other, dated(other, e));
      else if (k === 'project' || k === 'company') projects.set(other, dated(other, e));
    }
    // the people at its meetings, for a project or company
    if (n.kind !== 'person') for (const m of meetings.keys()) for (const e of store.edgesOf(m, { dir: 'in', kinds: ['attended'] })) if (!people.has(e.src)) people.set(e.src, dated(e.src, e));
    const sort = (m) => [...m.values()].sort(byDate);
    // the decisions come already cut to the budget: no section can show more than the whole budget holds
    const dec = decisions({ about: n.id, budget: Math.max(0, budget) });
    const sections = { decisions: dec.decisions, meetings: sort(meetings), people: sort(people), projects: sort(projects), notes: sort(notes) };
    // the budget is shared: every section keeps its first items, then the rest fill what is left in order
    const head = { node: brief(n), rel: n.rel, aliases: store.aliasesOf(n.id), status: n.props?.status ?? null };
    const order = Object.keys(sections);
    const { out: parts } = share(sections, (_k, it) => it, budget - tokensOf(head));
    const totals = { ...Object.fromEntries(order.map((k) => [k, sections[k].length])), decisions: dec.truncated.total };
    const listed = order.flatMap((k) => sections[k]);
    const shown = order.reduce((s, k) => s + parts[k].length, 0);
    const decMore = Math.max(0, dec.truncated.budgetNeeded - dec.decisions.reduce((t, it) => t + tokensOf(it), 0));
    return {
      ...head, ...parts,
      truncated: { shown, total: listed.length - sections.decisions.length + totals.decisions, budgetNeeded: tokensOf(head) + listed.reduce((t, it) => t + tokensOf(it), 0) + decMore, sections: Object.fromEntries(order.map((k) => [k, { shown: parts[k].length, total: totals[k] }])) },
    };
  }

  return { resolveRef, graphQuery, graphPath, explain, entity, decisions };
}
