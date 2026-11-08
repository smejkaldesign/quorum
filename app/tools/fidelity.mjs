// T3 harness: round-trip every note through Tiptap's markdown parser and serializer, count byte-identical files.
// Reports counts and change categories only, never note text. Opted-out notes are skipped entirely.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { walk } from '../vault.js';

const vault = process.argv[2];
const terms = (() => { try { return readFileSync(path.join(vault, 'scripts/embed-bench/excluded.txt'), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; } })();
const excluded = (t) => terms.some((x) => t.toLowerCase().includes(x));
const md = new MarkdownManager({ extensions: [StarterKit] });
let same = 0, diff = 0, failed = 0, skipped = 0;
const kinds = new Map();
for (const rel of walk(vault, '', excluded, [])) {
  const raw = readFileSync(path.join(vault, rel), 'utf8');
  if (excluded(raw)) { skipped++; continue; }
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  let out;
  try { out = md.serialize(md.parse(body)); } catch { failed++; continue; }
  if (out === body) { same++; continue; }
  diff++;
  const a = body.split('\n'), b = out.split('\n');
  const tag = (l) => /^\s*[-*+]\s/.test(l) ? 'list' : /^#{1,6}\s/.test(l) ? 'heading' : /^\|/.test(l) ? 'table' : /^```/.test(l) ? 'code' : /^>/.test(l) ? 'quote' : l.trim() === '' ? 'blank' : /\[\[/.test(l) ? 'wikilink' : 'paragraph';
  const seen = new Set();
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) seen.add(tag(a[i] ?? b[i] ?? ''));
  for (const k of seen) kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
console.log(JSON.stringify({ same, diff, failed, skipped, firstDiffKinds: Object.fromEntries([...kinds].sort((x, y) => y[1] - x[1])) }));
