// Token budgets and compact formatting for the memory tools (memoryTools.mjs). Pure. Each answer becomes lines for an
// agent: one per node, edge or passage, with its source path and line, provenance and dates, strongest first, trimmed to
// the budget, and a last line that says what was left out and the budget that would return everything.
import { DEFAULT_BUDGET } from './memoryTools.mjs';

// about four characters per token for English and markdown; close enough to budget by
export const tokens = (text) => Math.ceil(String(text ?? '').length / 4);
export const budgetOf = (b) => (Number.isFinite(Number(b)) && Number(b) > 0 ? Math.max(100, Math.min(50000, Math.round(Number(b)))) : DEFAULT_BUDGET);

const PASSAGE_CHARS = 320;
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return null; };
const oneLine = (t, max = Infinity) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const n = (x) => Number(x).toLocaleString('en-US');
const plural = (count, noun) => `${n(count)} ${count === 1 ? noun : `${noun}s`}`;

// a date as YYYY-MM-DD from an ISO string, epoch milliseconds or epoch seconds
export function day(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? new Date(v < 1e11 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}
// a node named by id, or an object with one
const ref = (v) => (typeof v === 'string' ? v : pick(v, 'id', 'rel', 'name'));
const at = (rel, line) => (rel ? `${rel}${line != null ? `:${line}` : ''}` : null);

export function nodeLine(node) {
  const id = pick(node, 'id') ?? '';
  const name = pick(node, 'name');
  const rel = pick(node, 'rel');
  // note:, meeting: and decision: ids carry the path already
  const byPath = !!rel && id.slice(id.indexOf(':') + 1).split('#')[0] === rel;
  const shownName = name && !id.endsWith(name) && !(byPath && id.split('/').pop().replace(/\.md(#.*)?$/, '') === name) ? `  ${name}` : '';
  const file = rel && !byPath ? `  (${rel})` : '';
  const when = day(pick(node, 'date', 'updated_at', 'updatedAt'));
  return `${id}${shownName}${file}${when ? `  ${when}` : ''}`;
}

// src -kind-> dst  [provenance, path:line, confidence, from..to, superseded by]
export function edgeLine(edge) {
  const from = day(pick(edge, 'valid_from', 'validFrom'));
  const to = day(pick(edge, 'valid_to', 'validTo'));
  const by = pick(edge, 'superseded_by', 'supersededBy');
  const conf = pick(edge, 'confidence');
  const meta = [
    pick(edge, 'provenance'),
    at(pick(edge, 'source_rel', 'sourceRel'), pick(edge, 'source_line', 'sourceLine')),
    conf != null && Number(conf) < 1 ? `confidence ${Number(conf).toFixed(2)}` : null,
    from || to ? `${from ?? '?'}..${to ?? 'now'}` : null,
    by != null ? `superseded by edge ${typeof by === 'object' ? pick(by, 'id') : by}` : null,
  ].filter(Boolean);
  return `${pick(edge, 'src') ?? '?'} -${pick(edge, 'kind') ?? 'edge'}-> ${pick(edge, 'dst') ?? '?'}${meta.length ? `  [${meta.join(', ')}]` : ''}`;
}

export function passageLine(c) {
  const start = pick(c, 'start_line', 'startLine');
  const end = pick(c, 'end_line', 'endLine');
  const lines = start != null ? `:${start}${end != null && end !== start ? `-${end}` : ''}` : '';
  const heading = oneLine(pick(c, 'heading'));
  const score = pick(c, 'score');
  return `${pick(c, 'rel') ?? '?'}${lines}${heading ? `  # ${heading}` : ''}${score != null ? `  (${Number(score).toFixed(3)})` : ''}  ${oneLine(pick(c, 'text', 'snippet'), PASSAGE_CHARS)}`;
}

export function decisionLine(d) {
  const when = day(pick(d, 'date', 'valid_from', 'validFrom', 'decided_at', 'decidedAt'));
  const text = oneLine(pick(d, 'text', 'name') ?? '', PASSAGE_CHARS);
  const about = [].concat(pick(d, 'about') ?? []).map(ref).filter(Boolean);
  const by = pick(d, 'superseded_by', 'supersededBy');
  const to = day(pick(d, 'valid_to', 'validTo'));
  const meta = [
    at(pick(d, 'rel', 'source_rel', 'sourceRel'), pick(d, 'line', 'source_line', 'sourceLine')),
    // the meeting a decision was decided in, unless it is the note the line already names
    pick(d, 'decidedIn', 'decided_in', 'meeting') && ref(pick(d, 'decidedIn', 'decided_in', 'meeting')) !== `meeting:${pick(d, 'rel', 'source_rel', 'sourceRel')}` ? `in ${ref(pick(d, 'decidedIn', 'decided_in', 'meeting'))}` : null,
    about.length ? `about ${about.join(', ')}` : null,
    pick(d, 'provenance'),
    by != null ? `superseded by ${ref(by)}${to ? ` on ${to}` : ''}` : to ? `ended ${to}` : null,
  ].filter(Boolean);
  return `${when ?? '????-??-??'}  ${pick(d, 'id') ?? ''}  ${text}${meta.length ? `  [${meta.join('; ')}]` : ''}`.replace(/ {3,}/g, '  ');
}

// head lines always go out; items are { text, noun, group? } strongest first. Items are kept in order while they fit; with
// groups, the groups take turns so each keeps its strongest, and the lines come back under their group's title.
// upstream: the handler's own truncated summary ({ shown, total, budgetNeeded }) when it already left items out
export function fit({ head = [], items = [], groups = null, budget, upstream = null, noun = 'item' }) {
  const max = budgetOf(budget);
  const order = groups ? roundRobin(groups) : items.map((it, i) => ({ ...it, at: i }));
  const headCost = head.reduce((s, l) => s + tokens(l) + 1, 0);
  let used = headCost;
  let all = headCost;
  let full = false;
  const kept = [];
  const left = new Map();
  const counts = new Map();
  for (const it of order) {
    const cost = tokens(it.text) + 1;
    const k = it.noun ?? noun;
    all += cost;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    // strongest first: once one line does not fit, everything after it is left out too
    if (!full && used + cost <= max) { kept.push(it); used += cost; } else { full = true; left.set(k, (left.get(k) ?? 0) + 1); }
  }
  const up = upstream && Number(upstream.total) > Number(upstream.shown) ? upstream : null;
  if (up) {
    const extra = Number(up.total) - Number(up.shown);
    left.set(noun, (left.get(noun) ?? 0) + extra);
    counts.set(noun, (counts.get(noun) ?? 0) + extra);
    // the lines the handler did not send cost about what the sent ones did
    const per = order.length ? (all - headCost) / order.length : 0;
    all = Math.max(all + Math.ceil(per * extra), Number(up.budgetNeeded) || 0);
  }
  // graph_query also counts the edges it left out
  const edgesOut = Number(upstream?.edgesTotal) - Number(upstream?.edgesShown);
  if (edgesOut > 0) { left.set('edge', (left.get('edge') ?? 0) + edgesOut); counts.set('edge', (counts.get('edge') ?? 0) + edgesOut); }
  const body = groups ? regroup(groups, kept) : kept.sort((a, b) => a.at - b.at).map((it) => it.text);
  return [...head, ...body, summary(counts, left, all, used)];
}

function roundRobin(groups) {
  const out = [];
  const queues = groups.map((g, gi) => g.items.map((it, i) => ({ ...it, group: gi, at: i })));
  for (let i = 0; queues.some((q) => i < q.length); i += 1) for (const q of queues) if (i < q.length) out.push(q[i]);
  return out;
}
function regroup(groups, kept) {
  return groups.flatMap((g, gi) => {
    const lines = kept.filter((it) => it.group === gi).sort((a, b) => a.at - b.at).map((it) => `  ${it.text}`);
    return lines.length ? [`${g.title} (${lines.length} of ${g.items.length}):`, ...lines] : g.items.length ? [`${g.title}: ${plural(g.items.length, 'line')} left out`] : [];
  });
}
function summary(counts, left, all, used) {
  const total = [...counts.values()].reduce((s, x) => s + x, 0);
  if (!total) return 'Nothing found.';
  const out = [...left.entries()].filter(([, c]) => c > 0);
  if (!out.length) return `All ${[...counts.entries()].map(([k, c]) => plural(c, k)).join(' and ')} shown (about ${n(used)} tokens).`;
  const parts = out.map(([k, c]) => `${n(c)} of ${plural(counts.get(k), k)}`);
  return `Left out ${parts.join(' and ')} (about ${n(Math.max(0, all - used))} tokens). budget ${n(Math.ceil(all / 100) * 100)} returns everything; or ask a narrower question.`;
}

// a name that matches several nodes: the candidates, never a guess
export function ambiguousLines(q, candidates) {
  return [`"${q}" matches ${plural(candidates.length, 'node')}. Call again with one id:`, ...candidates.map((c) => `  ${typeof c === 'string' ? c : nodeLine(c)}`)];
}

// graph_query: each node, then the edges it completes (an edge goes under the first of its two ends that is shown)
function graphItems(nodes, edges) {
  const rank = new Map(nodes.map((nd, i) => [pick(nd, 'id'), i]));
  const under = new Map();
  const loose = [];
  for (const e of edges) {
    const r = Math.min(rank.get(e.src) ?? Infinity, rank.get(e.dst) ?? Infinity);
    if (r === Infinity) loose.push(e); else under.set(r, [...(under.get(r) ?? []), e]);
  }
  return [
    ...nodes.flatMap((nd, i) => [{ text: nodeLine(nd), noun: 'node' }, ...(under.get(i) ?? []).map((e) => ({ text: `  ${edgeLine(e)}`, noun: 'edge' }))]),
    ...loose.map((e) => ({ text: edgeLine(e), noun: 'edge' })),
  ];
}

const list = (v) => (Array.isArray(v) ? v : []);

// one tool's answer from the app as lines, trimmed to budget
export function formatMemory(tool, result, { budget, args = {} } = {}) {
  const r = result ?? {};
  if (Array.isArray(r.ambiguous)) return ambiguousLines((r.for ? args[r.for] : null) ?? args.q ?? args.name ?? args.id ?? args.about ?? args.a ?? '', r.ambiguous);
  if (r.notFound != null) return [`No node named "${r.notFound}". Try search, or graph_query with other words.`];
  const upstream = r.truncated && typeof r.truncated === 'object' ? r.truncated : null;
  switch (tool) {
    case 'search':
      return fit({ items: list(r.results ?? r.chunks ?? r.hits).map((c) => ({ text: passageLine(c), noun: 'passage' })), budget, upstream, noun: 'passage' });
    case 'graph_query':
      return fit({ items: graphItems(list(r.nodes), list(r.edges)), budget, upstream, noun: 'node' });
    case 'graph_path': {
      const steps = list(r.edges ?? r.path?.edges);
      const nodes = list(r.path ?? r.nodes);
      if (!steps.length) return [nodes.length ? nodeLine(nodes[0]) : `No path between ${args.a ?? '?'} and ${args.b ?? '?'}.`];
      return fit({ head: [`${plural(steps.length, 'step')} from ${pick(steps[0], 'src')} to ${pick(steps[steps.length - 1], 'dst')}:`], items: steps.map((e) => ({ text: edgeLine(e), noun: 'edge' })), budget, upstream, noun: 'edge' });
    }
    case 'explain': {
      const nd = r.node ?? r;
      const aliases = list(r.aliases ?? nd.aliases);
      const head = [
        nodeLine(nd),
        pick(r, 'source') || nd.rel ? `source: ${typeof r.source === 'string' ? r.source : at(pick(r.source, 'rel') ?? nd.rel, pick(r.source, 'line'))}` : null,
        aliases.length ? `aliases: ${aliases.join(', ')}` : null,
        pick(r, 'community') ? `community: ${typeof r.community === 'string' ? r.community : pick(r.community, 'name', 'community')}` : null,
      ].filter(Boolean);
      const groups = [
        { title: 'Outgoing', items: list(r.outgoing ?? r.out).map((e) => ({ text: edgeLine(e), noun: 'edge' })) },
        { title: 'Incoming', items: list(r.incoming ?? r.in).map((e) => ({ text: edgeLine(e), noun: 'edge' })) },
        { title: 'Superseded', items: list(r.history ?? r.superseded).map((e) => ({ text: edgeLine(e), noun: 'edge' })) },
      ];
      return fit({ head, groups, budget, upstream, noun: 'edge' });
    }
    case 'entity': {
      const nd = r.node ?? r.entity ?? {};
      const groups = [
        { title: 'Decisions', items: list(r.decisions).map((d) => ({ text: decisionLine(d), noun: 'decision' })) },
        { title: 'Meetings', items: list(r.meetings).map((m) => ({ text: nodeLine(m), noun: 'meeting' })) },
        { title: 'People', items: list(r.people).map((p) => ({ text: nodeLine(p), noun: 'person' })) },
        { title: 'Projects', items: list(r.projects).map((p) => ({ text: nodeLine(p), noun: 'project' })) },
        { title: 'Notes', items: list(r.notes).map((x) => ({ text: nodeLine(x), noun: 'note' })) },
        { title: 'Edges', items: list(r.edges).map((e) => ({ text: edgeLine(e), noun: 'edge' })) },
      ];
      return fit({ head: [`${nodeLine(nd)}${r.rel && !nd.rel ? `  (${r.rel})` : ''}`], groups, budget, upstream, noun: 'item' });
    }
    case 'decisions':
      return fit({ items: list(r.decisions ?? r.results).map((d) => ({ text: decisionLine(d), noun: 'decision' })), budget, upstream, noun: 'decision' });
    case 'memory_status':
      return fit({ items: statusLines(r).map((text) => ({ text, noun: 'line' })), budget, noun: 'line' }).slice(0, -1);
    default:
      return [JSON.stringify(r)];
  }
}

// memory_status: key: value lines; a nested object becomes "key: a 1, b 2"
export function statusLines(o, prefix = '') {
  return Object.entries(o ?? {}).flatMap(([k, v]) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.length && typeof v[0] === 'object' ? [`${prefix}${k}:`, ...v.map((x) => `  ${oneLine(Object.values(x).join('  '))}`)] : [`${prefix}${k}: ${v.join(', ') || 'none'}`];
    if (typeof v === 'object') {
      const flat = Object.values(v).every((x) => x == null || typeof x !== 'object');
      return flat ? [`${prefix}${k}: ${Object.entries(v).filter(([, x]) => x != null).map(([a, x]) => `${a} ${typeof x === 'number' ? n(x) : x}`).join(', ')}`] : statusLines(v, `${prefix}${k}.`);
    }
    return [`${prefix}${k}: ${typeof v === 'number' ? n(v) : v}`];
  });
}
