// Recent denials: the read guard hook appends one line per refused read, the app reads them back newest first with the
// rule that refused each one, records its own refusals once, and keeps the log at its cap.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DENIALS_CAP, createGuardrails, denialKindOf, parseDenialLines } from '../guardrails.js';

const GUARD = fileURLToPath(new URL('../guards/read-guard.py', import.meta.url));
let root;
let log;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'quorum-denials-'));
  mkdirSync(path.join(root, 'private'));
  mkdirSync(path.join(root, 'notes'));
  writeFileSync(path.join(root, '.env'), 'X=1\n');
  writeFileSync(path.join(root, 'private/diary.md'), '# diary\n');
  writeFileSync(path.join(root, 'notes/plan.md'), '---\nconfidential: personal\n---\n# Plan\n');
  writeFileSync(path.join(root, 'notes/plain.md'), '# Plain\n');
  log = path.join(root, 'guard-denials.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const guards = () => createGuardrails({ settings: {}, brain: () => ({ root, vault: root }), privateDirs: () => ['private'], denialLog: log });
// the flags the app passes the hook (agent.js safetySettings) for the built-in rules
const read = (file) => spawnSync('python3', ['-I', GUARD, '--root', root, '--log-denied', log, '--deny', 'private', '--frontmatter-key', 'confidential'], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(root, file) } }), encoding: 'utf8' });

describe('recent denials', () => {
  it('logs a read the built-in guards block and lists it with the guard and the surface', () => {
    const r = read('.env');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const [d] = guards().denials();
    expect(d).toMatchObject({ path: '.env', tool: 'Read', surface: 'agent', guard: 'built-in:secrets', guardLabel: 'Block files that look like keys or passwords' });
    expect(typeof d.id).toBe('string');
    expect(Number.isNaN(Date.parse(d.t))).toBe(false);
  });

  it('lists newest first, names each built-in guard, and leaves an allowed read out', () => {
    read('.env');
    read('private/diary.md');
    read('notes/plain.md');
    read('notes/plan.md');
    const list = guards().denials();
    expect(list.map((d) => [d.path, d.guard])).toEqual([
      ['notes/plan.md', 'built-in:confidential'],
      ['private/diary.md', 'built-in:private-folders'],
      ['.env', 'built-in:secrets'],
    ]);
  });

  it('shows the same list on the Guardrails page payload', async () => {
    read('private/diary.md');
    const st = await guards().get();
    expect(st.denials.map((d) => d.path)).toEqual(['private/diary.md']);
  });

  it('records a refusal made in the app once per path and surface', () => {
    const g = guards();
    expect(g.recordDenial({ path: 'notes/plan.md', reason: 'marked confidential: in its frontmatter', surface: 'keeper' })).toBe(true);
    expect(g.recordDenial({ path: 'notes/plan.md', reason: 'marked confidential: in its frontmatter', surface: 'keeper' })).toBe(false);
    expect(g.denials()).toEqual([expect.objectContaining({ path: 'notes/plan.md', surface: 'keeper', guard: 'built-in:confidential' })]);
  });

  it('filters by since and limit, skips a torn line, and trims the file to the cap', () => {
    const lines = Array.from({ length: DENIALS_CAP + 60 }, (_, i) => JSON.stringify({ t: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), tool: 'Read', path: `private/${i}.md`, reason: 'Quorum read guard: private/ is private to this Agent OS.' }));
    writeFileSync(log, `${lines.join('\n')}\n{"t": "2026-01-01T`);
    const g = guards();
    const all = g.denials();
    expect(all).toHaveLength(DENIALS_CAP);
    expect(all[0].path).toBe(`private/${DENIALS_CAP + 59}.md`);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(DENIALS_CAP);
    expect(g.denials({ limit: 3 }).map((d) => d.path)).toEqual([259, 258, 257].map((i) => `private/${i}.md`));
    expect(g.denials({ since: new Date(Date.UTC(2026, 0, 1, 0, 0, 257)).toISOString() })).toHaveLength(2);
    expect(g.denials({ since: Date.UTC(2026, 0, 1, 0, 0, 258) })).toHaveLength(1);
  });

  it('reads the rule kind from older lines that carry only the reason', () => {
    expect(denialKindOf({ reason: 'Quorum read guard: this note is marked confidential in its frontmatter.' })).toEqual({ kind: 'frontmatter', match: 'confidential' });
    expect(denialKindOf({ reason: 'Quorum read guard: Board/ is private to this Agent OS.' })).toEqual({ kind: 'path', match: 'Board' });
    expect(denialKindOf({ reason: 'Quorum read guard: that file looks like a secret or credential.' })).toEqual({ kind: 'secret', match: null });
    expect(parseDenialLines('not json\n{"t":"2026-01-01T00:00:00Z","path":"a"}\n')).toHaveLength(1);
  });
});
