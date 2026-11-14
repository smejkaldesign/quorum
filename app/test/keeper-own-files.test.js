import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, LEARNED_FILE, createKeeper, learnedLines } from '../keeper.js';
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
const keeperFor = (dir, keeper = {}, settings = {}) => {
  const s = { keeper: { on: true, ...keeper }, ...settings };
  return { settings: s, k: createKeeper({ brain: () => ({ root: dir, vault: dir }), settings: s, hasModel: () => true, runText: async () => '- Ada owns the launch page', owner: () => 'Rick Bot' }) };
};

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
