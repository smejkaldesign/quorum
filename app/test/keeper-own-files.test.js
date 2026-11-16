import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, INDEX_HEADER, LEARNED_FILE, LEARNED_OPEN, MEETINGS_HEADER, createKeeper, learnedFileIn, learnedLines } from '../keeper.js';
import { plan, writeStarter } from '../starter.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const text = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const NOTE = (title, date, body = 'Ada owns the launch page.') => `---\ntitle: ${title}\ndate: ${date}T15:00:00-08:00\nparticipants:\n  - Ada Lovelace\nsource: quorum\n---\n\n# ${title}\n\n${body}\n`;

// a folder the person made: their own index, daily note, people note, project note and CLAUDE.md
const MINE = {
  'index.md': '# My index\n\n- [[plan]] - my plan\n',
  'CLAUDE.md': '# My rules\n',
  '01-daily/2026-11-10.md': '# 2026-11-10\n\nMy day.\n',
  '02-people/ada-lovelace.md': '# Ada Lovelace\n\nMy notes on Ada.\n',
  '03-projects/launch.md': '# Launch\n\nMy project. The launch page ships soon.\n',
  'notes/mine.md': '# Mine\n\nMy own text.\n',
};
function personVault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'own-files-'));
  for (const [rel, body] of Object.entries(MINE)) put(dir, rel, body);
  put(dir, '08-meetings/2026-11-10-plan.md', NOTE('Plan', '2026-11-10', 'Ada owns the launch page for Launch.'));
  return dir;
}
const keeperFor = (dir, keeper = {}, settings = {}, opts = {}) => {
  const s = { keeper: { on: true, ...keeper }, ...settings };
  return { settings: s, k: createKeeper({ brain: () => ({ root: dir, vault: dir }), settings: s, hasModel: () => true, runText: async () => '- Ada owns the launch page', owner: () => 'Rick Bot', ...opts }) };
};
const state = (dir) => JSON.parse(text(dir, '.quorum/keeper.json'));
const QUORUM = { plugins: { index: { owner: 'quorum' }, daily: { owner: 'quorum' }, links: { owner: 'quorum' }, facts: { owner: 'quorum' } } };

describe('the keeper and files Quorum did not make', () => {
  it('leaves every file the person made as it is, and keeps its lines in files it makes', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, {}, { plugins: { index: { owner: 'quorum' }, daily: { owner: 'quorum' }, links: { owner: 'quorum' }, facts: { owner: 'quorum' } } });
    const r = await k.run();
    expect(r.filed).toBe(1);
    for (const [rel, body] of Object.entries(MINE)) expect(text(dir, rel), rel).toBe(body);
    expect(r.left.sort()).toEqual(['01-daily/2026-11-10.md', '02-people/ada-lovelace.md', '03-projects/launch.md']);
    // the index lines go to the meetings folder index, which Quorum makes
    expect(text(dir, '08-meetings/index.md')).toContain('[[2026-11-10-plan]]');
    expect(text(dir, CHANGELOG)).toContain('Quorum did not make index.md, so the keeper leaves it unchanged. Meeting index lines go to 08-meetings/index.md.');
    expect(text(dir, LEARNED_FILE)).toContain('Ada owns the launch page');
    expect(k.status().editVault).toBe(false);
  });
  it('keeps writing a daily note it made itself', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, {}, { plugins: { daily: { owner: 'quorum' } } });
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    await k.run();
    expect(text(dir, '01-daily/2026-11-12.md')).toContain('[[2026-11-12-sync]]');
    put(dir, '08-meetings/2026-11-12-review.md', NOTE('Review', '2026-11-12'));
    await k.run();
    const daily = text(dir, '01-daily/2026-11-12.md');
    expect(daily).toContain('[[2026-11-12-sync]]');
    expect(daily).toContain('[[2026-11-12-review]]');
    expect(JSON.parse(text(dir, '.quorum/keeper.json')).made).toContain('01-daily/2026-11-12.md');
  });
  it('writes into the files the person made once editVault is on', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, { editVault: true }, { plugins: { index: { owner: 'quorum' }, daily: { owner: 'quorum' }, links: { owner: 'quorum' } } });
    const r = await k.run();
    expect(r.left).toEqual([]);
    expect(text(dir, 'index.md')).toContain('[[2026-11-10-plan]]');
    expect(text(dir, '01-daily/2026-11-10.md')).toContain('[[2026-11-10-plan]]');
    expect(text(dir, '02-people/ada-lovelace.md')).toContain('[[2026-11-10-plan]]');
    expect(text(dir, '03-projects/launch.md')).toContain('[[2026-11-10-plan]]');
    expect(existsSync(path.join(dir, '08-meetings/index.md'))).toBe(false);
  });
  it('puts facts in .quorum/learned.md while the note picked in Settings is one the person made', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, { factsTarget: 'note', factsNote: 'notes/mine.md' }, { plugins: { facts: { owner: 'quorum' } } });
    await k.run();
    expect(text(dir, 'notes/mine.md')).toBe(MINE['notes/mine.md']);
    expect(learnedLines(text(dir, LEARNED_FILE))).toHaveLength(1);
    expect(k.status().learned).toMatchObject({ target: 'learned', noteHeld: true });
    // with editVault on the facts move into the note
    k.set({ editVault: true });
    expect(text(dir, 'notes/mine.md')).toContain('My own text.');
    expect(learnedLines(text(dir, 'notes/mine.md'))).toHaveLength(1);
    expect(k.status().learned).toMatchObject({ target: 'note', noteHeld: false });
  });
  it('writes no CLAUDE.md copy into a CLAUDE.md the person made without editVault', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, { factsInClaude: true }, { plugins: { facts: { owner: 'quorum' } } });
    await k.run();
    expect(text(dir, 'CLAUDE.md')).toBe(MINE['CLAUDE.md']);
    expect(k.status().learned.claude).toMatchObject({ on: true, editable: false });
  });
  it('maintains the files the starter made in a folder Quorum built', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'own-built-'));
    writeStarter(dir, plan({ name: 'Studio', answers: { people: ['Ada Lovelace'], projects: ['Launch'] } }));
    const meetings = plan({ name: 'Studio', answers: {} }).meetings;
    put(dir, `${meetings}/2026-11-10-plan.md`, NOTE('Plan', '2026-11-10', 'Ada owns the launch page for Launch.'));
    const { k, settings } = keeperFor(dir, {}, { brainMade: 'quorum' });
    const r = await k.run();
    expect(settings.keeper.editVault).toBeUndefined();
    expect(r.left).toEqual([]);
    expect(text(dir, 'index.md')).toContain('[[2026-11-10-plan]]');
    const people = Object.keys(plan({ name: 'Studio', answers: { people: ['Ada Lovelace'] } }).files).find((f) => f.endsWith('ada-lovelace.md'));
    expect(text(dir, people)).toContain('[[2026-11-10-plan]]');
    // the same files in a folder the person connected are theirs
    const { k: k2 } = keeperFor(dir, {}, { brainMade: null });
    put(dir, `${meetings}/2026-11-11-sync.md`, NOTE('Sync', '2026-11-11'));
    const r2 = await k2.run();
    expect(text(dir, 'index.md')).not.toContain('[[2026-11-11-sync]]');
    expect(r2.left).toContain(people);
  });
});

describe('keeper review fixes', () => {
  it('proves the files an earlier keeper made from a keeper.json without made, and leaves the rest the person\'s', async () => {
    const dir = personVault();
    // what an earlier keeper left: its own index, meetings index and daily note, and a daily note the person edited
    put(dir, 'index.md', `${INDEX_HEADER}- [[2026-11-01-old]] - meeting 2026-11-01: Old\n`);
    put(dir, '08-meetings/index.md', `${MEETINGS_HEADER}- [[2026-11-01-old]] - meeting 2026-11-01: Old\n`);
    put(dir, '01-daily/2026-11-01.md', '# 2026-11-01\n\n## Meetings\n\n- [[2026-11-01-old]] Old\n');
    put(dir, '01-daily/2026-11-02.md', '# 2026-11-02\n\n## Meetings\n\n- [[2026-11-02-old]] Old\n\nMy own line.\n');
    put(dir, CHANGELOG, '# Changelog\n\n## 2026-11-02 10:00 Old\n\n- index.md\n- 08-meetings/index.md\n- 01-daily/2026-11-01.md\n- 01-daily/2026-11-02.md\n\n');
    put(dir, '.quorum/keeper.json', JSON.stringify({ done: {} }));
    put(dir, '08-meetings/2026-11-01-sync.md', NOTE('Sync', '2026-11-01'));
    put(dir, '08-meetings/2026-11-02-sync.md', NOTE('Second', '2026-11-02'));
    const { k } = keeperFor(dir, {}, QUORUM);
    const r = await k.run();
    expect(state(dir).made).toEqual(expect.arrayContaining(['01-daily/2026-11-01.md', '08-meetings/index.md', 'index.md']));
    expect(state(dir).made).not.toContain('01-daily/2026-11-02.md');
    expect(text(dir, 'index.md')).toContain('[[2026-11-01-sync]]');
    expect(text(dir, '01-daily/2026-11-01.md')).toContain('[[2026-11-01-sync]]');
    expect(text(dir, '01-daily/2026-11-02.md')).not.toContain('[[2026-11-02-sync]]');
    expect(r.left).toContain('01-daily/2026-11-02.md');
  });
  it('fills the meetings index once, so a line the person deletes stays deleted', async () => {
    const dir = personVault();
    put(dir, '08-meetings/2026-11-11-review.md', NOTE('Review', '2026-11-11'));
    const { k } = keeperFor(dir, {}, { plugins: { index: { owner: 'quorum' } } });
    await k.run();
    expect(text(dir, '08-meetings/index.md')).toContain('[[2026-11-11-review]]');
    put(dir, '08-meetings/index.md', text(dir, '08-meetings/index.md').split('\n').filter((l) => !l.includes('2026-11-11-review')).join('\n'));
    await k.run();
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    await k.run();
    const index = text(dir, '08-meetings/index.md');
    expect(index).not.toContain('[[2026-11-11-review]]');
    expect(index).toContain('[[2026-11-12-sync]]');
  });
  it('files again the notes that left lines out once editVault is turned on, without asking for facts twice', async () => {
    const dir = personVault();
    let calls = 0;
    const { k } = keeperFor(dir, {}, QUORUM, { runText: async () => { calls++; return '- Ada owns the launch page'; } });
    await k.run();
    expect(calls).toBe(1);
    expect(text(dir, '02-people/ada-lovelace.md')).toBe(MINE['02-people/ada-lovelace.md']);
    k.set({ editVault: true });
    await k.run();
    expect(text(dir, '02-people/ada-lovelace.md')).toContain('[[2026-11-10-plan]]');
    expect(text(dir, '01-daily/2026-11-10.md')).toContain('[[2026-11-10-plan]]');
    expect(calls).toBe(1);
    expect(state(dir).left).toBeUndefined();
  });
  it('saves the files it made even when the run fails', async () => {
    const dir = personVault();
    mkdirSync(path.join(dir, CHANGELOG), { recursive: true });
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    const { k } = keeperFor(dir, {}, { plugins: { daily: { owner: 'quorum' } } });
    const r = await k.run();
    expect(r.error).toMatch(/EISDIR/);
    const made = ['08-meetings/index.md', '01-daily/2026-11-12.md'].filter((rel) => existsSync(path.join(dir, rel)));
    expect(made.length).toBeGreaterThan(0);
    expect(state(dir).made).toEqual(expect.arrayContaining(made));
  });
  it('removes a CLAUDE.md block whose lines are empty or say nothing, and names them in the changelog', async () => {
    const dir = personVault();
    put(dir, 'CLAUDE.md', `# My rules\n\n${LEARNED_OPEN}\n- !!!\n- The note records no decisions\n- Grace runs the pricing review ([[m]], 2026-11-01)\n<!-- /quorum:learned -->\n`);
    const { k } = keeperFor(dir);
    await k.removeClaude();
    expect(text(dir, 'CLAUDE.md')).toBe('# My rules\n');
    expect(learnedLines(text(dir, LEARNED_FILE)).join('\n')).toContain('Grace runs the pricing review');
    expect(learnedLines(text(dir, LEARNED_FILE)).join('\n')).not.toContain('records no decisions');
    expect(text(dir, CHANGELOG)).toContain('- !!!');
  });
  it('says where the list is the same way the CLI reads it, also while a picked note is held', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, { factsTarget: 'note', factsNote: 'notes/mine.md' }, QUORUM);
    await k.run();
    expect(k.status().learned).toMatchObject({ pick: 'note', target: 'learned', noteHeld: true });
    expect(learnedFileIn(state(dir))).toBe(LEARNED_FILE);
    k.set({ factsNote: 'notes/facts.md' });
    expect(k.status().learned).toMatchObject({ pick: 'note', target: 'note', noteHeld: false });
    expect(learnedFileIn(state(dir))).toBe('notes/facts.md');
    expect(learnedLines(text(dir, learnedFileIn(state(dir))))).toHaveLength(1);
  });
});

describe('junk notes', () => {
  const HAND = (title, body, extra = '') => `---\nquorum_id: q-${title}\ntype: note\ntitle: ${title}\ndate: 2026-11-15T10:00:00-08:00\nparticipants:\n  - Rick Bot (recorder)\nsource: quorum\n${extra}---\n\n# ${title}\n\n${body}\n`;
  const vault = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'junk-'));
    put(dir, '08-meetings/2026-11-15-kjhkjhkjh-q1.md', HAND('kjhkjhkjh', 'twesrtykjhlkij'));
    put(dir, '08-meetings/2026-11-15-pricing-q2.md', HAND('Pricing', 'call Ana re pricing'));
    put(dir, '08-meetings/2026-11-15-voice-q3.md', HAND('asdf', '', 'recorded: true\n'));
    put(dir, '08-meetings/2026-11-15-granola.md', '---\ntitle: asdf\nsource: granola\ntype: note\n---\n\n# asdf\n');
    return dir;
  };

  it('flags only a note Quorum made with no recording and no real words, and does not file it', async () => {
    const dir = vault();
    const { k } = keeperFor(dir, {}, QUORUM);
    const r = await k.run();
    expect(r.junk).toBe(1);
    expect(k.junk().map((j) => j.rel)).toEqual(['08-meetings/2026-11-15-kjhkjhkjh-q1.md']);
    expect(k.junk()[0].reason).toContain('does not read as words');
    expect(state(dir).done['08-meetings/2026-11-15-kjhkjhkjh-q1.md']).toBeUndefined();
    expect(state(dir).done['08-meetings/2026-11-15-pricing-q2.md']).toBeDefined();
  });

  it('never flags a kept note again, and files it on the next run', async () => {
    const dir = vault();
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    k.keepJunk('08-meetings/2026-11-15-kjhkjhkjh-q1.md');
    await k.halt();
    expect(k.junk()).toEqual([]);
    const r = await k.run();
    expect(r.junk).toBeUndefined();
    expect(state(dir).done['08-meetings/2026-11-15-kjhkjhkjh-q1.md']).toBeDefined();
    expect(JSON.parse(text(dir, '.quorum/kept-notes.json'))['q-kjhkjhkjh']).toBeTruthy();
  });

  it('drops a note that is gone from the list and logs the move to the Trash', async () => {
    const dir = vault();
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    k.trashedJunk('08-meetings/2026-11-15-kjhkjhkjh-q1.md', 'kjhkjhkjh');
    rmSync(path.join(dir, '08-meetings/2026-11-15-kjhkjhkjh-q1.md'));
    expect(k.junk()).toEqual([]);
    expect(text(dir, CHANGELOG)).toContain('Moved to the Trash');
  });
});
