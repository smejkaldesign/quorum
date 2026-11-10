// T3 harness, round two: save with no edits and with one edited paragraph through the splicer.
// Counts only; opted-out notes skipped.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { walk } from '../vault.js';
import { createSplicer } from '../splice.mjs';

const vault = process.argv[2];
const terms = (() => { try { return readFileSync(path.join(vault, 'scripts/embed-bench/excluded.txt'), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; } })();
const excluded = (t) => terms.some((x) => t.toLowerCase().includes(x));
const md = new MarkdownManager({ extensions: [StarterKit, TableKit] });
const splice = createSplicer(md);
const r = { notes: 0, unmapped: 0, noEditSame: 0, noEditDiff: 0, editTested: 0, editOnlyThatBlock: 0, editSpill: 0 };
for (const rel of walk(vault, '', excluded, [])) {
  const raw = readFileSync(path.join(vault, rel), 'utf8');
  if (excluded(raw)) continue;
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  r.notes++;
  const doc = md.parse(body);
  const same = splice(body, doc);
  if (same === null) { r.unmapped++; continue; }
  if (same === body) r.noEditSame++; else r.noEditDiff++;
  const k = (doc.content ?? []).findIndex((nd) => nd.type === 'paragraph' && nd.content?.some((c) => c.type === 'text'));
  if (k < 0) continue;
  const edited = structuredClone(doc);
  const t = edited.content[k].content.find((c) => c.type === 'text');
  t.text += ' EDITED';
  const out = splice(body, edited);
  r.editTested++;
  // everything before and after the edited block must be byte-identical
  let p = 0; while (p < body.length && body[p] === out[p]) p++;
  let q = 0; while (q < body.length - p && body[body.length - 1 - q] === out[out.length - 1 - q]) q++;
  const touched = body.slice(p, body.length - q);
  if (!touched.includes('\n\n')) r.editOnlyThatBlock++; else r.editSpill++;
}
console.log(JSON.stringify(r));
