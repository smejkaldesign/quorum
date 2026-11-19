// Exercises scripts/check-edition-boundary.mjs against small app trees in a temp folder (--root), so the static and
// dynamic import rules and the dist marker rule each get a real pass and a real failure.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/check-edition-boundary.mjs', import.meta.url));
const MARKER = 'QUORUM_EE_MARKER';
let root;

// a minimal app tree that satisfies the check: the two edition modules, one ee module and a built renderer
function tree(extra = {}, { marker = false } = {}) {
  root = mkdtempSync(path.join(tmpdir(), 'quorum-boundary-'));
  const files = {
    'edition.js': 'export function loadEE(file) {\n  return import(`./ee/${file}`);\n}\n',
    'src/edition.tsx': 'export const edition = "local";\n',
    'src/App.tsx': 'import { edition } from "./edition";\nexport const App = () => edition;\n',
    'ee/sync.js': 'export const sync = 1;\n',
    'dist/assets/index.js': marker ? `console.log("${MARKER}");\n` : 'console.log("renderer");\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function check(env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, QUORUM_EDITION: '', ...env } });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('edition boundary check', () => {
  it('passes a clean local tree', () => {
    tree();
    const r = check();
    expect(r.err).toBe('');
    expect(r.out.trim()).toBe('edition boundary (local): ok');
    expect(r.status).toBe(0);
  });

  it('fails a static import of ee/ outside the edition modules', () => {
    tree({ 'leak.js': 'import { sync } from "./ee/sync.js";\nexport const x = sync;\n' });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/leak\.js: static import of ee\/ \(\.\/ee\/sync\.js\)/);
    expect(r.err).toMatch(/1 problem\b/);
  });

  it('fails a dynamic import of ee/ from a file other than edition.js or src/edition.tsx', () => {
    tree({ 'src/Later.tsx': 'export const load = () => import("../ee/sync.js");\n' });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/src\/Later\.tsx: dynamic import of ee\//);
  });

  it('fails when the local renderer bundle carries the ee marker', () => {
    tree({}, { marker: true });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/local renderer bundle contains ee code/);
  });

  it('expects the marker in the cloud edition', () => {
    tree({}, { marker: true });
    expect(check({ QUORUM_EDITION: 'cloud' })).toMatchObject({ status: 0, out: 'edition boundary (cloud): ok\n' });
    rmSync(root, { recursive: true, force: true });
    tree();
    const r = check({ QUORUM_EDITION: 'cloud' });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/cloud renderer bundle has no ee code/);
  });

  it('fails when dist/ is missing', () => {
    tree();
    rmSync(path.join(root, 'dist'), { recursive: true, force: true });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/dist\/ is missing/);
  });
  it('fails when the renderer reaches a Node built-in through a shared module', () => {
    tree({ 'src/Page.tsx': 'import { T } from "../sources/shared";\nexport const P = T;\n', 'sources/shared.js': 'import { spawn } from "node:child_process";\nimport { a } from "./deep.js";\nexport const T = [spawn, a];\n', 'sources/deep.js': 'import { readFileSync } from "fs";\nexport const a = readFileSync;\n' });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toContain("'node:child_process' through src/Page.tsx -> sources/shared.js");
    expect(r.err).toContain("'fs' through src/Page.tsx -> sources/shared.js -> sources/deep.js");
  });
  it('allows type-only imports from Node-side modules and Node imports the renderer never reaches', () => {
    tree({ 'src/Page.tsx': 'import type { T } from "../sources/main-only";\nimport { S } from "../sources/shared";\nexport const P = S;\n', 'sources/main-only.js': 'import fs from "node:fs";\nexport const T = fs;\n', 'sources/shared.js': 'export const S = 1;\n', 'main.js': 'import { spawn } from "node:child_process";\n' });
    expect(check().status).toBe(0);
  });
  it('follows multi-line imports and exports to a Node built-in', () => {
    tree({ 'src/P.tsx': 'import {\n  a,\n  b,\n} from "../sources/m";\nexport const P = [a, b];\n', 'sources/m.js': 'export {\n  b,\n} from "./n.js";\nimport {\n  readFileSync,\n} from \'node:fs\';\nexport const a = readFileSync;\n', 'sources/n.js': 'import {\n  spawn,\n} from "child_process";\nexport const b = spawn;\n' });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toContain("'node:fs' through src/P.tsx -> sources/m.js");
    expect(r.err).toContain("'child_process' through src/P.tsx -> sources/m.js -> sources/n.js");
  });
  it('fails a multi-line static import of ee/', () => {
    tree({ 'leak.js': 'import {\n  sync,\n} from "./ee/sync.js";\nexport const x = sync;\n' });
    const r = check();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/leak\.js: static import of ee\//);
  });
  it('skips a multi-line type-only import', () => {
    tree({ 'src/P.tsx': 'import type {\n  T,\n} from "../sources/main-only";\nexport const P = 1;\n', 'sources/main-only.js': 'import fs from "node:fs";\nexport const T = fs;\n' });
    expect(check().status).toBe(0);
  });
});
