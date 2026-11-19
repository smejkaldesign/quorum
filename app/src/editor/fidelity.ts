// What the Knowledge editor would do with one note file, checked without writing anything: whether it opens as rich
// text, plain text or read-only, whether saving it untouched gives back the same bytes, and, for a rich note, whether an
// edit to one paragraph changes that paragraph only (null when there is no paragraph to edit)
import { editParts, withBody } from '../../noteEdit.js';
import { canSplice, splice, toDoc } from './markdown';

export type Fidelity = { opens: 'rich' | 'plain' | 'read-only'; same: boolean; contained: boolean | null };

export function checkNote(raw: string): Fidelity {
  const p = editParts(raw);
  if (p.mixed) return { opens: 'read-only', same: true, contained: null };
  if (!canSplice(p.body)) return { opens: 'plain', same: withBody(raw, p.body) === raw, contained: null };
  const doc = toDoc(p.body);
  const same = withBody(raw, splice(p.body, doc)) === raw;
  const k = (doc.content ?? []).findIndex((n) => n.type === 'paragraph' && n.content?.some((c) => c.type === 'text'));
  if (k < 0) return { opens: 'rich', same, contained: null };
  const edited = structuredClone(doc);
  edited.content![k].content!.find((c) => c.type === 'text')!.text += ' edited';
  const out = splice(p.body, edited);
  // the text that differs must sit inside one block: no blank line in it
  let a = 0;
  while (a < p.body.length && p.body[a] === out[a]) a++;
  let z = 0;
  while (z < p.body.length - a && p.body[p.body.length - 1 - z] === out[out.length - 1 - z]) z++;
  return { opens: 'rich', same, contained: !p.body.slice(a, p.body.length - z).includes('\n\n') && !out.slice(a, out.length - z).includes('\n\n') };
}
