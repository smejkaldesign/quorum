// Round-trips every note in a folder through the Knowledge editor without writing anything. Prints how many open as
// rich text, plain text and read-only, then lists each note that would not save back byte for byte untouched, and each
// rich note where an edit to one paragraph would change more than that paragraph. Exits 1 when it lists any.
// Usage: npm run fidelity -- <folder>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
import { walk } from '../vault.js';

const dir = process.argv[2];
if (!dir) { console.error('Usage: npm run fidelity -- <folder>'); process.exit(2); }
const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { module: { checkNote } } = await runnerImport(path.join(app, 'src/editor/fidelity.ts'), { configFile: false, root: app, logLevel: 'error' });

const count = { notes: 0, rich: 0, plain: 0, 'read-only': 0 };
const changed = [], spilled = [];
for (const rel of walk(path.resolve(dir), '', () => false, [])) {
  const r = checkNote(readFileSync(path.join(dir, rel), 'utf8'));
  count.notes++;
  count[r.opens]++;
  if (!r.same) changed.push(rel);
  if (r.contained === false) spilled.push(rel);
}
console.log(`${count.notes} notes: ${count.rich} rich text, ${count.plain} plain text, ${count['read-only']} read-only`);
for (const rel of changed) console.log(`would change on save: ${rel}`);
for (const rel of spilled) console.log(`an edit would spill past its block: ${rel}`);
if (!changed.length && !spilled.length) console.log('Every note saves back exactly.');
process.exit(changed.length || spilled.length ? 1 : 0);
