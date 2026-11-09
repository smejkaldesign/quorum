// Runs guards/read-guard.py the way Claude Code does: a PreToolUse payload on stdin, a deny decision on stdout or
// nothing at all. Files live in a temp root so every path check runs against the real filesystem.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const GUARD = fileURLToPath(new URL('../guards/read-guard.py', import.meta.url));
let root;

function run(payload) {
  const r = spawnSync('python3', ['-I', GUARD, '--root', root, '--deny', 'private'], { input: JSON.stringify(payload), encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe('');
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout).hookSpecificOutput;
}
const read = (file_path) => run({ tool_name: 'Read', tool_input: { file_path } });

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'quorum-guard-'));
  for (const dir of ['private', 'notes', '.git']) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, '.env'), 'TOKEN=abc\n');
  writeFileSync(path.join(root, 'id_rsa'), 'not a real key\n');
  writeFileSync(path.join(root, '.git/config'), '[core]\n');
  writeFileSync(path.join(root, 'private/notes.md'), '# private\n');
  writeFileSync(path.join(root, 'notes/plan.md'), '---\ntitle: Plan\nconfidential: personal\n---\n# Plan\n');
  writeFileSync(path.join(root, 'notes/plain.md'), '# Plain\n\nNothing secret here.\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('read guard', () => {
  it('denies secret-looking filenames', () => {
    for (const rel of ['.env', 'id_rsa']) {
      const out = read(path.join(root, rel));
      expect(out).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(out.permissionDecisionReason).toMatch(/secret or credential/);
    }
  });

  it('denies a file inside a --deny dir', () => {
    const out = read(path.join(root, 'private/notes.md'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/private\/ is private/);
  });

  it('denies .git even without --deny', () => {
    const out = read(path.join(root, '.git/config'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/\.git\//);
  });

  it('denies a markdown file whose frontmatter carries confidential:', () => {
    const out = read(path.join(root, 'notes/plan.md'));
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(/confidential/);
  });

  it('allows a plain markdown file, by absolute and by relative path', () => {
    expect(read(path.join(root, 'notes/plain.md'))).toBeNull();
    expect(read('notes/plain.md')).toBeNull();
  });

  it('denies a Grep whose pattern names a private dir and allows one that does not', () => {
    const denied = run({ tool_name: 'Grep', tool_input: { pattern: 'private/notes', path: root } });
    expect(denied.permissionDecision).toBe('deny');
    expect(denied.permissionDecisionReason).toMatch(/private\//);
    expect(run({ tool_name: 'Grep', tool_input: { pattern: 'TODO', path: root } })).toBeNull();
  });

  it('ignores tools other than Read, Grep and Glob', () => {
    expect(run({ tool_name: 'Edit', tool_input: { file_path: path.join(root, '.env') } })).toBeNull();
  });
});
