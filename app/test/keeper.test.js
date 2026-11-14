import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANGELOG, LEARNED_BUDGET, LEARNED_OPEN, addLearned, appendUnder, createKeeper, folders, learnedChars, learnedLines, parseFacts } from '../keeper.js';
import { plan, writeStarter } from '../starter.js';
import { compile, effective } from '../guardrails.js';
import { wouldBlock } from '../guardrails.js';

const answers = { template: 'founder', role: 'Designer', goals: '', projects: ['Quorum', 'Benefind'], people: ['Ada Lovelace'], organize: 'areas' };
const NOTE = (title, people, body, extra = '') => `---\nquorum_id: 01X\ntitle: ${title}\ndate: 2026-11-10T15:00:00-08:00\nparticipants:\n  - Rick Bot (recorder)\n${people.map((p) => `  - ${p}`).join('\n')}\nsource: quorum\n${extra}---\n\n# ${title}\n\n${body}\n`;

function vault() {
  const dir = mkdtempSync(path.join(tmpdir(), 'keeper-'));
  writeStarter(dir, plan({ name: 'Studio', answers }));
  return dir;
}
const keeperFor = (dir, over = {}) => {
  const settings = { brainMade: 'quorum', ...(over.settings ?? {}) };
  return createKeeper({ brain: () => ({ root: dir, vault: dir }), settings, guards: () => compile(effective({}), { root: dir, privateDirs: () => ['08-meetings/private'] }), wouldBlock, owner: () => 'Rick Bot', ...over });
};

describe('keeper pieces', () => {
  it('finds the areas under either naming', () => {
    const dir = vault();
    expect(folders(dir)).toMatchObject({ people: '02-people', projects: '03-projects', daily: '01-daily', meetings: '08-meetings' });
  });
  it('appends under a heading, adds the heading when missing, and never repeats a line', () => {
    const a = appendUnder('# Ada\n\n## Who\n\nx\n', '## Meetings', '- 2026-11-10 [[m]] Sync');
    expect(a.endsWith('## Meetings\n\n- 2026-11-10 [[m]] Sync\n')).toBe(true);
    const b = appendUnder(a, '## Meetings', '- 2026-11-11 [[n]] Plan');
    expect(b).toContain('- 2026-11-10 [[m]] Sync\n- 2026-11-11 [[n]] Plan');
    expect(appendUnder(b, '## Meetings', '- 2026-11-10 [[m]] Sync')).toBeNull();
    // the section ends at the next heading
    const c = appendUnder('# P\n\n## Meetings\n\n- old\n\n## Related\n\n- [[x]]\n', '## Meetings', '- new');
    expect(c).toContain('- old\n- new\n\n## Related');
  });
  it('keeps a budgeted, deduplicated learned block', () => {
    const t = addLearned('# Mine\n', ['Ada leads design', 'Ship in Q1']).text;
    expect(t).toContain(LEARNED_OPEN);
    expect(addLearned(t, ['Ada leads design'])).toBeNull();
    expect(addLearned(t, ['ada leads design.'])).toBeNull();
    const more = addLearned(t, Array.from({ length: 50 }, (_, i) => `fact number ${i} about the launch plan`)).text;
    expect(learnedChars(learnedLines(more))).toBeLessThanOrEqual(LEARNED_BUDGET);
    expect(more).toContain('# Mine');
    expect(parseFacts('- Ada leads design\n- none\n\n- Ship in Q1\n- Bo owns pricing\n- Cy runs support')).toEqual(['Ada leads design', 'Ship in Q1', 'Bo owns pricing']);
  });
});

describe('keeper run', () => {
  it('files a meeting note into index, daily, people and project notes, logs it, and is idempotent', async () => {
    const dir = vault();
    const rel = '08-meetings/quorum/2026-11-10-design-sync-01x.md';
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), NOTE('Design sync', ['Ada Lovelace'], 'We agreed the Quorum onboarding ships Friday.'));
    const k = keeperFor(dir);
    const r = await k.run();
    expect(r).toMatchObject({ filed: 1, skipped: 0 });
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('- [[2026-11-10-design-sync-01x]] - meeting 2026-11-10: Design sync');
    expect(readFileSync(path.join(dir, '01-daily', '2026-11-10.md'), 'utf8')).toContain('- [[2026-11-10-design-sync-01x]] Design sync');
    expect(readFileSync(path.join(dir, '02-people', 'ada-lovelace.md'), 'utf8')).toContain('## Meetings\n\n- 2026-11-10 [[2026-11-10-design-sync-01x]] Design sync');
    expect(readFileSync(path.join(dir, '03-projects', 'quorum.md'), 'utf8')).toContain('[[2026-11-10-design-sync-01x]]');
    expect(readFileSync(path.join(dir, '03-projects', 'benefind.md'), 'utf8')).not.toContain('[[2026-11-10-design-sync-01x]]');
    expect(readFileSync(path.join(dir, CHANGELOG), 'utf8')).toContain('Design sync');
    // the note body is untouched and a second run changes nothing
    const before = readFileSync(path.join(dir, rel), 'utf8');
    const r2 = await k.run();
    expect(r2).toMatchObject({ filed: 0, changed: 0 });
    expect(readFileSync(path.join(dir, rel), 'utf8')).toBe(before);
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8').match(/design-sync-01x/g)).toHaveLength(1);
    expect(k.status()).toMatchObject({ on: true, filed: 1 });
  });
  it('withholds a confidential note and a note in a private folder', async () => {
    const dir = vault();
    const a = '08-meetings/quorum/2026-11-10-secret-01y.md';
    const b = '08-meetings/private/2026-11-10-hidden-01z.md';
    for (const rel of [a, b]) mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, a), NOTE('Board prep', ['Ada Lovelace'], 'Numbers.', 'confidential: finance\n'));
    writeFileSync(path.join(dir, b), NOTE('Hidden', ['Ada Lovelace'], 'Quorum things.'));
    const r = await keeperFor(dir).run();
    expect(r).toMatchObject({ filed: 0, skipped: 2 });
    expect(readFileSync(path.join(dir, 'index.md'), 'utf8')).not.toContain('secret-01y');
    expect(readFileSync(path.join(dir, '02-people', 'ada-lovelace.md'), 'utf8')).not.toContain('[[');
    expect(existsSync(path.join(dir, '01-daily', '2026-11-10.md'))).toBe(false);
  });
  it('writes learned facts through the model source when one exists, and stays off when disabled', async () => {
    const dir = vault();
    const rel = '08-meetings/quorum/2026-11-10-plan-01w.md';
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), NOTE('Plan', ['Ada Lovelace'], 'Ada owns the launch page.'));
    const calls = [];
    const k = keeperFor(dir, { runText: async (p) => { calls.push(p); return '- Ada owns the launch page\n- none'; }, hasModel: () => true });
    await k.run();
    expect(calls).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain('- Ada owns the launch page ([[2026-11-10-plan-01w]], 2026-11-10)');
    const dir2 = vault();
    mkdirSync(path.dirname(path.join(dir2, rel)), { recursive: true });
    writeFileSync(path.join(dir2, rel), NOTE('Plan', [], 'x'));
    const k2 = keeperFor(dir2, { runText: async () => '- x', hasModel: () => true, settings: { brainMade: 'quorum', keeper: { on: true, facts: false } } });
    await k2.run();
    expect(readFileSync(path.join(dir2, 'CLAUDE.md'), 'utf8')).not.toContain(LEARNED_OPEN);
  });
  it('does nothing on a folder the person connected themselves until they turn it on', async () => {
    const dir = vault();
    const k = keeperFor(dir, { settings: { brainMade: null } });
    expect((await k.run()).off).toBe(true);
    expect(k.set({ on: true }).on).toBe(true);
    expect((await k.run()).off).toBeUndefined();
  });
});
