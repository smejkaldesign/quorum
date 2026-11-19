#!/usr/bin/env node
// Edition boundary check (docs/open-source-strategy.md). Three rules:
//  1. Source outside app/ee/ may reach ee/ only through a dynamic import() inside the two edition modules
//     (edition.js for the main process, src/edition.tsx for the renderer). Every other import of ee/ fails.
//  2. The built renderer in dist/ must not contain the ee marker string in the local edition, and must contain it in
//     the cloud edition. QUORUM_EDITION decides which edition dist/ is expected to be (default local).
//  3. Nothing the renderer loads (src/, ee/src/ and every module they reach through relative imports) may import a Node
//     built-in. Vite swaps those for empty stubs, so the page builds and then throws the moment the module loads.
// Run after `vite build`. Exits 1 with a list of problems, 0 when the boundary holds. Optional: --root <app dir>.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

// --root <dir> points the check at another app tree (the tests use a temp copy); the default is the folder above scripts/
const rootArg = process.argv.indexOf('--root');
const app = rootArg !== -1 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'QUORUM_EE_MARKER';
const SKIP = new Set(['node_modules', 'dist', 'release', 'build', 'assets', '.dev', 'ee', 'scripts', 'test', 'lint']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const DYNAMIC_ALLOWED = new Set(['edition.js', 'src/edition.tsx']);
const edition = process.env.QUORUM_EDITION === 'cloud' ? 'cloud' : 'local';
const problems = [];

// SKIP applies at the app root only; dist/assets/ holds the built renderer and must be scanned
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || (dir === app && SKIP.has(name))) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) { yield* walk(abs); continue; }
    if (EXT.has(path.extname(name))) yield abs;
  }
}

// does a specifier point into app/ee/ once resolved from the importing file
const intoEE = (file, spec) => {
  if (!spec.startsWith('.')) return false;
  const target = path.resolve(path.dirname(file), spec);
  return target === path.join(app, 'ee') || target.startsWith(path.join(app, 'ee') + path.sep);
};

// the names before `from` are a braced list (which the formatter splits over several lines) and/or bare names, `* as x`
const NAMES = String.raw`(?:[\w$*\s,]*?\{[^}]*\}|[\w$*\s,]+?)`;
const STATIC = new RegExp(String.raw`(?:^|\n)\s*(?:import|export)\s+${NAMES}\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)`, 'g');
const DYNAMIC = /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

for (const file of walk(app)) {
  const rel = path.relative(app, file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(STATIC)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (intoEE(file, spec)) problems.push(`${rel}: static import of ee/ (${spec}); go through edition.js or src/edition.tsx`);
  }
  for (const m of text.matchAll(DYNAMIC)) {
    if (intoEE(file, m[1]) && !DYNAMIC_ALLOWED.has(rel)) problems.push(`${rel}: dynamic import of ee/ (${m[1]}); only edition.js and src/edition.tsx may do this`);
  }
}
// edition.js builds its import path from a template string, so the regex above does not see it; check the file by hand
const editionSrc = readFileSync(path.join(app, 'edition.js'), 'utf8');
if (!/import\(`\.\/ee\/\$\{file\}`\)/.test(editionSrc)) problems.push('edition.js: loadEE no longer imports from ./ee/; the boundary check expects it to');

// rule 3: follow the renderer's runtime imports (type-only imports are erased) and flag any Node built-in they reach
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));
const isBuiltin = (spec) => spec.startsWith('node:') || BUILTIN.has(spec.split('/')[0]);
const RUNTIME = new RegExp(String.raw`(?:^|\n)\s*(import|export)(?!\s+type\b)\s+${NAMES}\s*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)`, 'g');
const RESOLVE = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.js'];
const resolveRel = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec);
  for (const ext of RESOLVE) { const f = base + ext; if (existsSync(f) && statSync(f).isFile() && !f.endsWith('.d.ts')) return f; }
  const stripped = base.replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx']) if (existsSync(stripped + ext)) return stripped + ext;
  return null;
};
const rendererEntries = ['src', path.join('ee', 'src')].map((d) => path.join(app, d)).filter(existsSync)
  .flatMap((d) => [...walk(d)]).filter((f) => !f.endsWith('.d.ts') && !/\.test\.[jt]sx?$/.test(f));
const seen = new Set();
const chain = new Map(rendererEntries.map((f) => [f, null]));
const queue = [...rendererEntries];
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  for (const m of readFileSync(file, 'utf8').matchAll(RUNTIME)) {
    const spec = m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    if (isBuiltin(spec)) {
      const via = []; for (let f = file; f; f = chain.get(f)) via.unshift(path.relative(app, f));
      problems.push(`renderer reaches Node built-in '${spec}' through ${via.join(' -> ')}; move what the page needs into a module with no Node imports`);
      continue;
    }
    if (!spec.startsWith('.')) continue;
    const target = resolveRel(file, spec);
    if (target && !seen.has(target)) { if (!chain.has(target)) chain.set(target, file); queue.push(target); }
  }
}

const dist = path.join(app, 'dist');
if (!existsSync(dist)) {
  problems.push('dist/ is missing; run `vite build` first');
} else {
  const found = [...walk(dist)].filter((f) => readFileSync(f, 'utf8').includes(MARKER)).map((f) => path.relative(app, f));
  if (edition === 'local' && found.length) problems.push(`local renderer bundle contains ee code (${MARKER} in ${found.join(', ')})`);
  if (edition === 'cloud' && !found.length) problems.push(`cloud renderer bundle has no ee code (${MARKER} missing); the Account UI did not make it into dist/`);
}

if (problems.length) {
  console.error(`edition boundary (${edition}): ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`edition boundary (${edition}): ok`);
