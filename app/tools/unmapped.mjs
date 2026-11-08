// which top-level markdown token types the editor drops or splits, by count only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { walk } from '../vault.js';
const vault = process.argv[2];
const terms = (() => { try { return readFileSync(path.join(vault, 'scripts/embed-bench/excluded.txt'), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; } })();
const excluded = (t) => terms.some((x) => t.toLowerCase().includes(x));
const md = new MarkdownManager({ extensions: [StarterKit, TableKit] });
const c = new Map();
for (const rel of walk(vault, '', excluded, [])) {
  const raw = readFileSync(path.join(vault, rel), 'utf8');
  if (excluded(raw)) continue;
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  const toks = marked.lexer(body).filter((t) => t.type !== 'space');
  const nodes = md.parse(body).content ?? [];
  if (toks.length === nodes.length) continue;
  const tt = new Set(toks.map((t) => t.type));
  for (const t of tt) c.set(t, (c.get(t) ?? 0) + 1);
}
console.log(JSON.stringify([...c].sort((a, b) => b[1] - a[1])));
