// Instruction files: CLAUDE.md, AGENTS.md, GEMINI.md and the like load into every agent session, so each line costs
// context on every call. Three checks, each a Review item with its edit:
//   size      longer than the budget: Approve moves its largest second-level sections into notes beside it and leaves a
//             link line under each heading, until it fits
//   links     links to notes that are not in the vault: Approve removes each link and keeps its words
//   graph     a line whose fact the memory graph holds as superseded or contradicted: Approve marks the line out of date
// Files outside the vault folder are measured by the Memory setup scan (memorySetup.js), which lists them in its report.
import { baseOf, dirOf, finding, plural, quote } from './common.js';
import { normName } from './entities.js';

export const rule = { id: 'note.instructions', version: 1, label: 'Instruction files that cost too much context' };
export const INSTRUCTION_NAME = /^(claude|agents|gemini|codex|copilot-instructions|cursor-rules|instructions)$/i;
// about 3,000 tokens
export const BUDGET = 12000;
export const isInstruction = (rel) => INSTRUCTION_NAME.test(baseOf(rel));

// the second-level sections of a text: [{ heading, start, end, chars }], lines 0-based, end exclusive
export function sections(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence || !/^##\s+\S/.test(l)) return;
    if (out.length) out[out.length - 1].end = i;
    out.push({ heading: l.replace(/^##\s+/, '').trim(), start: i, end: lines.length });
  });
  for (const s of out) s.chars = lines.slice(s.start, s.end).join('\n').length;
  return out;
}
// the sections to move out, largest first, until the text fits the budget; [] when it cannot fit that way
export function splitPlan(text, budget = BUDGET) {
  const secs = sections(text).sort((a, b) => b.chars - a.chars);
  let size = String(text ?? '').length;
  const pick = [];
  for (const s of secs) {
    if (size <= budget) break;
    pick.push(s);
    size -= s.chars - (s.heading.length + 40);
  }
  return size <= budget ? pick : pick.length ? pick : [];
}
const slug = (s) => normName(s).replace(/ /g, '-').slice(0, 50) || 'section';

export function run({ notes, resolve, graph = null }) {
  const out = [];
  const rels = new Set(notes.map((n) => n.rel));
  for (const n of notes) {
    if (!isInstruction(n.rel)) continue;
    const size = n.chars ?? n.text.length;
    const name = n.rel;
    if (size > BUDGET) {
      const pick = splitPlan(n.text);
      const dir = dirOf(n.rel);
      const parts = pick.map((s) => {
        let to = `${dir ? `${dir}/` : ''}${baseOf(n.rel).toLowerCase()}-${slug(s.heading)}.md`;
        for (let i = 2; rels.has(to); i++) to = to.replace(/(-\d+)?\.md$/, `-${i}.md`);
        return { heading: s.heading, start: s.start, end: s.end, to };
      });
      out.push(finding(rule, {
        key: `size:${n.rel}`, target: n.rel, notes: [n.rel],
        title: `${quote(name)} is ${Math.round(size / 1000)}k characters, over the ${Math.round(BUDGET / 1000)}k budget`,
        problem: `Every agent session loads it whole: about ${Math.round(size / 4).toLocaleString('en-US')} tokens before the first question. Long instructions crowd out the task and the agent follows them less reliably.`,
        proposal: parts.length ? `Move ${plural(parts.length, 'section')} (${parts.map((p) => quote(p.heading)).join(', ')}) into notes beside it, with a link line under each heading.` : 'It has no second-level sections to move out. Shorten it by hand or split it under headings.',
        evidence: [`${size.toLocaleString('en-US')} characters`, `Budget: ${BUDGET.toLocaleString('en-US')} characters`, ...parts.map((p) => `Moves out: ${p.heading} (${(p.end - p.start)} lines)`)],
        facts: [`size:${Math.round(size / 2000)}`],
        meta: [['File', n.rel]],
        ...(parts.length ? { fix: { kind: 'ops', group: 'split', ops: [{ op: 'split', rel: n.rel, parts }] } } : {}),
      }));
    }
    const dead = new Map();
    for (const l of n.note?.links ?? []) {
      if (l.embed || resolve(l.target, n.rel)) continue;
      const t = l.target.replace(/\.md$/i, '').trim();
      if (!t) continue;
      (dead.get(t) ?? dead.set(t, []).get(t)).push(l.line + 1);
    }
    if (dead.size) {
      const targets = [...dead.keys()].sort();
      out.push(finding(rule, {
        key: `links:${n.rel}`, target: n.rel, notes: [n.rel],
        title: `${quote(name)} links to ${plural(targets.length, 'note')} that ${targets.length === 1 ? 'is' : 'are'} not in the vault`,
        problem: 'An agent that follows these links finds nothing, and reads the instruction as pointing at memory that is gone.',
        proposal: `Remove the ${targets.length === 1 ? 'link' : 'links'} to ${targets.slice(0, 4).map(quote).join(', ')}${targets.length > 4 ? ' and the others' : ''}, and keep the words.`,
        evidence: targets.map((t) => `${t}: line ${dead.get(t).join(', ')}`),
        facts: targets.map((t) => `dead:${t.toLowerCase()}`),
        meta: [['File', n.rel]],
        fix: { kind: 'ops', group: 'unlink', ops: targets.map((t) => ({ op: 'unlink', target: t, sources: [n.rel], lines: { [n.rel]: dead.get(t) } })) },
      }));
    }
    if (!graph) continue;
    const lines = n.text.split('\n');
    const byLine = new Map();
    for (const e of graph.edgesFrom(n.rel)) {
      if (e.source_line == null || !(e.superseded_by != null || e.valid_to != null || e.kind === 'contradicts')) continue;
      const line = e.source_line + 1;
      if (!lines[line - 1]?.trim() || /out of date/i.test(lines[line - 1])) continue;
      if (!byLine.has(line)) byLine.set(line, e);
    }
    for (const [line, e] of byLine) {
      const text = lines[line - 1];
      out.push(finding(rule, {
        key: `graph:${n.rel}:${line}`, target: `${n.rel}\n${line}`, notes: [n.rel],
        title: `Line ${line} of ${quote(name)} states a fact the memory no longer holds`,
        problem: e.kind === 'contradicts' ? 'A newer note disagrees with this line, and every agent session reads it as current.' : 'The memory graph holds a newer fact that replaced this line, and every agent session reads it as current.',
        proposal: `Add ${quote(' (out of date, check the memory)')} to the end of line ${line}. Nothing is deleted.`,
        evidence: [`Line ${line}: ${quote(text.trim().slice(0, 160))}`, `Edge: ${e.kind}${e.superseded_by != null ? ', superseded' : ''}`],
        meta: [['File', n.rel], ['Line', String(line)]],
        fix: { kind: 'ops', group: 'mark-instructions', ops: [{ op: 'annotate', rel: n.rel, line, text, add: ' (out of date, check the memory)' }] },
      }));
    }
  }
  return out;
}
