import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTree, ignoreRules, isIgnored } from '../scripts/check-image.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the .railwayignore rules read as gitignore does, with ! re-including files', () => {
  const rules = ignoreRules(readFileSync(path.join(repo, '.railwayignore'), 'utf8'));
  assert.equal(isIgnored(rules, 'app/store/local.js', false), false);
  assert.equal(isIgnored(rules, 'app/store/other.js', false), true);
  assert.equal(isIgnored(rules, 'app/ee/kbUpstream.js', false), false);
  assert.equal(isIgnored(rules, 'app/ee/kbDrive.js', false), true);
  assert.equal(isIgnored(rules, 'app/ee/store/remote.js', false), false);
  assert.equal(isIgnored(rules, 'app/src/App.tsx', false), true);
  assert.equal(isIgnored(rules, 'relay/server.js', false), false);
  // a file inside an ignored folder cannot come back
  const parent = ignoreRules('lib/\n!lib/keep.js\n');
  assert.equal(isIgnored(parent, 'lib/keep.js', false), true);
  // a pattern without a slash matches at any depth; a trailing slash matches folders only
  const any = ignoreRules('*.log\ncache/\n');
  assert.equal(isIgnored(any, 'a/b/x.log', false), true);
  assert.equal(isIgnored(any, 'a/cache', true), true);
  assert.equal(isIgnored(any, 'a/cache', false), false);
});

test('the image tree fails on a COPY of a file the build context leaves out, and filters folders and globs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'check-image-src-'));
  const out = mkdtempSync(path.join(tmpdir(), 'check-image-out-'));
  try {
    for (const [f, t] of [['app/a.js', 'a'], ['app/b.js', 'b'], ['app/ee/one.js', '1'], ['app/ee/two.js', '2'], ['app/speech/x.js', 'x'], ['app/speech/skip.js', 's']]) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), t);
    }
    const ignore = 'app/b.js\napp/ee/*\n!app/ee/one.js\napp/speech/skip.js\n';
    const copied = buildTree({ root, out, ignore, dockerfile: 'COPY app/*.js app/\nCOPY app/speech/ app/speech/\nCOPY app/ee/one.js app/ee/\n' });
    assert.deepEqual(copied, ['app/a.js', 'app/speech', 'app/ee/one.js']);
    assert.ok(existsSync(path.join(out, 'app/a.js')) && !existsSync(path.join(out, 'app/b.js')), 'a glob copies only what the context has');
    assert.ok(existsSync(path.join(out, 'app/speech/x.js')) && !existsSync(path.join(out, 'app/speech/skip.js')), 'a folder copies only what the context has');
    assert.throws(() => buildTree({ root, out, ignore, dockerfile: 'COPY app/ee/two.js app/ee/\n' }), /app\/ee\/two\.js, which \.railwayignore leaves out/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('the repository\'s Dockerfile copies nothing its .railwayignore leaves out', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'check-image-repo-'));
  try { assert.ok(buildTree({ root: repo, out }).includes('app/store/local.js')); } finally { rmSync(out, { recursive: true, force: true }); }
});
