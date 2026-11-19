// Round-trips every note in a folder through the Knowledge editor without writing anything. Prints how many open as
// rich text, plain text and read-only, then lists each note that would not save back byte for byte untouched, and each
// rich note where an edit to one paragraph would change more than that paragraph. Exits 1 when it lists any. A note
// that isn't valid UTF-8 counts as read-only, as the editor opens it. Notes with a term from the opt-out lists (the
// folder's scripts/embed-bench/excluded.txt, plus any --terms file) count as withheld and are never named.
// Usage: npm run fidelity -- <folder> [--terms <file>]...
import { isUtf8 } from 'node:buffer';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { walk } from '../vault.js';

const args = process.argv.slice(2);
const dir = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--terms');
if (!dir) { console.error('Usage: npm run fidelity -- <folder> [--terms <file>]...'); process.exit(2); }
const termFiles = [path.join(dir, 'scripts/embed-bench/excluded.txt'), ...args.filter((_, k) => args[k - 1] === '--terms')];
const terms = termFiles.flatMap((f) => { try { return readFileSync(f, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; } });
const withheld = (text) => { const lower = text.toLowerCase(); return terms.some((t) => lower.includes(t)); };
const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { module: { checkNote } } = await runnerImport(path.join(app, 'src/editor/fidelity.ts'), { configFile: false, root: app, logLevel: 'error' });

const count = { notes: 0, rich: 0, plain: 0, 'read-only': 0, withheld: 0 };
const changed = [], spilled = [];
for (const rel of walk(path.resolve(dir), '', () => false, [])) {
  const buf = readFileSync(path.join(dir, rel));
  const raw = buf.toString('utf8');
  count.notes++;
  if (withheld(`${rel}\n${raw}`)) { count.withheld++; continue; }
  if (!isUtf8(buf)) { count['read-only']++; continue; }
  const r = checkNote(raw);
  count[r.opens]++;
  if (!r.same) changed.push(rel);
  if (r.contained === false) spilled.push(rel);
}
console.log(`${count.notes} notes: ${count.rich} rich text, ${count.plain} plain text, ${count['read-only']} read-only, ${count.withheld} withheld (not checked)`);
for (const rel of changed) console.log(`would change on save: ${rel}`);
for (const rel of spilled) console.log(`an edit would spill past its block: ${rel}`);
if (!changed.length && !spilled.length) console.log('Every note saves back exactly.');
process.exit(changed.length || spilled.length ? 1 : 0);
