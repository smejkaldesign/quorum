// Topic summaries: for the biggest communities the memory graph found (graph/communities.js), a summary written from the
// notes in it, each line citing its note. Approve writes it as a Quorum-owned note in the Quorum folder, marked
// quorum: generated, and nowhere else in the vault. When a large share of its sources changed, or notes joined or left
// the community, a second item offers the summary written again. With the person's model turned on for topics, the
// summary is the model's draft (graph/topics.js) when it was written from the sources as they read now; with no model it
// lists the community's main notes, people, decisions and notes with their first lines.
import { finding, noteHash, plural, quote } from './common.js';
import { confidentialSet } from './entities.js';
import { readHashes, writeHashes } from './summaries.js';

export const rule = { id: 'note.topic-summary', version: 1, label: 'Topic summaries' };
// communities change as a whole when the graph is read again, so a sweep over some notes runs this over the vault
export const wide = () => true;
// a community needs this many notes for a summary, and at most this many new summaries are offered at once
export const MIN_NOTES = 5;
export const MAX_NEW = 5;
// the share of sources that changed, joined or left before a refresh is offered
export const REFRESH_SHARE = 0.3;
// a summary whose community id is gone belongs to the community holding at least this share of its sources
const SAME_TOPIC = 0.5;
const MAX_SOURCES = 40;
const LINE_CHARS = 160;

export const topicsFolder = (learned) => `${learned && learned.includes('/') ? learned.slice(0, learned.lastIndexOf('/')) : 'Quorum'}/Topics`;
// a file name from a community name: letters, digits, spaces and a few marks, never a path
export const topicFile = (name) => String(name ?? '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Topic';
const isGenerated = (n) => String(n.note?.props?.quorum ?? '').toLowerCase() === 'generated';
const link = (rel, title) => { const p = rel.replace(/\.md$/i, ''); const t = title && title !== p.split('/').pop() ? `|${title}` : ''; return `[[${p}${t}]]`; };
const day = (t) => { const d = new Date(typeof t === 'number' && t < 1e11 ? t * 1000 : t); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

// the first sentence of a note's body: no frontmatter, headings, link lines or list markers
export function firstLine(text) {
  const body = String(text ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  for (const raw of body.split('\n')) {
    const l = raw.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim();
    if (!l || l.startsWith('#') || l.startsWith('>') || l.startsWith('|') || /^\[\[[^\]]+\]\]$/.test(l) || /^!\[/.test(l)) continue;
    const s = (l.match(/^.*?[.!?](\s|$)/)?.[0] ?? l).trim();
    return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s;
  }
  return '';
}

// the summary note: frontmatter that marks it Quorum's and records its sources, then the body
export function summaryText({ community, name, sources, body, by, today }) {
  const fm = [
    '---',
    'type: summary',
    'quorum: generated',
    `community: ${JSON.stringify(community)}`,
    `generated_by: ${by}`,
    `updated: ${today}`,
    `summary_of: [${sources.map((s) => JSON.stringify(link(s.rel))).join(', ')}]`,
    `source_hashes: ${writeHashes(sources.map((s) => [s.rel, s.hash]))}`,
    '---',
  ];
  const lede = `Quorum wrote this summary of ${plural(sources.length, 'note')} the memory graph groups together. It changes only through Needs review: edit the notes it cites, and Quorum offers a new version when they change.`;
  return `${fm.join('\n')}\n# ${name}\n\n${lede}\n\n${body.trim()}\n`;
}

// the summary with no model: the strongest notes, the people, the decisions and every source with its first line
export function plainBody({ members, byRel }) {
  const kinds = (k) => members.filter((m) => m.node?.kind === k);
  const out = [];
  const main = members.filter((m) => m.rel && !['person', 'decision'].includes(m.node?.kind)).slice(0, 5);
  if (main.length) out.push('## Main notes', '', ...main.map((m) => `- ${link(m.rel, m.node?.name)}`), '');
  const people = kinds('person');
  if (people.length) out.push('## People', '', ...people.slice(0, 12).map((m) => `- ${m.rel ? link(m.rel, m.node.name) : m.node.name}`), '');
  const decisions = kinds('decision').map((m) => ({ m, date: m.node.props?.date ?? null })).sort((a, b) => (b.date ?? 0) - (a.date ?? 0)).slice(0, 10);
  if (decisions.length) out.push('## Decisions', '', ...decisions.map(({ m, date }) => `- ${date ? `${day(date)}: ` : ''}${String(m.node.props?.text ?? m.node.name).replace(/\s+/g, ' ').trim()}${m.rel ? ` (${link(m.rel)})` : ''}`), '');
  const notes = members.filter((m) => m.rel && byRel.has(m.rel) && m.node?.kind !== 'decision');
  const seen = new Set();
  const lines = [];
  for (const m of notes) {
    if (seen.has(m.rel)) continue;
    seen.add(m.rel);
    const n = byRel.get(m.rel);
    const first = firstLine(n.text);
    lines.push(`- ${link(m.rel, n.note?.title)}${first ? `: ${first}` : ''}`);
  }
  if (lines.length) out.push('## Notes', '', ...lines);
  return out.join('\n');
}

export function run({ notes, graph, learned = null, now = Date.now(), ...ctx }) {
  if (!graph?.communities) return [];
  // a confidential note is never a source: its words, title and decisions stay out of the summary, which is a plain note
  const secret = confidentialSet(ctx);
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  const folder = topicsFolder(learned);
  // only Quorum's own summaries in the Topics folder are matched and written again; a generated note elsewhere is the
  // person's to keep
  const generated = new Map();
  for (const n of notes) if (isGenerated(n) && n.rel.startsWith(`${folder}/`) && n.note?.props?.community) generated.set(String(n.note.props.community), n);
  const matched = new Set();
  const live = new Set();
  const communities = graph.communities();
  for (const c of communities) live.add(c.id);
  // the summary of a community whose id is gone, by the share of its recorded sources it still holds
  const orphanFor = (rels) => {
    let best = null;
    let bestJ = SAME_TOPIC;
    for (const [id, n] of generated) {
      if (live.has(id) || matched.has(n.rel)) continue;
      const rec = new Set(readHashes(n.note?.props?.source_hashes).keys());
      const both = rels.filter((r) => rec.has(r)).length;
      const j = both / (rels.length + rec.size - both || 1);
      if (j >= bestJ) { best = n; bestJ = j; }
    }
    return best;
  };
  const today = day(now);
  const out = [];
  let offered = 0;
  for (const c of communities) {
    if (c.size < 3) continue;
    const members = c.members.map((m) => { const node = graph.node(m.node); return { id: m.node, rank: m.rank, node, rel: node?.rel ?? null }; });
    const sources = [];
    const seen = new Set();
    for (const m of members) {
      if (!m.rel || seen.has(m.rel) || !byRel.has(m.rel) || isGenerated(byRel.get(m.rel)) || secret(byRel.get(m.rel))) continue;
      seen.add(m.rel);
      const n = byRel.get(m.rel);
      sources.push({ rel: m.rel, hash: noteHash(n.text, n.chars) });
      if (sources.length >= MAX_SOURCES) break;
    }
    if (sources.length < MIN_NOTES) continue;
    const name = c.name || c.id;
    const existing = generated.get(c.id) ?? orphanFor(sources.map((x) => x.rel));
    if (existing) matched.add(existing.rel);
    const draft = c.props?.draft && c.props.draft.sig === c.props.sourceSig && c.props.draft.text ? c.props.draft.text : null;
    // members with a note show only when that note is a source; people and decisions from a confidential note stay out
    const body = draft ?? plainBody({ members: members.filter((m) => (m.rel ? seen.has(m.rel) : true)), byRel });
    const evidence = sources.slice(0, 5).map((s) => `Source: ${s.rel}`);
    if (!existing) {
      if (offered >= MAX_NEW) continue;
      offered++;
      const rel = `${folder}/${topicFile(name)}.md`;
      if (byRel.has(rel)) continue;
      out.push(finding(rule, {
        key: `new:${c.id}`, target: rel, notes: [sources[0].rel, ...sources.slice(1).map((s) => s.rel)],
        title: `Write a summary of ${quote(name)}`,
        problem: `${plural(sources.length, 'note')} form one topic in the memory graph, and no note sums them up. An agent reads them one at a time.`,
        proposal: `Write ${quote(rel)}, a summary that cites each note, marked as Quorum's. Quorum offers a new version when the notes change.`,
        evidence,
        meta: [['Topic', name], ['Written by', draft ? 'your model' : 'Quorum, from the notes']],
        fix: { kind: 'ops', group: 'summary', ops: [{ op: 'summary', rel, folder, community: c.id, text: summaryText({ community: c.id, name, sources, body, by: draft ? 'model' : 'rule', today }) }] },
      }));
      continue;
    }
    // a refresh: the sources that changed, joined or left, against the larger of the two lists
    const recorded = readHashes(existing.note?.props?.source_hashes);
    const nowMap = new Map(sources.map((s) => [s.rel, s.hash]));
    const changed = [...nowMap].filter(([rel, h]) => recorded.get(rel) !== h).map(([rel]) => rel);
    const left = [...recorded.keys()].filter((rel) => !nowMap.has(rel));
    const moved = changed.length + left.length;
    // a summary found by its sources (its community has a new id) is written again with the new id when it is behind
    if (moved < 2 || moved / Math.max(recorded.size, nowMap.size) < REFRESH_SHARE) continue;
    out.push(finding(rule, {
      key: `refresh:${c.id}`, target: existing.rel, notes: [existing.rel, ...changed],
      title: `${quote(existing.note?.title ?? name)} is behind its notes`,
      problem: `${plural(moved, 'source')} of this summary changed, joined or left the topic since Quorum wrote it, so it may no longer hold.`,
      proposal: 'Write it again from the notes as they read now. Only Quorum\'s summary changes.',
      evidence: [...changed.slice(0, 5).map((r) => (recorded.has(r) ? `Changed: ${r}` : `New: ${r}`)), ...left.slice(0, 3).map((r) => `Left: ${r}`)],
      facts: changed.map((r) => `changed:${r}`),
      meta: [['Summary', existing.rel], ['Written by', draft ? 'your model' : 'Quorum, from the notes']],
      fix: { kind: 'ops', group: 'summary', ops: [{ op: 'summary', rel: existing.rel, folder, community: c.id, replace: true, text: summaryText({ community: c.id, name: existing.note?.title ?? name, sources, body, by: draft ? 'model' : 'rule', today }) }] },
    }));
  }
  return out;
}
