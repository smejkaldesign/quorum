// Instruction files: CLAUDE.md, AGENTS.md, GEMINI.md and the like load into every agent session, so each line costs
// context on every call. Two checks:
//   size      longer than the budget: listed with its largest sections, and no fix. Claude Code and Codex do not follow
//             wikilinks, so a section moved into a linked note stops loading; which rules can go is the person's call
//   graph     a line that states a decision a newer decision replaced: Approve marks the line out of date. Only a line
//             whose text still holds that decision, and only when this file is the losing side of a supersedes edge
// Links to notes that are not in the vault are the broken link check's (link.missing), with its relink and stub fixes.
// Files outside the vault folder are measured by the Memory setup scan (memorySetup.js), which lists them in its report.
import { baseOf, dirOf, finding, quote } from './common.js';

export const rule = { id: 'note.instructions', version: 2, label: 'Instruction files that cost too much context' };
export const INSTRUCTION_NAME = /^(claude|agents|gemini|codex|copilot-instructions|cursor-rules|instructions)$/i;
// about 3,000 tokens
export const BUDGET = 12000;
// a note named instructions is an agent's file only at the vault root or in .github; elsewhere it is a recipe or steps
export const isInstruction = (rel) => {
  const name = baseOf(rel);
  if (!INSTRUCTION_NAME.test(name)) return false;
  return name.toLowerCase() !== 'instructions' || dirOf(rel) === '' || dirOf(rel) === '.github';
};
const clean = (t) => String(t ?? '').replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, a, b) => b ?? a.split('/').pop()).replace(/[*_`]+/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

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
export function run({ notes, graph = null }) {
  const out = [];
  for (const n of notes) {
    if (!isInstruction(n.rel)) continue;
    const size = n.chars ?? n.text.length;
    const name = n.rel;
    if (size > BUDGET) {
      const big = sections(n.text).sort((a, b) => b.chars - a.chars).slice(0, 3);
      out.push(finding(rule, {
        key: `size:${n.rel}`, target: n.rel, notes: [n.rel],
        title: `${quote(name)} is ${Math.round(size / 1000)}k characters, over the ${Math.round(BUDGET / 1000)}k budget`,
        problem: `Every agent session loads it whole: about ${Math.round(size / 4).toLocaleString('en-US')} tokens before the first question. Long instructions leave less room for the task, and the agent follows them less reliably.`,
        proposal: `Shorten it by hand${big.length ? `, starting with its largest ${big.length === 1 ? 'section' : 'sections'}` : ''}. Quorum does not move sections out: Claude Code and Codex do not follow wikilinks, so a rule moved into a linked note stops loading.`,
        evidence: [`${size.toLocaleString('en-US')} characters`, `Budget: ${BUDGET.toLocaleString('en-US')} characters`, ...big.map((p) => `Section ${quote(p.heading)}: ${p.chars.toLocaleString('en-US')} characters`)],
        facts: [`size:${Math.round(size / 2000)}`],
        meta: [['File', n.rel]],
      }));
    }
    if (!graph) continue;
    const lines = n.text.split('\n');
    const byLine = new Map();
    for (const e of graph.edgesFrom(n.rel)) {
      // a decision this file states that a newer decision replaced, and that this file still states on that line
      if (e.source_line == null || e.superseded_by == null || !/^decision:/.test(e.src) || (e.kind !== 'decided_in' && e.kind !== 'decision_about')) continue;
      if (!graph.superseded(e.src)) continue;
      const line = e.source_line + 1;
      const text = lines[line - 1];
      if (!text?.trim() || /out of date/i.test(text)) continue;
      const said = clean(graph.node(e.src)?.props?.text ?? '');
      if (!said || !clean(text).includes(said.slice(0, 120))) continue;
      if (!byLine.has(line)) byLine.set(line, e);
    }
    for (const [line] of byLine) {
      const text = lines[line - 1];
      out.push(finding(rule, {
        key: `graph:${n.rel}:${line}`, target: `${n.rel}\n${line}`, notes: [n.rel],
        title: `Line ${line} of ${quote(name)} states a decision a newer one replaced`,
        problem: 'A newer decision on the same subject replaced this line, and every agent session reads it as current.',
        proposal: `Add ${quote(' (out of date, check the memory)')} to the end of line ${line}. Nothing is deleted.`,
        evidence: [`Line ${line}: ${quote(text.trim().slice(0, 160))}`, 'Edge: decision, superseded'],
        meta: [['File', n.rel], ['Line', String(line)]],
        fix: { kind: 'ops', group: 'mark-instructions', ops: [{ op: 'annotate', rel: n.rel, line, text, add: ' (out of date, check the memory)' }] },
      }));
    }
  }
  return out;
}
