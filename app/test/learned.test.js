import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, CREATE_LIMIT, CLAUDE_BUDGET, CLAUDE_FACTS, LEARNED_BUDGET, LEARNED_FILE, LEARNED_HEADER, LEARNED_OPEN, LEARNED_POINTER, COPY_NOTE, NOTE_LINK, addLearned, claudeCopy, createKeeper, defaultNote, factKey, informative, learnedChars, learnedLines, notePath, parseFacts, pruneLearned } from '../keeper.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const NOTE = (title, date) => `---\ntitle: ${title}\ndate: ${date}T15:00:00-08:00\nparticipants:\n  - Ada Lovelace\nsource: quorum\n---\n\n# ${title}\n\nAda owns the launch page.\n`;
const fact = (text, date) => `- ${text} ([[m-${date}]], ${date})`;
const RULES = '# Agent OS\n\nRules.\n';
const text = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');

function vault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'learned-'));
  put(dir, '08-meetings/2026-11-10-plan.md', NOTE('Plan', '2026-11-10'));
  put(dir, 'CLAUDE.md', '# Agent OS\n\nRules.\n');
  return dir;
}
// a saved choice that leaves the index job with the vault
const VAULT_INDEX = { index: { owner: 'vault' } };
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
  it('copies only the newest facts that say something into the CLAUDE.md copy, with no blank lines', () => {
    const lines = [...Array.from({ length: 15 }, (_, i) => fact(`fact ${i} about the plan`, '2026-09-01')), '- The note records no decisions', '- none'];
    const block = claudeCopy(lines, '.quorum/learned.md');
    expect(learnedLines(block)).toEqual(lines.slice(5, 15));
    expect(block).toContain(COPY_NOTE);
    expect(block.split('\n').filter((l) => !l.trim())).toEqual([]);
    const long = Array.from({ length: 8 }, (_, i) => `- fact ${i} ${'about the long planning session '.repeat(4)}`);
    const cut = learnedLines(claudeCopy(long, 'x.md'));
    expect(cut.length).toBeLessThan(8);
    expect(learnedChars(cut)).toBeLessThanOrEqual(CLAUDE_BUDGET);
    expect(claudeCopy(['- none', '- The meeting had no action items'], 'x.md')).toBeNull();
  });
});

describe('keeper learned facts', () => {
  it('writes a recoverable changelog line for every pruned fact', async () => {
    const dir = vault();
    const old = Array.from({ length: 30 }, (_, i) => fact(`older fact ${i} from a planning session`, `2026-0${(i % 9) + 1}-01`));
    put(dir, LEARNED_FILE, addLearned(LEARNED_HEADER, old.map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir, { keeper: { factsBudget: 600 } });
    await k.run();
    const learned = text(dir, LEARNED_FILE);
    expect(learnedChars(learnedLines(learned))).toBeLessThanOrEqual(600);
    expect(learned).toContain('Ada owns the launch page');
    const log = text(dir, CHANGELOG);
    const gone = old.filter((l) => !learned.includes(l));
    expect(gone.length).toBeGreaterThan(0);
    for (const l of gone) expect(log).toContain(l);
    expect(text(dir, 'CLAUDE.md')).toBe(RULES);
  });
  it('keeps facts in .quorum/learned.md and leaves a list already in CLAUDE.md as it is', async () => {
    const dir = vault();
    const before = addLearned(RULES, [fact('earlier fact', '2026-10-01').slice(2)]).text;
    put(dir, 'CLAUDE.md', before);
    const { k } = keeperFor(dir, { settings: { plugins: { facts: { owner: 'vault' } } } });
    // a saved vault owner keeps facts off until the user hands them over: nothing is written
    expect(k.status().plugins.find((p) => p.id === 'facts').owner).toBe('vault');
    await k.run();
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
    k.setPlugin('facts', 'quorum');
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k.run();
    const learned = text(dir, LEARNED_FILE);
    expect(learned).toContain('Ada owns the launch page');
    expect(learned).not.toContain('earlier fact');
    expect(text(dir, 'CLAUDE.md')).toBe(before);
    expect(k.status().learned).toMatchObject({ target: 'learned', file: '.quorum/learned.md', claude: { on: false, block: 'list', lines: 1 } });
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
  it('makes no CLAUDE.md while the copy is off, and a short one for the copy once it is on', async () => {
    const dir = vault();
    rmSync(path.join(dir, 'CLAUDE.md'));
    const { k } = keeperFor(dir);
    await k.run();
    expect(text(dir, LEARNED_FILE)).toContain(LEARNED_HEADER);
    expect(existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
    k.set({ factsInClaude: true });
    const claude = text(dir, 'CLAUDE.md');
    expect(claude).toContain(COPY_NOTE);
    expect(learnedLines(claude)).toEqual(learnedLines(text(dir, LEARNED_FILE)));
  });
  it('with the copy on, takes a CLAUDE.md list into .quorum/learned.md once and keeps the copy current', async () => {
    const dir = vault();
    put(dir, 'CLAUDE.md', addLearned(RULES, [fact('earlier fact about pricing', '2026-10-01').slice(2)]).text);
    const { k } = keeperFor(dir, { keeper: { factsInClaude: true, editVault: true } });
    await k.run();
    const learned = learnedLines(text(dir, LEARNED_FILE));
    expect(learned).toHaveLength(2);
    let claude = text(dir, 'CLAUDE.md');
    expect(claude).toContain('Rules.');
    expect(claude).toContain(COPY_NOTE);
    expect(learnedLines(claude)).toEqual(learned);
    expect(k.status().learned.claude).toMatchObject({ on: true, block: 'copy' });
    // a line deleted from the list is not read back from the copy
    put(dir, LEARNED_FILE, text(dir, LEARNED_FILE).split('\n').filter((l) => !l.includes('pricing')).join('\n'));
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k.run();
    claude = text(dir, 'CLAUDE.md');
    expect(text(dir, LEARNED_FILE)).not.toContain('pricing');
    expect(claude).not.toContain('pricing');
    expect(learnedLines(claude)).toEqual(learnedLines(text(dir, LEARNED_FILE)));
  });
  it('reads a CLAUDE.md pick saved by an earlier version as .quorum/learned.md', async () => {
    const dir = vault();
    const before = addLearned(RULES, [fact('earlier fact', '2026-10-01').slice(2)]).text;
    put(dir, 'CLAUDE.md', before);
    const { k, settings } = keeperFor(dir, { keeper: { factsTarget: 'claude' } });
    await k.run();
    expect(text(dir, 'CLAUDE.md')).toBe(before);
    expect(text(dir, LEARNED_FILE)).toContain('Ada owns the launch page');
    expect(k.status().learned.target).toBe('learned');
    k.set({ factsTarget: 'note' });
    expect(settings.keeper.factsTarget).toBe('note');
    k.set({ factsTarget: 'learned' });
    expect(settings.keeper.factsTarget).toBeUndefined();
  });
  it('trims at once when the budget is lowered, with the dropped lines in the changelog', async () => {
    const dir = vault();
    const old = Array.from({ length: 20 }, (_, i) => fact(`older fact ${i} from a planning session`, '2026-09-01'));
    put(dir, LEARNED_FILE, addLearned(LEARNED_HEADER, old.map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k, settings } = keeperFor(dir);
    await k.run();
    k.set({ factsBudget: 500 });
    expect(learnedChars(learnedLines(text(dir, LEARNED_FILE)))).toBeLessThanOrEqual(500);
    expect(text(dir, CHANGELOG)).toContain(old[0]);
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

describe('the CLAUDE.md copy', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => fact(`fact ${i} about the plan`, '2026-09-01'));
  it('keeps the copy to 10 facts while the list keeps 2,000 characters, and follows a lowered budget', async () => {
    const dir = vault();
    put(dir, LEARNED_FILE, addLearned(LEARNED_HEADER, many(20).map((l) => l.slice(2)), { budget: 10000 }).text);
    const { k } = keeperFor(dir, { keeper: { factsInClaude: true, editVault: true } });
    await k.run();
    expect(learnedLines(text(dir, LEARNED_FILE))).toHaveLength(21);
    expect(k.status().learned).toMatchObject({ budget: LEARNED_BUDGET, budgetPick: 'auto', claude: { on: true, block: 'copy', facts: CLAUDE_FACTS, budget: CLAUDE_BUDGET } });
    const copy = learnedLines(text(dir, 'CLAUDE.md'));
    expect(copy).toHaveLength(CLAUDE_FACTS);
    expect(copy.at(-1)).toContain('Ada owns the launch page');
    k.set({ factsBudget: 1000 });
    const list = learnedLines(text(dir, LEARNED_FILE));
    expect(learnedChars(list)).toBeLessThanOrEqual(1000);
    expect(learnedLines(text(dir, 'CLAUDE.md'))).toEqual(list.slice(-CLAUDE_FACTS));
  });
  it('leaves the copy as it is once it is turned off', async () => {
    const dir = vault();
    const { k, settings } = keeperFor(dir, { keeper: { factsInClaude: true, editVault: true } });
    await k.run();
    k.set({ factsInClaude: false });
    expect(settings.keeper.factsInClaude).toBe(false);
    const claude = text(dir, 'CLAUDE.md');
    expect(claude).toContain(COPY_NOTE);
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12').replace('Ada owns the launch page.', 'Grace runs the pricing review.'));
    await k.run();
    expect(text(dir, 'CLAUDE.md')).toBe(claude);
    expect(k.status().learned.claude).toMatchObject({ on: false, block: 'copy' });
  });
  it('removes only the block from CLAUDE.md when asked, after moving its facts into the list', async () => {
    const dir = vault();
    const before = addLearned(RULES, many(3).map((l) => l.slice(2))).text + '\n## After\n\nMore rules.\n';
    put(dir, 'CLAUDE.md', before);
    const { k } = keeperFor(dir);
    await k.run();
    expect(text(dir, 'CLAUDE.md')).toBe(before);
    expect(k.status().learned.claude).toMatchObject({ block: 'list', lines: 3 });
    const s = await k.removeClaude();
    expect(text(dir, 'CLAUDE.md')).toBe('# Agent OS\n\nRules.\n\n## After\n\nMore rules.\n');
    const list = learnedLines(text(dir, LEARNED_FILE)).join('\n');
    for (const l of many(3)) expect(list).toContain(l);
    expect(list).toContain('Ada owns the launch page');
    expect(text(dir, CHANGELOG)).toContain('Learned facts removed from CLAUDE.md');
    expect(s.learned.claude.block).toBeNull();
    // a pointer from an earlier version goes without moving anything
    const dir2 = vault();
    put(dir2, 'CLAUDE.md', `# A\n\n${LEARNED_POINTER}\n`);
    await keeperFor(dir2).k.removeClaude();
    expect(text(dir2, 'CLAUDE.md')).toBe('# A\n');
    expect(existsSync(path.join(dir2, LEARNED_FILE))).toBe(false);
    // removing the copy turns it off, so the next run does not write it again
    const dir3 = vault();
    const { k: k3, settings } = keeperFor(dir3, { keeper: { factsInClaude: true, editVault: true } });
    await k3.run();
    await k3.removeClaude();
    expect(settings.keeper.factsInClaude).toBe(false);
    expect(text(dir3, 'CLAUDE.md')).toBe(RULES);
    put(dir3, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k3.run();
    expect(text(dir3, 'CLAUDE.md')).toBe(RULES);
  });
  it('leaves CLAUDE.md as it was when the list cannot take its facts', async () => {
    const dir = vault();
    const before = addLearned(RULES, [fact('earlier fact about pricing', '2026-10-01').slice(2)]).text;
    put(dir, 'CLAUDE.md', before);
    put(dir, LEARNED_FILE, '<!-- generated by memory-sync -->\n# Learned\n');
    const errorLog = path.join(mkdtempSync(path.join(tmpdir(), 'learned-log-')), 'keeper-errors.log');
    const { k } = keeperFor(dir, { errorLog });
    await k.removeClaude();
    expect(text(dir, 'CLAUDE.md')).toBe(before);
    expect(k.status().errors.count).toBeGreaterThan(0);
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
    const { k: k2 } = keeperFor(dir2, { keeper: { factsTarget: 'note' }, settings: { plugins: { index: { owner: 'vault' } } } });
    expect(k2.status().plugins.find((p) => p.id === 'index').owner).toBe('vault');
    await k2.run();
    expect(readFileSync(path.join(dir2, 'index.md'), 'utf8')).toBe('# Index\n');
    expect(learnedLines(readFileSync(path.join(dir2, 'quorum-learned.md'), 'utf8'))).toHaveLength(1);
  });
  it('moves the facts between .quorum/learned.md, the note and another note path, and leaves CLAUDE.md alone', async () => {
    const dir = vault();
    const before = addLearned(RULES, [fact('earlier fact about pricing', '2026-10-01').slice(2)]).text;
    put(dir, 'CLAUDE.md', before);
    const { k, settings } = keeperFor(dir);
    await k.run();
    k.set({ factsTarget: 'note' });
    expect(text(dir, 'CLAUDE.md')).toBe(before);
    expect(text(dir, 'quorum-learned.md')).toContain('Ada owns the launch page');
    expect(existsSync(path.join(dir, LEARNED_FILE))).toBe(false);
    await k.run();
    expect(text(dir, 'index.md')).toContain('[[quorum-learned]]');
    // another path: the list moves, and the old note, which held only the list, goes with its index line
    k.set({ factsNote: 'notes/facts' });
    expect(settings.keeper.factsNote).toBe('notes/facts.md');
    expect(existsSync(path.join(dir, 'quorum-learned.md'))).toBe(false);
    const moved = learnedLines(text(dir, 'notes/facts.md'));
    expect(moved).toHaveLength(1);
    const index = text(dir, 'index.md');
    expect(index).toContain('[[facts]]');
    expect(index).not.toContain('[[quorum-learned]]');
    // a path in the meetings folder is refused
    k.set({ factsNote: '08-meetings/facts.md' });
    expect(settings.keeper.factsNote).toBe('notes/facts.md');
    // back into .quorum/learned.md
    k.set({ factsTarget: 'learned' });
    expect(learnedLines(text(dir, LEARNED_FILE))).toEqual(moved);
    expect(existsSync(path.join(dir, 'notes/facts.md'))).toBe(false);
    expect(text(dir, 'index.md')).not.toContain('[[facts]]');
    expect(text(dir, 'CLAUDE.md')).toBe(before);
  });
  it('keeps the text of a note the user writes in, and takes out only the list', async () => {
    const dir = vault();
    put(dir, 'mine.md', '# Mine\n\nMy own text.\n');
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note', factsNote: 'mine.md', editVault: true } });
    await k.run();
    expect(readFileSync(path.join(dir, 'mine.md'), 'utf8')).toContain('My own text.');
    expect(learnedLines(readFileSync(path.join(dir, 'mine.md'), 'utf8'))).toHaveLength(1);
    k.set({ factsTarget: 'learned' });
    expect(readFileSync(path.join(dir, 'mine.md'), 'utf8')).toBe('# Mine\n\nMy own text.\n');
    expect(learnedLines(readFileSync(path.join(dir, LEARNED_FILE), 'utf8'))).toHaveLength(1);
    expect(text(dir, 'CLAUDE.md')).toBe(RULES);
  });
});

describe('learned facts, review fixes', () => {

  it('goes back to the default note when the path is cleared, and moves the facts there', async () => {
    const dir = vault();
    mkdirSync(path.join(dir, '05-knowledge'));
    const { k, settings } = keeperFor(dir, { keeper: { factsTarget: 'note', factsNote: 'notes/facts.md' } });
    await k.run();
    expect(learnedLines(readFileSync(path.join(dir, 'notes/facts.md'), 'utf8'))).toHaveLength(1);
    k.set({ factsNote: '' });
    expect(settings.keeper.factsNote).toBeUndefined();
    expect(existsSync(path.join(dir, 'notes/facts.md'))).toBe(false);
    expect(learnedLines(readFileSync(path.join(dir, '05-knowledge/quorum-learned.md'), 'utf8'))).toHaveLength(1);
    expect(k.status().learned.note).toBe('05-knowledge/quorum-learned.md');
  });
  it('never reads from or removes a generated .quorum/learned.md', async () => {
    const gen = '<!-- generated by memory-sync -->\n# Learned\n\n<!-- quorum:learned -->\n- a line the tool owns\n<!-- /quorum:learned -->\n';
    for (const keeper of [{ factsTarget: 'note' }, { factsInClaude: true, editVault: true }]) {
      const dir = vault();
      put(dir, LEARNED_FILE, gen);
      const { k } = keeperFor(dir, { keeper });
      await k.run();
      expect(text(dir, LEARNED_FILE)).toBe(gen);
      if (keeper.factsTarget) {
        const lines = learnedLines(text(dir, 'quorum-learned.md')).join('\n');
        expect(lines).not.toContain('a line the tool owns');
        expect(lines).toContain('Ada owns the launch page');
      } else expect(text(dir, 'CLAUDE.md')).toBe(RULES);
    }
  });
  it('refuses a note path in the meetings folder whatever its case or spelling', () => {
    const dir = vault();
    const { k, settings } = keeperFor(dir, { keeper: { factsTarget: 'note' } });
    for (const p of ['08-meetings/facts.md', '08-Meetings/facts.md', './08-MEETINGS/facts', '08-meetings\\facts.md']) {
      k.set({ factsNote: p });
      expect(settings.keeper.factsNote, p).toBeUndefined();
    }
  });
  it('keeps real facts that start like an empty one', () => {
    for (const f of ['Acme has no SOC 2 report', 'None of the vendors met the SLA', 'The meeting has no budget for contractors this year', 'No decisions on pricing until the board meets in March', 'The note lists no owner for the migration, so Bo takes it'])
      expect(informative(f), f).toBe(true);
  });
  it('counts the vault note in a held run and creates neither it nor an index line until allowed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'learned-held-'));
    put(dir, 'CLAUDE.md', '# Agent OS\n');
    mkdirSync(path.join(dir, '01-daily'));
    for (let i = 1; i <= CREATE_LIMIT; i++) { const d = `2026-10-${String(i).padStart(2, '0')}`; put(dir, `08-meetings/${d}-m.md`, NOTE(`M${i}`, d)); }
    const calls = [];
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note' }, opts: { runText: async (p) => { calls.push(p); return '- Ada owns the launch page'; } } });
    const r = await k.run();
    expect(r.held.count).toBe(CREATE_LIMIT + 2);
    expect(existsSync(path.join(dir, 'quorum-learned.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'index.md'))).toBe(false);
    expect(calls).toHaveLength(0);
    await k.run({ allowCreate: true });
    expect(calls).toHaveLength(CREATE_LIMIT);
    expect(learnedLines(readFileSync(path.join(dir, 'quorum-learned.md'), 'utf8'))).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('[[quorum-learned]]');
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Agent OS\n');
  });
  it('says the note is linked while Quorum owns the index, before index.md exists', () => {
    const dir = vault();
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note' } });
    expect(k.status().learned).toMatchObject({ linked: true, indexGenerated: false });
    const dir2 = vault();
    expect(keeperFor(dir2, { keeper: { factsTarget: 'note' }, settings: { plugins: VAULT_INDEX } }).k.status().learned).toMatchObject({ linked: false, indexGenerated: false });
  });
});

describe('a vault that generates its own index.md', () => {
  const GEN = '<!-- generated -->\n# Index\n\n- [[a]] - a page\n';
  function wikiVault() {
    const dir = vault();
    put(dir, 'index.md', GEN);
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    return dir;
  }
  it('leaves index.md unchanged and logs the skip once per run', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    expect(k.status().plugins.find((p) => p.id === 'index').owner).toBe('vault');
    const r = await k.run();
    expect(r.filed).toBe(2);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe(GEN);
    const log = readFileSync(path.join(dir, CHANGELOG), 'utf8');
    expect(log.match(/Index skipped/g)).toHaveLength(1);
    expect(log).toContain('index.md is kept by your Agent OS, so the keeper leaves it unchanged and writes no meeting index lines.');
    // the facts and the rest still run
    expect(learnedLines(text(dir, LEARNED_FILE))).toHaveLength(1);
    // a run with nothing to file logs nothing
    await k.run();
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8').match(/Index skipped/g)).toHaveLength(1);
  });
  it('with nothing saved, leaves a generated index.md alone and makes no meetings index', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir);
    expect(k.status().plugins.find((p) => p.id === 'index').owner).toBe('quorum');
    await k.run();
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe(GEN);
    expect(existsSync(path.join(dir, '08-meetings/index.md'))).toBe(false);
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('index.md is marked as generated');
  });
  it('logs the skip when Quorum owns the index job but index.md is marked generated', async () => {
    const dir = vault();
    put(dir, 'index.md', GEN);
    const { k } = keeperFor(dir, { settings: { plugins: {} } });
    k.setPlugin('index', 'quorum');
    await k.run();
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe(GEN);
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('index.md is marked as generated, so the keeper leaves it unchanged and writes no meeting index lines.');
  });
  it('writes the index lines to the meetings folder index when turned on', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    expect(k.status().meetingsIndex).toBe(false);
    k.set({ meetingsIndex: true });
    expect(k.status().meetingsIndex).toBe(true);
    await k.run();
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe(GEN);
    const mi = readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8');
    expect(mi).toContain('- [[2026-11-10-plan]] - meeting 2026-11-10: Plan');
    expect(mi).toContain('- [[2026-11-11-review]] - meeting 2026-11-11: Review');
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('Meeting index lines go to 08-meetings/index.md.');
  });
  it('leaves a generated meetings index alone and counts a missing one in the create limit', async () => {
    const dir = wikiVault();
    put(dir, '08-meetings/index.md', GEN);
    const { k } = keeperFor(dir, { keeper: { meetingsIndex: true }, settings: { plugins: VAULT_INDEX } });
    await k.run();
    expect(readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8')).toBe(GEN);
    const dir2 = mkdtempSync(path.join(tmpdir(), 'learned-mi-held-'));
    put(dir2, 'index.md', GEN);
    mkdirSync(path.join(dir2, '01-daily'));
    for (let i = 1; i <= CREATE_LIMIT; i++) { const d = `2026-10-${String(i).padStart(2, '0')}`; put(dir2, `08-meetings/${d}-m.md`, NOTE(`M${i}`, d)); }
    const { k: k2 } = keeperFor(dir2, { keeper: { meetingsIndex: true }, settings: { plugins: VAULT_INDEX } });
    const r = await k2.run();
    expect(r.held.count).toBe(CREATE_LIMIT + 1);
    expect(existsSync(path.join(dir2, '08-meetings/index.md'))).toBe(false);
  });
});

describe('learned facts, review round 3', () => {
  const state = (dir) => JSON.parse(readFileSync(path.join(dir, '.quorum/keeper.json'), 'utf8'));
  it('keeps a settings reset made while a run is going', async () => {
    const dir = vault();
    mkdirSync(path.join(dir, '05-knowledge'));
    put(dir, '.quorum/keeper.json', JSON.stringify({ done: {}, factsNoteDefault: 'old.md' }));
    let release;
    let started;
    const asked = new Promise((r) => { started = r; });
    const gate = new Promise((r) => { release = r; });
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note', factsNote: 'notes/facts.md' }, opts: { runText: async () => { started(); await gate; return '- Ada owns the launch page'; } } });
    const running = k.run();
    await asked;
    k.set({ factsNote: '' });
    release();
    await running;
    expect(state(dir).factsNoteDefault).toBe('05-knowledge/quorum-learned.md');
  });
  it('keeps a list where an earlier version wrote it, with no factsNoteDefault in keeper.json', async () => {
    const dir = vault();
    mkdirSync(path.join(dir, '05-knowledge'));
    put(dir, 'old/place.md', addLearned(LEARNED_HEADER, [fact('earlier fact about pricing', '2026-10-01').slice(2)]).text);
    put(dir, '.quorum/keeper.json', JSON.stringify({ done: {}, factsNoteAt: 'old/place.md' }));
    const { k } = keeperFor(dir, { keeper: { factsTarget: 'note' } });
    expect(k.status().learned.note).toBe('old/place.md');
    await k.run();
    expect(learnedLines(readFileSync(path.join(dir, 'old/place.md'), 'utf8'))).toHaveLength(2);
    expect(existsSync(path.join(dir, '05-knowledge/quorum-learned.md'))).toBe(false);
    expect(state(dir).factsNoteDefault).toBe('old/place.md');
  });

  it('reads every verb form of an empty note as empty, and keeps real facts', () => {
    for (const f of ['The notes have no action items', 'The transcript contains none', 'The notes are empty', 'The notes were blank', 'The note appears empty', 'The recording seems to be missing'])
      expect(informative(f), f).toBe(false);
    for (const f of ['Acme has no SOC 2 report', 'None of the vendors met the SLA']) expect(informative(f), f).toBe(true);
  });
  it('ignores quotes, trailing punctuation and a trailing parenthetical', () => {
    for (const f of ['The note is empty;', '"No decisions were made."', '“The meeting note is empty”', 'No action items (meeting cancelled)', 'The notes are empty?', 'There were no decisions:', 'No decisions, (none recorded).'])
      expect(informative(f), f).toBe(false);
    expect(informative('Bo owns pricing (from December)')).toBe(true);
  });
});

describe('meetings index backfill and skip log', () => {
  const GEN = '<!-- generated -->\n# Index\n\n- [[a]] - a page\n';
  function wikiVault() {
    const dir = vault();
    put(dir, 'index.md', GEN);
    return dir;
  }
  it('fills the meetings index with the meetings filed before it was turned on, once', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    await k.run();
    expect(existsSync(path.join(dir, '08-meetings/index.md'))).toBe(false);
    k.set({ meetingsIndex: true });
    await k.run();
    const mi = readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8');
    expect(mi).toContain('- [[2026-11-10-plan]] - meeting 2026-11-10: Plan');
    const log = readFileSync(path.join(dir, CHANGELOG), 'utf8');
    expect(log).toContain('Meetings index\n\n- 08-meetings/index.md');
    expect(log).toContain('Meeting index lines go to 08-meetings/index.md.');
    // once: a line taken out by hand is not put back by the next run
    put(dir, '08-meetings/index.md', '# Meetings\n');
    await k.run();
    expect(readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8')).toBe('# Meetings\n');
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toBe(GEN);
  });
  it('leaves a generated meetings index alone during the backfill', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    await k.run();
    put(dir, '08-meetings/index.md', GEN);
    k.set({ meetingsIndex: true });
    await k.run();
    expect(readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8')).toBe(GEN);
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('08-meetings/index.md is marked as generated too, so no meeting index lines were written.');
  });
  it('holds the backfill with the rest of a held run', async () => {
    const dir = wikiVault();
    mkdirSync(path.join(dir, '01-daily'));
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    await k.run();
    k.set({ meetingsIndex: true });
    for (let i = 1; i <= CREATE_LIMIT; i++) { const d = `2026-10-${String(i).padStart(2, '0')}`; put(dir, `08-meetings/${d}-m.md`, NOTE(`M${i}`, d)); }
    const r = await k.run();
    expect(r.held.count).toBe(CREATE_LIMIT + 1);
    expect(existsSync(path.join(dir, '08-meetings/index.md'))).toBe(false);
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('Meeting index lines wait for 08-meetings/index.md, which the held run has not created yet.');
    await k.run({ allowCreate: true });
    const mi = readFileSync(path.join(dir, '08-meetings/index.md'), 'utf8');
    expect(mi).toContain('[[2026-11-10-plan]]');
    expect(mi).toContain('[[2026-10-01-m]]');
  });
  it('logs the skip once per change of where the lines go', async () => {
    const dir = wikiVault();
    const { k } = keeperFor(dir, { settings: { plugins: VAULT_INDEX } });
    await k.run();
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    await k.run();
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8').match(/Index skipped/g)).toHaveLength(1);
    k.set({ meetingsIndex: true });
    await k.run();
    put(dir, '08-meetings/2026-11-12-later.md', NOTE('Later', '2026-11-12'));
    await k.run();
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8').match(/Index skipped/g)).toHaveLength(2);
  });
});
