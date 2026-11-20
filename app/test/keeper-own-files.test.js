import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, INDEX_HEADER, LEARNED_HEADER, LEARNED_OPEN, MEETINGS_HEADER, createKeeper, keeperHome, learnedFileIn, learnedLines } from '../keeper.js';
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
  return { settings: s, k: createKeeper({ brain: () => ({ root: dir, vault: dir }), dataDir: `${dir}.data`, settings: s, hasModel: () => true, runText: async () => '- Ada owns the launch page', owner: () => 'Rick Bot', ...opts }) };
};
const home = (dir) => keeperHome(`${dir}.data`, dir);
const state = (dir) => JSON.parse(readFileSync(path.join(home(dir), 'keeper.json'), 'utf8'));
const changelog = (dir) => readFileSync(path.join(home(dir), CHANGELOG), 'utf8');
const FACTS = 'Quorum/learned-facts.md';
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
    expect(changelog(dir)).toContain('Quorum did not make index.md, so the keeper leaves it unchanged. Meeting index lines go to 08-meetings/index.md.');
    expect(text(dir, FACTS)).toContain('Ada owns the launch page');
    expect(k.status().folder).toBe('Quorum');
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
    expect(state(dir).made).toContain('01-daily/2026-11-12.md');
  });
  it('ignores editVault, factsInClaude and a picked note an earlier version saved, and never writes their files', async () => {
    const dir = personVault();
    put(dir, 'notes/mine.md', `${MINE['notes/mine.md']}\n${LEARNED_OPEN}\n- Bo owns pricing ([[m]], 2026-11-01)\n<!-- /quorum:learned -->\n`);
    const mine = text(dir, 'notes/mine.md');
    put(home(dir), 'keeper.json', JSON.stringify({ done: {}, made: [], factsNoteAt: 'notes/mine.md' }));
    const { k } = keeperFor(dir, { editVault: true, factsInClaude: true, factsTarget: 'note', factsNote: 'notes/mine.md' }, QUORUM);
    const r = await k.run();
    for (const [rel, body] of Object.entries(MINE)) if (rel !== 'notes/mine.md') expect(text(dir, rel), rel).toBe(body);
    // the list in a note the person made stays there for Needs review (rules/keeperLines.js)
    expect(text(dir, 'notes/mine.md')).toBe(mine);
    expect(r.left.sort()).toEqual(['01-daily/2026-11-10.md', '02-people/ada-lovelace.md', '03-projects/launch.md']);
    expect(learnedLines(text(dir, FACTS))).toEqual(['- Ada owns the launch page ([[2026-11-10-plan]], 2026-11-10)']);
    expect(learnedFileIn(state(dir))).toBe(FACTS);
  });
  it('moves a list from a note an earlier keeper made into the Quorum folder, and removes that note and its index line', async () => {
    const dir = personVault();
    const old = '05-knowledge/quorum-learned.md';
    put(dir, old, `${LEARNED_HEADER}\n${LEARNED_OPEN}\n## Learned from meetings\n\n- Bo owns pricing ([[m]], 2026-11-01)\n<!-- /quorum:learned -->\n`);
    put(dir, 'index.md', `${INDEX_HEADER}- [[quorum-learned]] - learned facts from meetings, kept by Quorum\n`);
    put(home(dir), 'keeper.json', JSON.stringify({ done: {}, made: ['index.md', old], factsNoteAt: old }));
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    expect(existsSync(path.join(dir, old))).toBe(false);
    expect(learnedLines(text(dir, FACTS))).toEqual(['- Bo owns pricing ([[m]], 2026-11-01)', '- Ada owns the launch page ([[2026-11-10-plan]], 2026-11-10)']);
    expect(text(dir, 'index.md')).not.toContain('[[quorum-learned]]');
    expect(text(dir, 'index.md')).toContain('- [[learned-facts]] - learned facts from meetings, kept by Quorum');
  });
  it('maintains the files the starter made in a folder Quorum built', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'own-built-'));
    writeStarter(dir, plan({ name: 'Studio', answers: { people: ['Ada Lovelace'], projects: ['Launch'] } }));
    const meetings = plan({ name: 'Studio', answers: {} }).meetings;
    put(dir, `${meetings}/2026-11-10-plan.md`, NOTE('Plan', '2026-11-10', 'Ada owns the launch page for Launch.'));
    const { k } = keeperFor(dir, {}, { brainMade: 'quorum' });
    const r = await k.run();
    expect(r.left).toEqual([]);
    expect(text(dir, 'index.md')).toContain('[[2026-11-10-plan]]');
    const people = Object.keys(plan({ name: 'Studio', answers: { people: ['Ada Lovelace'] } }).files).find((f) => f.endsWith('ada-lovelace.md'));
    expect(text(dir, people)).toContain('[[2026-11-10-plan]]');
    // the same files in a folder the person connected are theirs
    const { k: k2 } = keeperFor(dir, {}, { brainMade: null });
    put(dir, `${meetings}/2026-11-11-sync.md`, NOTE('Sync', '2026-11-11'));
    const r2 = await k2.run();
    expect(text(dir, 'index.md')).not.toContain('[[2026-11-11-sync]]');
    // jobs nobody chose stay with the person's own setup in a folder they connected, so no people note is touched
    expect(text(dir, people)).not.toContain('[[2026-11-11-sync]]');
    expect(r2.left).toEqual([]);
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
    // in the vault's .quorum folder, where an earlier version kept its state
    put(dir, '.quorum/changelog.md', '# Changelog\n\n## 2026-11-02 10:00 Old\n\n- index.md\n- 08-meetings/index.md\n- 01-daily/2026-11-01.md\n- 01-daily/2026-11-02.md\n\n');
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
    // the state moved to the data folder and the .quorum folder is gone
    expect(existsSync(path.join(dir, '.quorum'))).toBe(false);
    expect(changelog(dir)).toContain('## 2026-11-02 10:00 Old');
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
  it('never files into the person\'s notes, also with editVault saved on, and asks for facts once', async () => {
    const dir = personVault();
    let calls = 0;
    const { k } = keeperFor(dir, {}, QUORUM, { runText: async () => { calls++; return '- Ada owns the launch page'; } });
    await k.run();
    k.set({ editVault: true });
    await k.run();
    expect(text(dir, '02-people/ada-lovelace.md')).toBe(MINE['02-people/ada-lovelace.md']);
    expect(text(dir, '01-daily/2026-11-10.md')).toBe(MINE['01-daily/2026-11-10.md']);
    expect(calls).toBe(1);
  });
  it('saves the files it made even when the run fails', async () => {
    const dir = personVault();
    mkdirSync(path.join(home(dir), CHANGELOG), { recursive: true });
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    const { k } = keeperFor(dir, {}, { plugins: { daily: { owner: 'quorum' } } });
    const r = await k.run();
    expect(r.error).toMatch(/EISDIR/);
    const made = ['08-meetings/index.md', '01-daily/2026-11-12.md'].filter((rel) => existsSync(path.join(dir, rel)));
    expect(made.length).toBeGreaterThan(0);
    expect(state(dir).made).toEqual(expect.arrayContaining(made));
  });
  it('says where the list is the same way the CLI reads it, and moves it with the Quorum folder', async () => {
    const dir = personVault();
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    expect(k.status().learned).toMatchObject({ file: FACTS });
    expect(learnedFileIn(state(dir))).toBe(FACTS);
    k.set({ folder: 'notes/quorum' });
    expect(k.status()).toMatchObject({ folder: 'notes/quorum', learned: { file: 'notes/quorum/learned-facts.md' } });
    expect(learnedFileIn(state(dir))).toBe('notes/quorum/learned-facts.md');
    expect(learnedLines(text(dir, 'notes/quorum/learned-facts.md'))).toHaveLength(1);
    expect(existsSync(path.join(dir, FACTS))).toBe(false);
    // a folder in a dot folder, outside the vault or in the meetings folder is refused
    for (const bad of ['.hidden', '../out', '/etc', '08-meetings/q']) expect(k.set({ folder: bad }).folder, bad).toBe('notes/quorum');
    expect(k.set({ folder: '' }).folder).toBe('Quorum');
  });
  it('uses a Quorum folder the vault has already', async () => {
    const dir = personVault();
    mkdirSync(path.join(dir, '09-quorum'));
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    expect(learnedLines(text(dir, '09-quorum/learned-facts.md'))).toHaveLength(1);
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
    expect(JSON.parse(readFileSync(path.join(home(dir), 'kept-notes.json'), 'utf8'))['q-kjhkjhkjh']).toBeTruthy();
    expect(existsSync(path.join(dir, '.quorum'))).toBe(false);
  });

  it('drops a note that is gone from the list and logs the move to the Trash', async () => {
    const dir = vault();
    const { k } = keeperFor(dir, {}, QUORUM);
    await k.run();
    k.trashedJunk('08-meetings/2026-11-15-kjhkjhkjh-q1.md', 'kjhkjhkjh');
    rmSync(path.join(dir, '08-meetings/2026-11-15-kjhkjhkjh-q1.md'));
    expect(k.junk()).toEqual([]);
    expect(changelog(dir)).toContain('Moved to the Trash');
  });
});

// whether a file is Quorum's is read from the vault itself, so the keeper keeps its files when the state on this Mac is
// gone or belongs to another path
describe('ownership without the state on this Mac', () => {
  const counting = () => { const c = { n: 0 }; return { c, runText: async () => { c.n++; return '- Ada owns the launch page'; } }; };
  const filedOnce = async (dataDir) => {
    const dir = personVault();
    const { k } = keeperFor(dir, {}, QUORUM, { dataDir });
    await k.run();
    expect(text(dir, '08-meetings/index.md').startsWith('---\nquorum: generated\n---\n')).toBe(true);
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    return dir;
  };
  const updatesItsFiles = async (dir, dataDir) => {
    const { c, runText } = counting();
    const { k } = keeperFor(dir, {}, QUORUM, { dataDir, runText });
    const r = await k.run();
    // only the new note goes to the model; the one the meetings index lists counts as filed
    expect(c.n).toBe(1);
    expect(r.filed).toBe(1);
    const index = text(dir, '08-meetings/index.md');
    expect(index).toContain('[[2026-11-10-plan]]');
    expect(index).toContain('[[2026-11-12-sync]]');
    expect(text(dir, '01-daily/2026-11-12.md')).toContain('[[2026-11-12-sync]]');
    // the same fact again: one line, with the newer citation
    expect(learnedLines(text(dir, FACTS))).toEqual(['- Ada owns the launch page ([[2026-11-12-sync]], 2026-11-12)']);
    for (const [rel, body] of Object.entries(MINE)) expect(text(dir, rel), rel).toBe(body);
  };
  it('after the vault folder is renamed', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'own-data-'));
    const dir = await filedOnce(dataDir);
    const moved = `${dir}-renamed`;
    renameSync(dir, moved);
    // the state follows the folder, so nothing is filed twice
    const { c, runText } = counting();
    const { k } = keeperFor(moved, {}, QUORUM, { dataDir, runText });
    expect(k.status().filed).toBe(1);
    await k.run();
    expect(c.n).toBe(1);
    expect(text(moved, '08-meetings/index.md')).toContain('[[2026-11-12-sync]]');
  });
  it('on a second Mac, whose data folder holds no state for the vault', async () => {
    const dir = await filedOnce(mkdtempSync(path.join(tmpdir(), 'own-data-a-')));
    await updatesItsFiles(dir, mkdtempSync(path.join(tmpdir(), 'own-data-b-')));
  });
  it('after Delete my data', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'own-data-'));
    const dir = await filedOnce(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
    await updatesItsFiles(dir, dataDir);
  });
  it('proves files an earlier version wrote with no mark by their text, and marks them on the next write', async () => {
    const dir = personVault();
    put(dir, '08-meetings/index.md', `${MEETINGS_HEADER}- [[2026-11-01-old]] - meeting 2026-11-01: Old\n`);
    put(dir, '01-daily/2026-11-12.md', '# 2026-11-12\n\n## Meetings\n\n- [[2026-11-12-old]] Old\n');
    put(dir, '05-knowledge/quorum-learned.md', `${LEARNED_HEADER}\n${LEARNED_OPEN}\n## Learned from meetings\n\n- Bo owns pricing ([[m]], 2026-11-01)\n<!-- /quorum:learned -->\n`);
    put(dir, '08-meetings/2026-11-12-sync.md', NOTE('Sync', '2026-11-12'));
    const { k } = keeperFor(dir, {}, QUORUM);
    const r = await k.run();
    expect(r.left).not.toContain('08-meetings/index.md');
    expect(r.left).not.toContain('01-daily/2026-11-12.md');
    for (const rel of ['08-meetings/index.md', '01-daily/2026-11-12.md']) {
      expect(text(dir, rel).startsWith('---\nquorum: generated\n---\n'), rel).toBe(true);
      expect(text(dir, rel), rel).toContain('[[2026-11-12-sync]]');
    }
    // the older default facts note moves in with no factsNoteAt to point at it
    expect(existsSync(path.join(dir, '05-knowledge/quorum-learned.md'))).toBe(false);
    expect(learnedLines(text(dir, FACTS))[0]).toBe('- Bo owns pricing ([[m]], 2026-11-01)');
    // the person's own notes stay theirs
    for (const [rel, body] of Object.entries(MINE)) expect(text(dir, rel), rel).toBe(body);
  });
  it('leaves state in the vault when it can not be copied to the data folder', async () => {
    const dir = personVault();
    put(dir, '.quorum/keeper.json', JSON.stringify({ done: {} }));
    const notADir = path.join(mkdtempSync(path.join(tmpdir(), 'own-data-')), 'file');
    writeFileSync(notADir, 'x');
    const { k } = keeperFor(dir, {}, QUORUM, { dataDir: notADir });
    await k.run();
    expect(text(dir, '.quorum/keeper.json')).toBe(JSON.stringify({ done: {} }));
  });
});

describe('the quorum CLI', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cli', 'quorum.mjs');
  const learned = (h) => execFileSync(process.execPath, [cli, 'learned'], { env: { ...process.env, HOME: h, QUORUM_ENV: '' }, encoding: 'utf8' });
  it('reads the facts file the keeper recorded in the data folder, else in .quorum/keeper.json', async () => {
    const h = mkdtempSync(path.join(tmpdir(), 'own-home-'));
    const data = path.join(h, 'Library/Application Support/Quorum');
    const dir = personVault();
    put(data, 'settings.json', JSON.stringify({ vaultPath: dir }));
    const { k } = keeperFor(dir, { folder: 'notes/q' }, QUORUM, { dataDir: data });
    await k.run();
    expect(learned(h)).toContain('Ada owns the launch page');
    // a vault the app has not opened since the move keeps its state in .quorum
    const old = personVault();
    put(old, 'notes/facts.md', `${LEARNED_HEADER}\n${LEARNED_OPEN}\n- Bo owns pricing\n<!-- /quorum:learned -->\n`);
    put(old, '.quorum/keeper.json', JSON.stringify({ done: {}, factsNoteAt: 'notes/facts.md' }));
    put(data, 'settings.json', JSON.stringify({ vaultPath: old }));
    expect(learned(h)).toContain('Bo owns pricing');
  });
});
