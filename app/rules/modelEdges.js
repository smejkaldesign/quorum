// Connections the model pass (memoryModelPass.js) read from a note's prose with confidence under its bar, or that name
// someone the graph has no node for yet. They wait here, outside the graph, so no agent reads one as fact. Approve adds
// the connection to the memory graph with person provenance and writes nothing to the note; Archive declines it, and the
// pass never proposes that reading of that note again.
import { finding, quote } from './common.js';
import { confidentialSet } from './entities.js';
import { HIGH } from '../memoryModelPass.js';

const pct = (c) => `${Math.round(Number(c ?? 0) * 100)}%`;

export const rule = { id: 'note.model-edge', version: 1, label: 'Connections the model read and is unsure of' };

const nameOf = (end, fallback) => end?.name ?? fallback;
// the connection in one line: “Ana Ruiz” works on “Atlas” as lead
export function proposalLine(p) {
  const x = p.props ?? {};
  const a = quote(nameOf(x.src, p.src));
  const b = quote(nameOf(x.dst, p.dst));
  if (p.kind === 'mentions') return `the note names ${b}`;
  if (p.kind === 'works_on') return `${a} works on ${b}${x.role ? ` as ${x.role}` : ''}`;
  if (p.kind === 'member_of') return `${a} is part of ${b}`;
  if (p.kind === 'attended') return `${a} attended this meeting`;
  if (p.kind === 'decision') return `a decision: ${quote(x.text ?? '')}${x.about?.length ? ` about ${x.about.map((y) => quote(nameOf(y, y.id))).join(', ')}` : ''}`;
  return `${a} is connected to ${b}`;
}

// the proposals change when the pass runs, not when a note is saved: every run lists them all
export const wide = () => true;

export function run(ctx) {
  const pending = ctx.graph?.proposals?.() ?? [];
  if (!pending.length) return [];
  const secret = confidentialSet(ctx);
  const byRel = new Map((ctx.notes ?? []).map((n) => [n.rel, n]));
  const out = [];
  for (const p of pending) {
    const n = byRel.get(p.rel);
    if (!n || secret(n)) continue;
    const x = p.props ?? {};
    const line = proposalLine(p);
    const gap = [x.src, x.dst].find((e) => e?.gap);
    out.push(finding(rule, {
      key: p.key, target: p.rel, notes: [p.rel],
      title: `${quote(n.note?.title ?? p.rel)}: ${line}`,
      problem: x.conflict
        ? `Quorum's model read this from the note's prose, and it disagrees with what ${quote(x.conflict.rel ?? 'another note')} states. Quorum keeps what your notes state and adds a model reading only when you approve it. Agents do not see it until then.`
        : gap
          ? `Quorum's model read this from the note's prose, and the memory graph has no ${gap.kind} named ${quote(gap.name)} yet. Agents do not see it until you approve it.`
          : `Quorum's model read this from the note's prose and is ${pct(p.confidence)} sure. It adds a connection by itself only at ${pct(HIGH)} or more. Agents do not see it until you approve it.`,
      proposal: 'Approve to add it to the memory graph as a connection you confirmed. Quorum writes nothing to the note. Archive to decline it; the model pass will not suggest it again.',
      evidence: [`Line ${p.line}: ${x.quote ?? ''}`],
      meta: [['Note', p.rel], ['Confidence', pct(p.confidence)]],
      fix: { kind: 'ops', group: 'confirm', ops: [{ op: 'confirm', rel: p.rel, key: p.key, label: line }] },
    }));
  }
  return out;
}
