// Record in the rich editor. Each turn's paragraphs are tracked by their position in the document, mapped through every
// edit, together with the raw markdown Record wrote for them and the editor's markdown of that range at write time. A
// growing turn rewrites its range in place only while that range is untouched (its markdown is still what was written)
// and is the end of the note; otherwise the gained words go in a new paragraph at the end. Matching on the raw text
// keeps *, _, [ and names with markdown characters from breaking the match the way a serializer round trip would.
import type { Mapping } from '@tiptap/pm/transform';
import { Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { planTurn, turnLine, type Turn } from '../noteRecord';
import { toDoc, toMarkdown } from './markdown';

export type LiveTurn = { full: string; tail: string; from: number; to: number; mark: string };
export type TailModel = { last: number | null; turns: Record<number, LiveTurn> };
export const emptyTail = (): TailModel => ({ last: null, turns: {} });

const rangeMarkdown = (doc: PMNode, from: number, to: number) => toMarkdown({ type: 'doc', content: doc.slice(from, to).content.toJSON() ?? [] });
const isBlankDoc = (doc: PMNode) => doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;

// every tracked range follows an edit; a range whose text was deleted collapses and stops matching
export function mapTail(model: TailModel, mapping: Mapping): TailModel {
  const turns: Record<number, LiveTurn> = {};
  for (const [id, t] of Object.entries(model.turns)) turns[Number(id)] = { ...t, from: mapping.map(t.from, 1), to: mapping.map(t.to, -1) };
  return { ...model, turns };
}

// the transaction that writes one turn, and the model after it; null when nothing changes. The selection is mapped by
// the transaction, so it stays where it was, and the view follows the end only when the caret was already there
export function recordTurn(state: EditorState, model: TailModel, turn: Turn): { tr: Transaction; model: TailModel } | null {
  const line = turnLine(turn);
  if (!line) return null;
  const doc = state.doc;
  const prev = model.turns[turn.id];
  const intact = !!prev && prev.from < prev.to && prev.to <= doc.content.size && rangeMarkdown(doc, prev.from, prev.to) === prev.mark;
  const atEnd = intact && model.last === turn.id && prev.to === doc.content.size;
  const plan = planTurn(prev, line, atEnd);
  if (plan.op === 'none') return prev ? { tr: state.tr, model: { ...model, turns: { ...model.turns, [turn.id]: { ...prev, full: plan.full, tail: plan.tail } } } } : null;
  const nodes = (toDoc(plan.text).content ?? []).map((j) => state.schema.nodeFromJSON(j));
  if (!nodes.length) return null;
  const following = state.selection.empty && state.selection.head === Selection.atEnd(doc).head;
  const [from, to] = plan.op === 'replace' ? [prev!.from, prev!.to] : isBlankDoc(doc) ? [0, doc.content.size] : [doc.content.size, doc.content.size];
  const tr = state.tr.replaceWith(from, to, nodes);
  const end = from + nodes.reduce((n, x) => n + x.nodeSize, 0);
  if (following) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.doc.content.size), -1)).scrollIntoView();
  const others = mapTail({ ...model, turns: Object.fromEntries(Object.entries(model.turns).filter(([id]) => Number(id) !== turn.id)) }, tr.mapping);
  return { tr, model: { last: turn.id, turns: { ...others.turns, [turn.id]: { full: plan.full, tail: plan.tail, from, to: end, mark: rangeMarkdown(tr.doc, from, end) } } } };
}
