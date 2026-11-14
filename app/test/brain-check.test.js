import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STARTER_CHECKS, changes, cleanChecks, createBrainCheck, fingerprint, grade } from '../brain-check.js';
import { projectSlugs } from '../context-budget.js';
import { folders } from '../keeper.js';
import { detect, resolvePlugins, scanContext } from '../plugins.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const temp = (name) => mkdtempSync(path.join(tmpdir(), `${name}-`));

// a check runner with a fake model: answers come from a map, and every prompt asked is recorded
function setup(answers = {}) {
  const root = temp('check-vault');
  const file = path.join(temp('check-data'), 'brain-check.json');
  const asked = [];
  let model = 'claude-code:sonnet';
  let day = 10;
  const check = createBrainCheck({
    file,
    ask: async (q) => { asked.push(q); if (answers[q] instanceof Error) throw answers[q]; return answers[q] ?? ''; },
    print: () => fingerprint({ model, root, home: root }),
    now: () => new Date(`2026-11-${day}T09:00:00Z`),
  });
  return { root, file, asked, check, setModel: (m) => { model = m; }, nextDay: () => { day++; } };
}

describe('brain check', () => {
  it('passes only when every expected term is in the answer', () => {
    expect(grade('Ada leads the Platform team.', ['ada', 'platform'])).toEqual({ pass: true, missing: [] });
    expect(grade('Ada leads it.', ['Ada', 'Platform'])).toEqual({ pass: false, missing: ['Platform'] });
  });
  it('keeps at most six checks with clean terms', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: i === 1 ? 'bad id!' : `c${i}`, prompt: ` Q${i} `, expect: 'a, b ,, a' }));
    const out = cleanChecks([{ prompt: '   ', expect: ['x'] }, ...many]);
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({ id: 'c0', prompt: 'Q0', expect: ['a', 'b'] });
    expect(out[1].id).toBe('check-2');
    expect(cleanChecks('nope')).toEqual([]);
  });
  it('starts with the starter questions and asks nothing until Run', async () => {
    const { root, asked, check, file } = setup();
    expect(check.status(root)).toMatchObject({ checks: STARTER_CHECKS, last: null, running: false, ready: 0 });
    // starter checks have no terms yet, so a run asks nothing
    await check.run(root);
    expect(asked).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
  it('runs the checks with terms, saves the results by date, and compares with the run before', async () => {
    const answers = { 'Who is on my team?': 'Ada and Grace.', 'What rule did I set?': 'Write plainly.' };
    const { root, asked, check, nextDay } = setup(answers);
    check.setChecks(root, [
      { id: 'team', prompt: 'Who is on my team?', expect: ['Ada', 'Grace'] },
      { id: 'rule', prompt: 'What rule did I set?', expect: ['plainly'] },
      { id: 'later', prompt: 'Not ready yet', expect: [] },
    ]);
    const first = await check.run(root);
    expect(asked).toEqual(['Who is on my team?', 'What rule did I set?']);
    expect(first.last.at).toBe('2026-11-10T09:00:00.000Z');
    expect(first.last.results.map((r) => [r.id, r.pass])).toEqual([['team', true], ['rule', true]]);
    answers['Who is on my team?'] = 'Ada.';
    answers['What rule did I set?'] = new Error('model unavailable');
    nextDay();
    const second = await check.run(root);
    expect(second.previous.at).toBe('2026-11-10T09:00:00.000Z');
    expect(second.last.results[0]).toMatchObject({ pass: false, missing: ['Grace'], answer: 'Ada.' });
    expect(second.last.results[1]).toMatchObject({ pass: false, error: 'model unavailable' });
    expect(second.previous.results[0]).toMatchObject({ pass: true, answer: 'Ada and Grace.' });
  });
  it('names what changed since the last run', async () => {
    const { root, check, setModel } = setup({ Q: 'yes' });
    check.setChecks(root, [{ prompt: 'Q', expect: ['yes'] }]);
    put(root, 'CLAUDE.md', '# Rules\n');
    await check.run(root);
    expect(check.status(root).changed).toEqual([]);
    setModel('claude-code:opus');
    put(root, 'CLAUDE.md', '# Rules\n\nOne more.\n');
    put(root, `.claude/projects/${projectSlugs(root)[0]}/memory/MEMORY.md`, '- [A](a.md)\n');
    expect(check.status(root).changed).toEqual(['the model', 'CLAUDE.md', 'MEMORY.md']);
    expect(changes(null, {})).toEqual([]);
  });
  it('stores checks per vault in its own data file, outside the vault', async () => {
    const { root, file, check } = setup({ Q: 'yes' });
    check.setChecks(root, [{ prompt: 'Q', expect: ['yes'] }]);
    await check.run(root);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(data)).toEqual([root]);
    expect(existsSync(path.join(root, '.quorum'))).toBe(false);
  });
  it('is off until the user turns it on, and leaves the job to a vault with its own evals', () => {
    const root = temp('check-vault');
    expect(resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'brain-check')).toMatchObject({ owner: 'vault', evidence: [], isNew: false, report: true });
    const on = resolvePlugins(detect(scanContext(root, root, folders(root))), { 'brain-check': { owner: 'quorum', ack: '' } }).find((r) => r.id === 'brain-check');
    expect(on.owner).toBe('quorum');
    put(root, 'evals/brain.yaml', 'prompts: []\n');
    expect(resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'brain-check')).toMatchObject({ owner: 'vault', isNew: true, evidence: [{ path: 'evals', why: 'eval prompts' }] });
  });
});
