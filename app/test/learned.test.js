import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, LEARNED_FILE, LEARNED_OPEN, LEARNED_POINTER, addLearned, createKeeper, learnedChars, learnedLines, pointLearned, pruneLearned } from '../keeper.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const NOTE = (title, date) => `---\ntitle: ${title}\ndate: ${date}T15:00:00-08:00\nparticipants:\n  - Ada Lovelace\nsource: quorum\n---\n\n# ${title}\n\nAda owns the launch page.\n`;
const fact = (text, date) => `- ${text} ([[m-${date}]], ${date})`;

function vault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'learned-'));
  put(dir, '08-meetings/2026-11-10-plan.md', NOTE('Plan', '2026-11-10'));
  put(dir, 'CLAUDE.md', '# Agent OS\n\nRules.\n');
  return dir;
}
const keeperFor = (dir, over = {}) => {
  const settings = { keeper: { on: true, ...(over.keeper ?? {}) }, ...(over.settings ?? {}) };
  return { settings, k: createKeeper({ brain: () => ({ root: dir, vault: dir }), settings, hasModel: () => true, runText: async () => '- Ada owns the launch page', errorLog: over.errorLog ?? null, ...(over.opts ?? {}) }) };
};

describe('learned facts budget', () => {
  it('drops the oldest dated lines first, never a #keep line, then hand-written lines', () => {
    const lines = [fact('old', '2026-01-01'), '- written by hand', `${fact('kept', '2025-01-01')} #keep`, fact('newer', '2026-06-01'), fact('newest', '2026-11-01')];
    const budget = learnedChars(lines) - lines[0].length - 1;
    expect(pruneLearned(lines, budget)).toEqual({ kept: lines.slice(1), dropped: [lines[0]] });
    const tight = pruneLearned(lines, 10);
    expect(tight.kept).toEqual([lines[2]]);
    expect(tight.dropped).toHaveLength(4);
    expect(tight.dropped).toContain('- written by hand');
  });
  it('treats a fact cited from another note as the same fact', () => {
    const t = addLearned('# A\n', [`Ada owns the launch page ([[a]], 2026-11-01)`]).text;
    expect(addLearned(t, [`ada owns the launch page ([[b]], 2026-11-02)`])).toBeNull();
  });
  it('keeps the block under the budget and says so in its header', () => {
    const r = addLearned('# A\n', Array.from({ length: 80 }, (_, i) => `fact ${i} about the plan (${'[['}m${i}]], 2026-11-${String((i % 28) + 1).padStart(2, '0')})`), { budget: 1000 });
    expect(learnedChars(learnedLines(r.text))).toBeLessThanOrEqual(1000);
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.text).toContain('stays under 1,000 characters');
    expect(r.text).not.toContain('never rewrites');
  });
  it('turns a CLAUDE.md block into a pointer once', () => {
    const t = addLearned('# A\n', ['x']).text;
    const p = pointLearned(t);
    expect(p).toContain(LEARNED_POINTER);
    expect(learnedLines(p)).toEqual([]);
    expect(pointLearned(p)).toBeNull();
  });
});

describe('keeper learned facts', () => {
  it('writes a recoverable changelog line for every pruned fact', async () => {
    const dir = vault();
    const old = Array.from({ length: 30 }, (_, i) => fact(`older fact ${i} from a planning session`, `2026-0${(i % 9) + 1}-01`));
    put(dir, 'CLAUDE.md', addLearned('# Agent OS\n', old.map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir, { keeper: { factsBudget: 600 } });
    await k.run();
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(learnedChars(learnedLines(claude))).toBeLessThanOrEqual(600);
    expect(claude).toContain('Ada owns the launch page');
    const log = readFileSync(path.join(dir, CHANGELOG), 'utf8');
    const gone = old.filter((l) => !claude.includes(l));
    expect(gone.length).toBeGreaterThan(0);
    for (const l of gone) expect(log).toContain(l);
  });
  it('defaults to .quorum/learned.md when the vault has its own memory and facts are handed to Quorum', async () => {
    const dir = vault();
    put(dir, 'MEMORY.md', '# Memory\n');
    put(dir, 'CLAUDE.md', addLearned('# Agent OS\n\nRules.\n', [fact('earlier fact', '2026-10-01').slice(2)]).text);
    const { k } = keeperFor(dir);
    // the vault owns facts until the user hands them over: nothing is written
    expect(k.status().plugins.find((p) => p.id === 'facts').owner).toBe('vault');
    await k.run();
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
    expect(learnedLines(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'))).toHaveLength(1);
    // handed over: the list moves to the file Claude Code does not load, and CLAUDE.md points at it
    k.setPlugin('facts', 'quorum');
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k.run();
    const learned = readFileSync(path.join(dir, LEARNED_FILE), 'utf8');
    expect(learned).toContain('earlier fact');
    expect(learned).toContain('Ada owns the launch page');
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain(LEARNED_POINTER);
    expect(claude).toContain('Rules.');
    expect(k.status().learned).toMatchObject({ target: 'learned', file: '.quorum/learned.md' });
  });
  it('logs a failed facts call to the error file and counts it', async () => {
    const dir = vault();
    const errorLog = path.join(mkdtempSync(path.join(tmpdir(), 'learned-log-')), 'keeper-errors.log');
    const { k } = keeperFor(dir, { errorLog, opts: { runText: async () => { throw new Error('model unavailable'); } } });
    const r = await k.run();
    expect(r.filed).toBe(1);
    expect(k.status().errors).toMatchObject({ count: 1, last: { where: 'facts', message: 'model unavailable' } });
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).not.toContain(LEARNED_OPEN);
  });
});
