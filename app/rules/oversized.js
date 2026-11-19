// Oversized notes: a note far longer than the rest of the vault is hard for an agent to read in one go and usually
// holds several topics. The limit comes from the vault itself: its 99th percentile note length, and never below 60,000
// characters (about 10,000 words), so a vault of short notes does not flag ordinary ones. Dated logs (daily notes,
// session logs) and index notes grow by design and are left out. A note with two or more second-level headings is offered
// a split on Approve: each section goes into a note beside it, and the note keeps a link line under each heading.
import { DATED, ENTRY_NAME, baseOf, dirOf, finding, percentile, plural, quote, skipped } from './common.js';
import { isInstruction, sections } from './instructions.js';
import { normName } from './entities.js';

export const rule = { id: 'note.oversized', version: 1, label: 'Notes too long to read in one go' };
export const FLOOR = 60000;

export function run({ notes }) {
  const rels = new Set(notes.map((n) => n.rel));
  // instruction files are the instruction rule's: a section split out of one stops loading into agent sessions
  const live = notes.filter((n) => !skipped(n) && !DATED.test(baseOf(n.rel)) && !ENTRY_NAME.test(baseOf(n.rel)) && !isInstruction(n.rel));
  // chars: the note's full length when the rules read only its head (memoryEngine.js MAX_RULE_TEXT)
  const sizeOf = (n) => n.chars ?? n.text.length;
  const limit = Math.max(FLOOR, percentile(live.map(sizeOf), 0.99));
  const out = [];
  for (const n of live) {
    const size = sizeOf(n);
    if (size <= limit) continue;
    const parts = (n.note?.headings ?? []).filter((h) => h.level === 2).length;
    // the words of the head, scaled to the whole note when only the head was read
    const words = Math.round(n.text.split(/\s+/).filter(Boolean).length * (n.text.length ? size / n.text.length : 1));
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} is ${Math.round(size / 1000)}k characters long`,
      problem: 'A note this long takes a large part of the agent’s context, and a search hit inside it brings the whole note along.',
      proposal: parts > 1 && size === n.text.length ? `Split it into ${parts} notes at its ${parts} second-level headings. It keeps a link line under each heading.` : parts > 1 ? `Split it into ${parts} notes at its ${parts} second-level headings, and link them from a short index note.` : 'Split it into a few notes by topic, and link them from a short index note.',
      evidence: [`${size.toLocaleString('en-US')} characters, about ${words.toLocaleString('en-US')} words`, `The vault limit is ${limit.toLocaleString('en-US')} characters`, `${plural(parts, 'second-level heading')}`],
      facts: [`size:${Math.round(size / 10000)}`],
      meta: [['Note', n.rel]],
      ...(parts > 1 && size === n.text.length ? { fix: { kind: 'ops', group: 'split', ops: [{ op: 'split', rel: n.rel, parts: splitParts(n, rels) }] } } : {}),
    }));
  }
  return out;
}

// a note per second-level section, beside the note: big.md's Roadmap section goes to big-roadmap.md
function splitParts(n, rels) {
  const dir = dirOf(n.rel);
  return sections(n.text).map((s) => {
    let to = `${dir ? `${dir}/` : ''}${baseOf(n.rel)}-${normName(s.heading).replace(/ /g, '-').slice(0, 50) || 'section'}.md`;
    for (let i = 2; rels.has(to); i++) to = to.replace(/(-\d+)?\.md$/, `-${i}.md`);
    rels.add(to);
    return { heading: s.heading, start: s.start, end: s.end, to };
  });
}
