// Summaries that went stale: a note whose type is summary, or that names what it summarizes in summary_of, sources or
// summarizes, records the hash of each source in source_hashes. With no hashes recorded, Quorum cannot tell when a
// source changes, and Approve records them. Once a recorded source changes or goes, the summary may no longer hold:
// Approve sets status: stale, or records the new hashes when the summary was edited after the source changed.
import { finding, noteHash, plural, quote } from './common.js';
import { live } from './entities.js';

export const rule = { id: 'note.summary-stale', version: 1, label: 'Summaries whose sources changed' };
const SOURCE_KEYS = ['summary_of', 'summarizes', 'sources'];
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const isSummary = (n) => String(list(n.note?.props?.type)[0] ?? '').toLowerCase() === 'summary' || SOURCE_KEYS.slice(0, 2).some((k) => list(n.note?.props?.[k]).length);
// the source names a summary lists, from wikilinks or plain names
const sourceNames = (n) => SOURCE_KEYS.flatMap((k) => list(n.note?.props?.[k])).map((v) => String(v).match(/\[\[([^\]|#]+)/)?.[1] ?? String(v)).map((s) => s.trim()).filter(Boolean);
// source_hashes as Quorum writes it: ["rel@hash", ...]
export const readHashes = (v) => new Map(list(v).map((x) => String(x)).filter((x) => x.includes('@')).map((x) => [x.slice(0, x.lastIndexOf('@')), x.slice(x.lastIndexOf('@') + 1)]));
export const writeHashes = (entries) => `[${entries.map(([rel, h]) => JSON.stringify(`${rel}@${h}`)).join(', ')}]`;

export function run({ notes, resolve }) {
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  const out = [];
  for (const n of live(notes)) {
    if (!isSummary(n)) continue;
    const sources = [...new Set(sourceNames(n).map((s) => resolve(s, n.rel)).filter((r) => r && r !== n.rel))].sort();
    if (!sources.length) continue;
    const now = sources.map((r) => [r, noteHash(byRel.get(r)?.text ?? '', byRel.get(r)?.chars)]);
    const recorded = readHashes(n.note?.props?.source_hashes);
    const title = n.note?.title ?? n.rel;
    if (!recorded.size) {
      out.push(finding(rule, {
        key: `record:${n.rel}`, target: n.rel, notes: [n.rel, ...sources],
        title: `${quote(title)} does not record its sources`,
        problem: 'It summarizes other notes, and nothing records how they read when it was written, so Quorum cannot tell when it goes out of date.',
        proposal: `Record the hash of ${plural(sources.length, 'source')} in source_hashes. Quorum then flags it when one changes.`,
        evidence: sources.slice(0, 5).map((r) => `Source: ${r}`),
        meta: [['Summary', n.rel]],
        fix: { kind: 'ops', group: 'setkey', ops: [{ op: 'setkey', rel: n.rel, key: 'source_hashes', value: writeHashes(now) }] },
      }));
      continue;
    }
    const changed = [...recorded].filter(([rel, h]) => (byRel.has(rel) ? now.find(([r]) => r === rel)?.[1] !== h : true)).map(([rel]) => rel);
    if (!changed.length) continue;
    const marked = String(n.note?.props?.status ?? '').toLowerCase() === 'stale';
    // edited after every source that changed: the person brought it up to date, so the hashes are the ones to record
    const refreshed = changed.every((rel) => byRel.has(rel) && (n.mtime ?? 0) > (byRel.get(rel).mtime ?? 0));
    if (marked && !refreshed) continue;
    const ops = refreshed
      ? [{ op: 'setkey', rel: n.rel, key: 'source_hashes', value: writeHashes(now) }, ...(marked ? [{ op: 'setkey', rel: n.rel, key: 'status', value: 'current' }] : [])]
      : [{ op: 'setkey', rel: n.rel, key: 'status', value: 'stale' }];
    out.push(finding(rule, {
      key: `stale:${n.rel}`, target: n.rel, notes: [n.rel, ...changed.filter((r) => byRel.has(r))],
      title: refreshed ? `${quote(title)} was updated after its sources changed` : `${quote(title)} may be out of date`,
      problem: refreshed ? 'Its sources changed and the summary was edited since, so the hashes it records are old.' : `${plural(changed.length, 'source')} changed or went since it was written, so it may no longer hold. The agent reads it as current.`,
      proposal: refreshed ? 'Record the sources as they read now.' : 'Set status: stale, so agents read it as out of date until it is rewritten.',
      evidence: changed.map((r) => (byRel.has(r) ? `Changed: ${r}` : `Gone: ${r}`)),
      facts: changed.map((r) => `changed:${r}`),
      meta: [['Summary', n.rel]],
      fix: { kind: 'ops', group: 'setkey', ops },
    }));
  }
  return out;
}
