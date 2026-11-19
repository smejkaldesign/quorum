// Memory setup: the scan that runs when a person creates or connects a vault, and again from Settings, Memory. It
// waits for the vault index and the memory graph, runs the review rules over every note (the gaps below are rules, so
// each one lands in Needs review with its fix), and builds the report the setup screen shows: what was found, what
// Quorum will fix, freshness, and the instruction files outside the vault folder.
//
// Gaps (rules/index.js SETUP_RULES, plus the duplicate, oversized, orphan and broken link checks that already ran):
//   note.missing-entity  a name several notes mention with no note: write it from a template, link the mentions
//   note.entity-alias    one person or project under two names: merge the notes, or add the alias
//   note.meeting-links   meeting attendees in plain text: link them
//   note.entity-type     notes the graph reads as people or projects with no type: set it, one item per folder
//   note.unplaced        notes outside the folder for their kind: move them
//   note.summary-stale   summaries whose sources changed: record the hashes, or mark them stale
//   note.instructions    CLAUDE.md, AGENTS.md and similar: size budget (listed, no fix), decisions a newer one replaced
//
// The fixes run through the fix run machinery like every other finding (main.js runOp, batchPlan.js, versions, Undo);
// this module holds the steps of the ops the setup rules added (create, mention, alias, merge, split), and, after a
// batch, the person-provenance edges its approved connections record in the graph store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { aliasText, rewriteLinks, writeAtomic } from './relink.js';
import { vaultPath, vaultTarget, walk } from './vault.js';
import { sha } from './fixUndo.js';
import { linkMentions } from './keeper.js';
import { parseNote } from './linkparse.js';
import { RULE_LABELS, SETUP_RULES } from './rules/index.js';
import { entityKinds, normName, PEOPLE_KEYS, PROJECT_KEYS } from './rules/entities.js';
import { BUDGET, INSTRUCTION_NAME } from './rules/instructions.js';
import { bodyOf, DAY } from './rules/common.js';
import { ENTITY_FOLDERS, entityId, folderKind, noteKind } from './graph/extract.js';

// the ops this module runs for a finding item (main.js runOp hands them here)
export const SETUP_OPS = new Set(['create', 'mention', 'alias', 'merge', 'split']);
export const FRESH_DAYS = 90;
const noExt = (rel) => String(rel).replace(/\.md$/i, '');
const base = (rel) => noExt(rel).split('/').pop();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text after a mention op: the first plain mention of name in the body becomes a link to target (keeper.js
// linkMentions), else the name's entry in a people or project field of the frontmatter becomes a quoted wikilink.
// A name the note links already is left as it is
export function linkMention(text, name, target) {
  const t = String(text ?? '');
  const link = target.toLowerCase() === String(name).toLowerCase() ? `[[${name}]]` : `[[${target}|${name}]]`;
  const body = linkMentions(t, [{ name, target }]).replace(new RegExp(`\\[\\[${esc(target)}\\|(${esc(name)})\\]\\]`, 'i'), (m, n) => (target.toLowerCase() === n.toLowerCase() ? `[[${n}]]` : m));
  if (body !== t) return body;
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return t;
  const keys = [...PEOPLE_KEYS, ...PROJECT_KEYS].join('|');
  const lines = m[1].split(/\r?\n/);
  let key = null;
  const want = normName(name);
  const same = (v) => normName(String(v).trim().replace(/^["']|["']$/g, '').replace(/\s*\((recorder|host|organizer|me)\)\s*$/i, '')) === want;
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = new RegExp(`^(${keys})$`, 'i').test(kv[1]) ? kv[1] : null;
      if (!key || !kv[2].trim()) continue;
      const v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']') && !v.startsWith('[[')) {
        const items = v.slice(1, -1).split(',');
        const at = items.findIndex(same);
        if (at < 0) continue;
        items[at] = `${items[at].match(/^\s*/)[0]}${JSON.stringify(link)}`;
        lines[i] = `${kv[1]}: [${items.join(',')}]`;
      } else if (same(v)) lines[i] = `${kv[1]}: ${JSON.stringify(link)}`;
      else continue;
      return t.replace(m[1], lines.join('\n'));
    }
    const item = lines[i].match(/^(\s+-\s+)(.*)$/);
    if (key && item && same(item[2])) { lines[i] = `${item[1]}${JSON.stringify(link)}`; return t.replace(m[1], lines.join('\n')); }
  }
  return t;
}

// The kept note's text after a merge: the other note's names as aliases, and its body under a heading unless the kept
// note holds that body already
export function mergeText(keepText, dropText, { title, names = [] }) {
  let out = String(keepText ?? '');
  const have = new Set(parseNote('x.md', out).aliases.map((a) => a.toLowerCase()));
  const own = parseNote('x.md', out).title.toLowerCase();
  for (const n of [...new Set(names.filter(Boolean))]) {
    if (have.has(n.toLowerCase()) || n.toLowerCase() === own) continue;
    out = aliasText(out, n);
    have.add(n.toLowerCase());
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const dropBody = bodyOf(dropText).replace(/^#\s+.*\n+/, '').trim();
  if (dropBody && !norm(bodyOf(out)).includes(norm(dropBody))) out = `${out.replace(/\s*$/, '')}\n\n## From ${title}\n\n${dropBody}\n`;
  return out;
}

// The text after a split: each part's lines leave the note and become a note of their own; the heading stays with a
// link line under it. parts: [{ heading, start, end, to }], lines 0-based, end exclusive. Throws when a heading moved
export function splitText(text, parts, { from }) {
  const lines = String(text ?? '').split('\n');
  const notes = [];
  for (const p of [...parts].sort((a, b) => b.start - a.start)) {
    if (!/^##\s+/.test(lines[p.start] ?? '') || lines[p.start].replace(/^##\s+/, '').trim() !== p.heading) throw new Error(`The heading “${p.heading}” moved since Quorum checked the note. Review it again`);
    const body = lines.slice(p.start + 1, p.end).join('\n').trim();
    notes.unshift({ rel: p.to, text: `---\nsplit_from: ${JSON.stringify(`[[${base(from)}]]`)}\n---\n# ${p.heading}\n\n${body}\n` });
    lines.splice(p.start, p.end - p.start, lines[p.start], '', `- [[${base(p.to)}]]`, '');
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n'), notes };
}

// The notes in the vault folder that the index leaves out (private, excluded, denied) whose text links to rel: a merge
// cannot point their links at the kept note, so it does not run. Only a yes or no leaves this function
export function unindexedLinkers(vault, rel, indexed) {
  const name = base(rel).toLowerCase();
  const full = noExt(rel).toLowerCase();
  const out = [];
  let all;
  try { all = walk(vault, '', () => false, []); } catch { return out; }
  for (const r of all) {
    if (indexed.has(r) || r === rel) continue;
    let t;
    try { t = readFileSync(path.join(vault, r), 'utf8').toLowerCase(); } catch { continue; }
    for (const m of t.matchAll(/!?\[\[([^\]|#]+)|\]\(([^)#\s]+?)(?:\.md)?(?:#[^)]*)?\)/g)) {
      let target = m[1] ?? m[2] ?? '';
      try { target = decodeURI(target); } catch { /* a stray % stays as written */ }
      target = target.trim().replace(/\.md$/, '');
      if (target === name || target === full || target.endsWith(`/${name}`)) { out.push(r); break; }
    }
  }
  return out;
}

// One step of a setup op in a batch. ctx: runOp's { step, keep, vault, written, hashes }; deps: { vindex, trash(abs) }.
// Each change goes through keep first, so the batch's versions and Undo hold the text from before. A note the item
// read at the scan (hashes) and that changed since stops the step, unless an earlier step of the batch wrote it
export async function runSetupOp(item, o, { step, keep, vault, written = new Set(), hashes = item?.hashes ?? null }, { vindex, trash }) {
  const read = (rel) => readFileSync(vaultPath(vault, rel), 'utf8');
  const need = (rel) => { if (!vaultPath(vault, rel)) throw new Error(`“${rel}” is no longer in the vault`); };
  const fresh = (rel) => {
    if (!hashes || !(rel in hashes) || written.has(rel)) return;
    const abs = vaultPath(vault, rel);
    const now = abs ? sha(readFileSync(abs, 'utf8')) : null;
    if (now !== hashes[rel]) throw new Error(`“${rel}” changed after Quorum checked it, so Quorum did not write. Review it again`);
  };
  if (o.op === 'create') {
    const abs = vaultTarget(vault, o.rel);
    if (!abs) throw new Error(`“${o.rel}” is outside the vault`);
    if (existsSync(abs)) throw new Error(`A note is already at “${o.rel}”, so Quorum did not write it`);
    await step(`Writing ${o.rel}`);
    mkdirSync(path.dirname(abs), { recursive: true });
    keep(o.rel, true);
    writeAtomic(abs, o.text ?? `# ${base(o.rel)}\n`);
  } else if (o.op === 'mention') {
    need(o.rel);
    fresh(o.rel);
    const cur = read(o.rel);
    const next = linkMention(cur, o.name, o.target ?? base(o.to));
    if (next === cur) { await step(`${o.rel} links ${o.name} already`); return; }
    await step(`Linking ${o.name} in ${o.rel} to ${o.to}`);
    keep(o.rel);
    writeAtomic(vaultPath(vault, o.rel), next);
  } else if (o.op === 'alias') {
    need(o.rel);
    fresh(o.rel);
    await step(`Adding ${o.alias} as an alias of ${o.rel}`);
    keep(o.rel);
    writeAtomic(vaultPath(vault, o.rel), aliasText(read(o.rel), o.alias));
  } else if (o.op === 'merge') {
    need(o.rel); need(o.drop);
    fresh(o.rel); fresh(o.drop);
    const hidden = unindexedLinkers(vault, o.drop, new Set(vindex.rels()));
    if (hidden.length) throw new Error(`${hidden.length === 1 ? 'A note' : `${hidden.length} notes`} Quorum does not read ${hidden.length === 1 ? 'links' : 'link'} to “${o.drop}”, so Quorum did not merge it. Their links would open nothing`);
    await step(`Merging ${o.drop} into ${o.rel}`);
    const drop = read(o.drop);
    const dn = parseNote(o.drop, drop);
    const sources = [...new Set(vindex.backlinks(o.drop).map((b) => b.rel))].filter((r) => r !== o.rel && r !== o.drop);
    for (const r of sources) fresh(r);
    for (const r of sources) keep(r);
    if (sources.length) {
      await step(`Pointing the links in ${sources.length} ${sources.length === 1 ? 'note' : 'notes'} at ${o.rel}`);
      rewriteLinks({ vault, mapping: new Map([[o.drop, o.rel]]), sources, resolve: (t, f) => vindex.resolve(t, f), allRels: vindex.rels(), aliasesOf: () => [] });
    }
    keep(o.rel);
    writeAtomic(vaultPath(vault, o.rel), mergeText(read(o.rel), drop, { title: dn.title, names: [o.alias, dn.title, base(o.drop), ...dn.aliases] }));
    await step(`Moving ${o.drop} to the Trash`);
    keep(o.drop, false, true);
    await trash(vaultPath(vault, o.drop));
  } else if (o.op === 'split') {
    need(o.rel);
    fresh(o.rel);
    const targets = o.parts.map((p) => p.to.toLowerCase());
    if (new Set(targets).size !== targets.length) throw new Error(`Two sections of ${o.rel} would go to the same note, so Quorum did not split it. Review it again`);
    const { text, notes } = splitText(read(o.rel), o.parts, { from: o.rel });
    for (const n of notes) if (existsSync(path.join(vault, n.rel))) throw new Error(`A note is already at “${n.rel}”, so Quorum did not split ${o.rel}`);
    await step(`Moving ${notes.length} ${notes.length === 1 ? 'section' : 'sections'} of ${o.rel} into notes beside it`);
    for (const n of notes) {
      const abs = vaultTarget(vault, n.rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      keep(n.rel, true);
      writeAtomic(abs, n.text);
    }
    keep(o.rel);
    writeAtomic(vaultPath(vault, o.rel), text);
  } else throw new Error(`Quorum cannot run a ${o.op} step here`);
  vindex.sync();
}

// A grouped item (rules/entityType.js, fix.pick) approved with some of its notes unticked: the item with only the ops,
// notes and hashes of the notes the person kept. rels: the ticked notes, or null for all of them
export function pickItem(item, rels) {
  if (!rels) return item;
  const keep = new Set(rels.map(String));
  const ops = (item.ops ?? []).filter((o) => keep.has(o.rel));
  if (!ops.length) throw new Error('Tick at least one note to approve');
  const hashes = item.hashes ? Object.fromEntries(Object.entries(item.hashes).filter(([r]) => keep.has(r))) : item.hashes;
  return { ...item, ops, notes: (item.notes ?? []).filter((r) => keep.has(r)), ...(hashes ? { hashes } : {}) };
}

// the graph node a note stands for: the person, project, meeting or decision node it backs, else its note node. A note
// the graph has not read yet gets the id the graph's extraction gives it (graph/extract.js entityId)
export function nodeIdOf(store, rel, props = {}) {
  const backed = (store?.nodesByRel?.(rel) ?? []).find((x) => x.kind !== 'note');
  if (backed) return backed.id;
  const k = noteKind(rel, props).kind;
  if (k !== 'note') return entityId(k, rel);
  // a note in a people or projects folder the person just linked as one: the edge is what makes it that entity
  const f = folderKind(rel);
  return ENTITY_FOLDERS.has(f) ? entityId(f, rel) : `note:${rel}`;
}

// The edges a batch's approved connections record, with person provenance: a mention links a note to the entity's
// node, an attended mention links the person to the meeting. at: when the person approved; idOf(rel): nodeIdOf
export function approvedEdges(items, { at = Date.now(), idOf = (rel, props) => nodeIdOf(null, rel, props) } = {}) {
  const out = [];
  for (const it of items ?? []) {
    if (it.kind !== 'finding') continue;
    for (const o of it.ops ?? []) {
      if (o.op !== 'mention') continue;
      const attended = o.edge === 'attended';
      out.push(attended
        ? { src: idOf(o.to, o.entity ? { type: o.entity } : {}), dst: idOf(o.rel), kind: 'attended', provenance: 'person', source_rel: o.rel, source_line: null, confidence: 1, valid_from: at, props: { by: 'review' } }
        : { src: `note:${o.rel}`, dst: idOf(o.to, o.entity ? { type: o.entity } : {}), kind: 'mentions', provenance: 'person', source_rel: o.rel, source_line: null, confidence: 1, valid_from: at, props: { by: 'review' } });
    }
  }
  return out;
}

const current = (e) => e.valid_to == null && e.superseded_by == null;
const between = (store, a, b, kind) => (store.edgesOf(`note:${a}`, { dir: 'both', kinds: [kind], current: true }) ?? []).filter((e) => current(e) && ((e.src === `note:${a}` && e.dst === `note:${b}`) || (e.src === `note:${b}` && e.dst === `note:${a}`)));
const bySource = (store, rel) => (store.edgesBySource?.(rel) ?? store.edgesOf(`note:${rel}`, { dir: 'both', current: true }) ?? []).filter((e) => e.source_rel === rel && current(e));
const olderLine = (f) => { const m = (f.evidence ?? []).find((l) => l.startsWith('Older: '))?.match(/ line (\d+)/); return m ? Number(m[1]) : null; };

// The contradiction findings of a sweep as contradicts edges, newer note to older: a pair with no current edge gets
// one, and a current rule edge whose pair no longer disagrees ends. Answers { added, ended }
export function recordContradictions(store, findings, { at = Date.now() } = {}) {
  if (!store) return { added: 0, ended: 0 };
  const open = (findings ?? []).filter((f) => f.ruleId === 'note.contradiction' && f.notes?.length === 2);
  const want = new Set(open.map((f) => `note:${f.notes[1]}\nnote:${f.notes[0]}`));
  let added = 0;
  let ended = 0;
  store.tx(() => {
    for (const f of open) {
      const [older, newer] = f.notes;
      if (between(store, newer, older, 'contradicts').length) continue;
      const line = olderLine(f);
      store.addEdge({ src: `note:${newer}`, dst: `note:${older}`, kind: 'contradicts', provenance: 'rule', source_rel: older, source_line: line == null ? null : line - 1, confidence: 0.7, valid_from: at, recorded_at: at, props: { by: 'contradictions' } });
      added++;
    }
    for (const rel of new Set(open.flatMap((f) => f.notes))) {
      for (const e of store.edgesOf(`note:${rel}`, { dir: 'both', kinds: ['contradicts'], current: true }) ?? []) {
        if (e.provenance !== 'rule' || !current(e) || want.has(`${e.src}\n${e.dst}`)) continue;
        store.supersede(e.id, null, at);
        ended++;
      }
    }
  });
  return { added, ended };
}

// A contradiction a person resolved (its annotate fix ran): a supersedes edge from the newer note to the older one, the
// contradicts edge between them ends with it, and so does every current edge read from the older note's line
export function resolveContradiction(store, item, { at = Date.now() } = {}) {
  if (!store || item?.ruleId !== 'note.contradiction') return null;
  const o = item.ops?.find((x) => x.op === 'annotate');
  const [older, newer] = item.notes ?? [];
  if (!o || !older || !newer) return null;
  let id = null;
  store.tx(() => {
    id = store.addEdge({ src: `note:${newer}`, dst: `note:${older}`, kind: 'supersedes', provenance: 'person', source_rel: newer, source_line: null, confidence: 1, valid_from: at, recorded_at: at, props: { by: 'review' } });
    for (const e of between(store, newer, older, 'contradicts')) store.supersede(e.id, id, at);
    for (const e of bySource(store, older)) if (e.source_line === o.line - 1 && e.id !== id) store.supersede(e.id, id, at);
  });
  return id;
}

// the edges an approved batch recorded, removed when the batch is undone; removing one puts back what it superseded
export function endEdges(store, ids, { at = Date.now() } = {}) {
  if (!store || !ids?.length) return 0;
  store.tx(() => { for (const id of ids) { if (store.removeEdge) store.removeEdge(id); else store.supersede(id, null, at); } });
  return ids.length;
}

// the dated facts the graph holds now, and how many of them hold a date in the last days: edges that state a relation
// (attended, works_on, decided_in and the like) with a valid_from. A fact from an undated note says nothing about
// when it was last true, so it counts in neither. Through the store's connection
const FACT_KINDS = ['mentions', 'attended', 'works_on', 'member_of', 'decided_in', 'decision_about'];
export function graphFreshness(store, since) {
  const db = store?.db?.();
  if (!db) return null;
  const marks = FACT_KINDS.map(() => '?').join(', ');
  const r = db.prepare(`select count(*) as total, sum(case when valid_from >= ? then 1 else 0 end) as confirmed from edges where kind in (${marks}) and valid_from is not null and valid_to is null and superseded_by is null`).get(since, ...FACT_KINDS);
  return { total: Number(r?.total ?? 0), confirmed: Number(r?.confirmed ?? 0) };
}

// Instruction files at the Agent OS root, outside the vault folder: measured for the report, with their links to notes
// that are not in the vault. Quorum's fixes write inside the vault only, so these are listed for the person
export function outsideInstructions({ root, vault, resolve = () => null }) {
  if (!root || !vault || path.resolve(root) === path.resolve(vault)) return [];
  const out = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    let text;
    try { text = readFileSync(path.join(root, name), 'utf8'); } catch { continue; }
    if (!INSTRUCTION_NAME.test(noExt(name))) continue;
    const dead = [...new Set(parseNote(name, text).links.filter((l) => !l.embed && l.kind === 'wiki' && !resolve(l.target, '')).map((l) => noExt(l.target)))];
    out.push({ file: name, chars: text.length, budget: BUDGET, over: text.length > BUDGET, dead });
  }
  return out;
}

// Freshness: the share of current dated facts confirmed in the last FRESH_DAYS days (graph edges valid since then;
// without the graph or with no dated facts, notes updated or verified since then), open contradictions, and stale
// summaries
export function freshness({ notes = [], findings = [], graph = null, now = Date.now() }) {
  const since = now - FRESH_DAYS * DAY;
  let confirmed = null;
  let basis = 'notes';
  const fresh = graph?.freshness?.(since);
  if (fresh && fresh.total) { confirmed = fresh.confirmed / fresh.total; basis = 'facts'; } else if (notes.length) {
    const verified = (n) => { const v = String(n.note?.props?.last_verified ?? n.note?.props?.updated ?? ''); const t = Date.parse(v.slice(0, 10)); return Number.isFinite(t) ? t : 0; };
    confirmed = notes.filter((n) => Math.max(n.mtime ?? 0, verified(n)) >= since).length / notes.length;
  }
  const open = (id, pre = '') => findings.filter((f) => f.ruleId === id && !f.archived && f.key.startsWith(`${id}:${pre}`)).length;
  return { days: FRESH_DAYS, confirmed: confirmed == null ? null : Math.round(confirmed * 1000) / 1000, basis, contradictions: open('note.contradiction'), staleSummaries: open('note.summary-stale', 'stale:') };
}

// what the graph holds by kind, or the notes' kinds when it is not built
function entityCounts(notes, stats) {
  const by = stats?.byKind?.nodes ?? null;
  if (by && typeof by === 'object') return { people: by.person ?? 0, projects: by.project ?? 0, meetings: by.meeting ?? 0, decisions: by.decision ?? 0, source: 'graph' };
  const c = { person: 0, project: 0, meeting: 0, decision: 0 };
  const kindOf = entityKinds({ notes });
  for (const n of notes) { const k = kindOf(n); if (k) c[k]++; }
  return { people: c.person, projects: c.project, meetings: c.meeting, decisions: c.decision, source: 'notes' };
}

// The setup report. notes: the vault index's snapshot; missing: the count of links that open nothing; findings: Memory
// health's findings now; links: the broken link issues; graph: { stats, freshness } or null; search: { chunks,
// embedded } or null; outside: outsideInstructions()
export function setupReport({ notes = [], missing = 0, findings = [], links = [], graph = null, search = null, keeper = null, outside = [], made = null, now = Date.now() }) {
  const resolved = notes.reduce((s, n) => s + (n.outbound ?? 0), 0);
  const open = findings.filter((f) => !f.archived);
  const gap = (id, label) => {
    const fs = open.filter((f) => f.ruleId === id);
    return { id, label, count: fs.length, fixable: fs.filter((f) => f.fix || f.approve?.ops?.some((o) => o.op !== 'keep')).length, sample: fs.slice(0, 3).map((f) => f.title) };
  };
  const gaps = [
    ...SETUP_RULES.map((id) => gap(id, RULE_LABELS[id])),
    gap('note.duplicate', RULE_LABELS['note.duplicate']),
    gap('note.oversized', RULE_LABELS['note.oversized']),
    gap('note.orphan', RULE_LABELS['note.orphan']),
    { id: 'link.missing', label: 'Links that open nothing', count: links.length, fixable: links.filter((l) => l.action && l.action !== 'leave').length, sample: links.slice(0, 3).map((l) => l.target) },
  ];
  return {
    at: now,
    counts: {
      notes: notes.length,
      links: { resolved, total: resolved + missing },
      entities: entityCounts(notes, graph?.stats ?? null),
      embeddings: search ? { built: search.embedded ?? 0, total: search.chunks ?? 0 } : null,
      graph: graph?.stats ? { nodes: graph.stats.nodes ?? null, edges: graph.stats.edges ?? null } : null,
    },
    gaps,
    fixes: gaps.reduce((s, g) => s + g.fixable, 0),
    freshness: freshness({ notes, findings: open, graph, now }),
    outside,
    keeper: keeper ? { on: !!keeper.on, made: made === 'quorum' } : null,
    model: { available: false },
  };
}

// The scan's run and its state, one vault at a time. steps: { index, graph, checks, report } (main.js): index and
// graph wait for their builds and report progress, checks runs the review rules, report builds the report. Each step
// gets { vault } and throws when it cannot finish (a build that timed out, a vault that changed), so a partial scan
// saves no report. The last report per vault is kept in file, so Settings shows it after a restart, and so is the
// person's keeper choice from setup: 'on', 'off', or null while they have not chosen
export const PHASES = [
  { id: 'index', label: 'Reading the notes' },
  { id: 'graph', label: 'Building the memory graph' },
  { id: 'checks', label: 'Checking every note' },
  { id: 'report', label: 'Writing the report' },
];
export function createMemorySetup({ file, steps, emit = () => {}, log = () => {}, now = () => Date.now() }) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { saved = {}; }
  let state = null;
  const save = () => { try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(saved)); } catch (e) { log('memory setup', e?.message); } };
  const choice = (vault) => (saved[vault]?.keeper === 'on' || saved[vault]?.keeper === 'off' ? saved[vault].keeper : null);
  const view = (vault) => {
    const last = saved[vault] ?? null;
    if (state && state.vault === vault) return { running: state.running, phase: state.phase, progress: state.progress, phases: PHASES, error: state.error, report: state.report ?? last?.report ?? null, done: !state.running && !!(state.report ?? last?.report), keeperChoice: choice(vault) };
    return { running: false, phase: null, progress: null, phases: PHASES, error: null, report: last?.report ?? null, done: !!last?.report, keeperChoice: choice(vault) };
  };
  const put = (patch) => { Object.assign(state, patch); emit(view(state.vault)); };
  async function run(vault, opts = {}) {
    if (state?.running) return view(state.vault);
    state = { vault, running: true, phase: PHASES[0].id, progress: { done: 0, total: PHASES.length, label: PHASES[0].label }, error: null, report: null };
    emit(view(vault));
    try {
      for (const [i, p] of PHASES.entries()) {
        put({ phase: p.id, progress: { done: i, total: PHASES.length, label: p.label } });
        const sub = (done, total, label = p.label) => put({ progress: { done: i + (total ? Math.min(1, done / total) : 0), total: PHASES.length, label } });
        const out = await steps[p.id](sub, { ...opts, vault });
        if (p.id === 'report') state.report = out;
      }
      saved[vault] = { ...(saved[vault] ?? {}), report: state.report };
      save();
      put({ running: false, phase: 'done', progress: { done: PHASES.length, total: PHASES.length, label: 'Done' } });
    } catch (e) {
      log('memory setup', e?.message);
      put({ running: false, error: String(e?.message ?? e) });
    }
    return view(vault);
  }
  // the person's keeper choice from setup. offer: true records it only when they have not chosen yet, so finishing
  // setup never overrides a choice made on the card. Answers whether it was recorded
  function chooseKeeper(vault, on, { offer = false } = {}) {
    if (!vault || (offer && choice(vault))) return false;
    saved[vault] = { ...(saved[vault] ?? {}), keeper: on ? 'on' : 'off' };
    save();
    return true;
  }
  return { run, status: (vault) => view(vault), keeperChoice: choice, chooseKeeper, at: now };
}
