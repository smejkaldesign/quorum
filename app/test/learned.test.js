import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, CLAUDE_BUDGET, CLAUDE_FACTS, LEARNED_BUDGET, LEARNED_FILE, LEARNED_HEADER, LEARNED_OPEN, LEARNED_POINTER, NOTE_LINK, addLearned, createKeeper, defaultNote, factKey, informative, learnedChars, learnedLines, notePath, parseFacts, pointLearned, pruneLearned } from '../keeper.js';

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
    // the same fact confirmed later keeps one line with the newer citation; an older one changes nothing
    const again = addLearned(t, [`ada owns the launch page ([[b]], 2026-11-02)`]).text;
    expect(learnedLines(again)).toEqual(['- Ada owns the launch page ([[b]], 2026-11-02)']);
    expect(addLearned(again, [`Ada owns the launch page ([[c]], 2026-10-01)`])).toBeNull();
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

describe('learned facts, review round 2', () => {
  it('keys facts in any script, so distinct non-Latin facts stay apart and width variants match', () => {
    expect(factKey('- Анна ведёт дизайн')).not.toBe(factKey('- Борис ведёт дизайн'));
    expect(factKey('- 王芳负责设计')).not.toBe(factKey('- 李雷负责设计'));
    expect(factKey('- Анна ведёт дизайн ([[a]], 2026-11-01)')).toBe(factKey('- анна ведёт дизайн!'));
    expect(factKey('- ＡＢＣ ships Friday')).toBe(factKey('- abc ships friday'));
    const t = addLearned('# A\n', ['Анна ведёт дизайн', 'Борис ведёт дизайн', '王芳负责设计', '李雷负责设计']).text;
    expect(learnedLines(t)).toHaveLength(4);
  });
  it('never drops a fact in the call that adds it because its meeting is old', () => {
    const lines = [fact('first newer fact here', '2026-11-01'), fact('second newer fact', '2026-11-02')];
    const t = addLearned('# A\n', lines.map((l) => l.slice(2)), { budget: 10000 }).text;
    const old = fact('a fact from an old meeting', '2025-01-01');
    const r = addLearned(t, [old.slice(2)], { budget: learnedChars([lines[1], old]) });
    expect(learnedLines(r.text)).toEqual([lines[1], old]);
    expect(r.dropped).toEqual([lines[0]]);
  });
  it('leaves CLAUDE.md alone and logs it when learned.md cannot be written', async () => {
    const dir = vault();
    const claude = addLearned('# Agent OS\n', [fact('earlier fact', '2026-10-01').slice(2)]).text;
    put(dir, 'CLAUDE.md', claude);
    put(dir, LEARNED_FILE, '<!-- generated by memory-sync -->\n# Learned\n');
    const errorLog = path.join(mkdtempSync(path.join(tmpdir(), 'learned-log-')), 'keeper-errors.log');
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'learned' }, errorLog });
    await k.run();
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(claude);
    expect(k.status().errors.last).toMatchObject({ where: 'facts' });
    expect(existsSync(path.join(dir, CHANGELOG)) ? readFileSync(path.join(dir, CHANGELOG), 'utf8') : '').not.toContain('CLAUDE.md');
  });
  it('makes a short CLAUDE.md for the pointer when there is none', async () => {
    const dir = vault();
    rmSync(path.join(dir, 'CLAUDE.md'));
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'learned' } });
    await k.run();
    expect(readFileSync(path.join(dir, LEARNED_FILE), 'utf8')).toContain(LEARNED_HEADER);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(LEARNED_POINTER);
  });
  it('moves the list back into CLAUDE.md when the user picks it, and removes the pointer', async () => {
    const dir = vault();
    const { k, settings } = keeperFor(dir, { keeper: { factsTarget: 'learned' } });
    await k.run();
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(LEARNED_POINTER);
    k.set({ factsTarget: 'claude' });
    expect(settings.keeper.factsTarget).toBe('claude');
    const claude = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(claude).not.toContain(LEARNED_POINTER);
    expect(learnedLines(claude)[0]).toContain('Ada owns the launch page');
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
  });
  it('settles the automatic file once and suggests a switch instead of moving facts', async () => {
    const dir = vault();
    const { k } = keeperFor(dir);
    await k.run();
    expect(learnedLines(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'))).toHaveLength(1);
    // the vault gains its own memory and the facts row stays with Quorum
    put(dir, 'MEMORY.md', '# Memory\n');
    k.setPlugin('facts', 'quorum');
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k.run();
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
    expect(k.status().learned).toMatchObject({ target: 'claude', pick: 'auto', auto: 'claude', suggest: 'learned' });
  });
  it('trims at once when the budget is lowered, with the dropped lines in the changelog', async () => {
    const dir = vault();
    const old = Array.from({ length: 20 }, (_, i) => fact(`older fact ${i} from a planning session`, '2026-09-01'));
    put(dir, 'CLAUDE.md', addLearned('# Agent OS\n', old.map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k, settings } = keeperFor(dir);
    await k.run();
    k.set({ factsBudget: 500 });
    expect(learnedChars(learnedLines(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')))).toBeLessThanOrEqual(500);
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain(old[0]);
    // only the changed field is saved
    expect(settings.keeper).toEqual({ on: true, factsBudget: 500 });
  });
  it('keeps the error log small and clears it', async () => {
    const dir = vault();
    const errorLog = path.join(mkdtempSync(path.join(tmpdir(), 'learned-log-')), 'keeper-errors.log');
    writeFileSync(errorLog, Array.from({ length: 1000 }, (_, i) => JSON.stringify({ at: 'x', where: 'run', message: `old ${i} ${'x'.repeat(100)}` })).join('\n') + '\n');
    const { k } = keeperFor(dir, { errorLog, opts: { runText: async () => { throw new Error('model unavailable'); } } });
    await k.run();
    expect(readFileSync(errorLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(200);
    expect(k.status().errors).toMatchObject({ count: 200, last: { message: 'model unavailable' } });
    expect(k.clearErrors().errors.count).toBe(0);
  });
});

describe('facts that carry nothing', () => {
  it('leaves out lines that only say a note is empty or holds no decisions', () => {
    for (const f of [
      'The note records no decisions, commitments, or summary.',
      'The meeting note is empty.',
      'This transcript appears to be blank',
      'No decisions were made.',
      'There were no action items',
      'No clear next steps recorded',
      'The meeting had no action items or decisions',
      'Empty note',
      'none',
      'N/A',
      'Nothing to note',
      'See notes',
      'TBD',
    ]) expect(informative(f), f).toBe(false);
  });
  it('keeps facts that say something, in any script', () => {
    for (const f of [
      'Ada owns the launch page',
      'Ship in Q1',
      'No new hires until the March review, says Bo',
      'Nothing ships before the security review is done',
      'The pricing note moves to Friday',
      '王芳负责设计',
      'Анна ведёт дизайн',
    ]) expect(informative(f), f).toBe(true);
  });
  it('filters before the list is deduplicated, so an empty fact never reaches the file', async () => {
    expect(parseFacts('- The note records no decisions, commitments, or summary.\n- Ada owns the launch page\n- No action items')).toEqual(['Ada owns the launch page']);
    const dir = vault();
    const { k } = keeperFor(dir, { opts: { runText: async () => '- The note records no decisions, commitments, or summary.\n- The meeting note is empty.' } });
    await k.run();
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n\nRules.\n');
  });
});

describe('learned facts budget by target', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => fact(`fact ${i} about the plan`, '2026-09-01'));
  it('keeps CLAUDE.md to 10 facts or 800 characters by default, whichever is smaller', async () => {
    const dir = vault();
    put(dir, 'CLAUDE.md', addLearned('# Agent OS\n', many(20).map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir);
    await k.run();
    const lines = learnedLines(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'));
    expect(lines).toHaveLength(CLAUDE_FACTS);
    expect(lines.at(-1)).toContain('Ada owns the launch page');
    expect(k.status().learned).toMatchObject({ target: 'claude', budget: CLAUDE_BUDGET, maxFacts: CLAUDE_FACTS, budgetPick: 'auto' });
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain(many(20)[0]);
    // long lines reach the character limit before the line limit
    const long = Array.from({ length: 8 }, (_, i) => `fact ${i} ${'about the long planning session '.repeat(4)}`);
    const r = addLearned('# A\n', long, { budget: CLAUDE_BUDGET, maxLines: CLAUDE_FACTS });
    expect(learnedLines(r.text).length).toBeLessThan(8);
    expect(learnedChars(learnedLines(r.text))).toBeLessThanOrEqual(CLAUDE_BUDGET);
    expect(r.text).toContain('stays under 800 characters and 10 lines');
  });
  it('keeps 2,000 characters in the other targets, and an explicit budget wins in CLAUDE.md', async () => {
    const dir = vault();
    put(dir, LEARNED_FILE, addLearned(LEARNED_HEADER, many(20).map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'learned' } });
    await k.run();
    expect(learnedLines(readFileSync(path.join(dir, LEARNED_FILE), 'utf8'))).toHaveLength(21);
    expect(k.status().learned).toMatchObject({ budget: LEARNED_BUDGET, maxFacts: null });
    const dir2 = vault();
    put(dir2, 'CLAUDE.md', addLearned('# Agent OS\n', many(20).map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k: k2 } = keeperFor(dir2, { keeper: { factsBudget: 2000 } });
    await k2.run();
    expect(learnedLines(readFileSync(path.join(dir2, 'CLAUDE.md'), 'utf8'))).toHaveLength(21);
    expect(k2.status().learned).toMatchObject({ budget: 2000, maxFacts: null, budgetPick: 2000 });
    k2.set({ factsBudget: 'auto' });
    expect(learnedLines(readFileSync(path.join(dir2, 'CLAUDE.md'), 'utf8'))).toHaveLength(CLAUDE_FACTS);
  });
});

describe('learned facts in a vault note', () => {
  it('picks 05-knowledge when the folder exists, else the vault root, and checks typed paths', () => {
    const dir = vault();
    expect(defaultNote(dir)).toBe('quorum-learned.md');
    mkdirSync(path.join(dir, '05-knowledge'));
    expect(defaultNote(dir)).toBe('05-knowledge/quorum-learned.md');
    expect(notePath('notes/facts')).toBe('notes/facts.md');
    expect(notePath('./05-knowledge/facts.md')).toBe('05-knowledge/facts.md');
    for (const bad of ['', '/etc/x.md', '../out.md', 'a/../../b.md', '.quorum/x.md', 'CLAUDE.md', 'index.md', 'C:\\x.md']) expect(notePath(bad), bad).toBeNull();
  });
  it('leaves CLAUDE.md unchanged, appends facts to the note, links it from index.md and writes the changelog entry', async () => {
    const dir = vault();
    mkdirSync(path.join(dir, '05-knowledge'));
    const note = '05-knowledge/quorum-learned.md';
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note' } });
    await k.run();
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n\nRules.\n');
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
    const text = readFileSync(path.join(dir, note), 'utf8');
    expect(text.startsWith(LEARNED_HEADER)).toBe(true);
    expect(learnedLines(text)).toEqual(['- Ada owns the launch page ([[2026-11-10-plan]], 2026-11-10)']);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain(`- [[quorum-learned]] - ${NOTE_LINK}`);
    const log = readFileSync(path.join(dir, CHANGELOG), 'utf8');
    expect(log).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} Plan\n\n- index\.md\n- 05-knowledge\/quorum-learned\.md\n\n/);
    expect(log).not.toContain('CLAUDE.md');
    // a second meeting appends to the note, and the index link is not repeated
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    const { k: k2 } = keeperFor(dir, { keeper: { factsTarget: 'note' }, opts: { runText: async () => '- Bo owns pricing from December' } });
    await k2.run();
    expect(learnedLines(readFileSync(path.join(dir, note), 'utf8'))).toHaveLength(2);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8').match(/quorum-learned/g)).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n\nRules.\n');
    expect(k2.status().learned).toMatchObject({ target: 'note', file: note, note, linked: true, budget: LEARNED_BUDGET });
  });
  it('writes pruned lines into the changelog the same way', async () => {
    const dir = vault();
    const old = Array.from({ length: 30 }, (_, i) => fact(`older fact ${i} from a planning session`, '2026-09-01'));
    put(dir, 'quorum-learned.md', addLearned(LEARNED_HEADER, old.map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note', factsBudget: 600 } });
    await k.run();
    const log = readFileSync(path.join(dir, CHANGELOG), 'utf8');
    expect(log).toContain('Moved out of the learned facts to stay under the budget');
    expect(log).toContain(old[0]);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n\nRules.\n');
  });
  it('never writes to an index the vault keeps or one marked generated', async () => {
    const dir = vault();
    put(dir, 'index.md', '<!-- generated by wiki-index -->\n# Index\n');
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note' } });
    await k.run();
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe('<!-- generated by wiki-index -->\n# Index\n');
    expect(learnedLines(readFileSync(path.join(dir, 'quorum-learned.md'), 'utf8'))).toHaveLength(1);
    expect(k.status().learned.linked).toBe(false);
    const dir2 = vault();
    put(dir2, 'index.md', '# Index\n');
    put(dir2, 'scripts/build-index.py', 'print(1)\n');
    const { k: k2 } = keeperFor(dir2, { keeper: { factsTarget: 'note' } });
    expect(k2.status().plugins.find((p) => p.id === 'index').owner).toBe('vault');
    await k2.run();
    expect(readFileSync(path.join(dir2, 'index.md'), 'utf8')).toBe('# Index\n');
    expect(learnedLines(readFileSync(path.join(dir2, 'quorum-learned.md'), 'utf8'))).toHaveLength(1);
  });
  it('moves the facts between CLAUDE.md, the note and another note path', async () => {
    const dir = vault();
    put(dir, 'CLAUDE.md', addLearned('# Agent OS\n\nRules.\n', [fact('earlier fact about pricing', '2026-10-01').slice(2)]).text);
    const { k, settings } = keeperFor(dir);
    k.set({ factsTarget: 'note' });
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n\nRules.\n');
    expect(readFileSync(path.join(dir, 'quorum-learned.md'), 'utf8')).toContain('earlier fact about pricing');
    await k.run();
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('[[quorum-learned]]');
    // another path: the list moves, and the old note, which held only the list, goes with its index line
    k.set({ factsNote: 'notes/facts' });
    expect(settings.keeper.factsNote).toBe('notes/facts.md');
    expect(existsSync(path.join(dir, 'quorum-learned.md'))).toBe(false);
    const moved = learnedLines(readFileSync(path.join(dir, 'notes/facts.md'), 'utf8'));
    expect(moved).toHaveLength(2);
    const index = readFileSync(path.join(dir, 'index.md'), 'utf8');
    expect(index).toContain('[[facts]]');
    expect(index).not.toContain('[[quorum-learned]]');
    // a path in the meetings folder is refused
    k.set({ factsNote: '08-meetings/facts.md' });
    expect(settings.keeper.factsNote).toBe('notes/facts.md');
    // back into CLAUDE.md
    k.set({ factsTarget: 'claude' });
    expect(learnedLines(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'))).toEqual(moved);
    expect(existsSync(path.join(dir, 'notes/facts.md'))).toBe(false);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).not.toContain('[[facts]]');
  });
  it('keeps the text of a note the user writes in, and takes out only the list', async () => {
    const dir = vault();
    put(dir, 'mine.md', '# Mine\n\nMy own text.\n');
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note', factsNote: 'mine.md' } });
    await k.run();
    expect(readFileSync(path.join(dir, 'mine.md'), 'utf8')).toContain('My own text.');
    expect(learnedLines(readFileSync(path.join(dir, 'mine.md'), 'utf8'))).toHaveLength(1);
    k.set({ factsTarget: 'learned' });
    expect(readFileSync(path.join(dir, 'mine.md'), 'utf8')).toBe('# Mine\n\nMy own text.\n');
    expect(learnedLines(readFileSync(path.join(dir, LEARNED_FILE), 'utf8'))).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(LEARNED_POINTER);
  });
});
