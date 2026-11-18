import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPlan, fixVersions, readRun, recheckAll, recheckRun, removeAlias, undoPlan } from '../fixRecheck.js';
import { createElsewhere } from '../linkElsewhere.js';
import { sha } from '../fixUndo.js';
import { createVersionStore } from '../memoryVersions.js';
import { createVaultIndex } from '../vindex.js';

let dirs = [];
const temp = (p) => { const d = mkdtempSync(path.join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

// a vault in a temp folder, its index and the reader the re-check uses
function setup(files) {
  const dir = temp('qrecheck-');
  const put = (rel, t) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), t); };
  for (const [rel, t] of Object.entries(files)) put(rel, t);
  const idx = createVaultIndex({ vault: dir, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
  idx.sync();
  const read = (rel) => { try { return readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
  const vault = { rels: () => idx.rels(), note: (rel) => idx.note(rel), backlinks: (rel) => idx.backlinks(rel), resolve: (t, from) => idx.resolve(t, from), read };
  const mtime = (rel) => { try { return statSync(path.join(dir, rel)).mtimeMs; } catch { return null; } };
  return { dir, put, read, vault, mtime, sync: () => idx.sync() };
}
const T = Date.now();
const run = (o) => ({ id: `fix:${o.target}:${T}`, key: o.target.toLowerCase(), status: 'success', queuedAt: T - 2000, startedAt: T - 2000, endedAt: T, steps: [], ...o });
const created = (target, rel, extra = {}) => run({ target, outcome: `Wrote the note ${rel} from what the linking notes say`, ...extra });
const relinked = (target, title, links, files, rel, extra = {}) => run({ target, rel, outcome: `Fixed ${links} ${links === 1 ? 'link' : 'links'} in ${files} ${files === 1 ? 'note' : 'notes'}`, steps: [{ label: `Pointing the ${links === 1 ? 'link' : `${links} links`} at ${title}` }], ...extra });
const aliased = (target, name, links, rel) => run({ target, rel, outcome: `Added “${target}” as an alias of ${name}, so ${links} ${links === 1 ? 'link now works' : 'links now work'}` });
const unlinked = (target, rel) => run({ target, rel, outcome: 'Removed 1 dead link and kept the words' });
const stub = (name, sources) => `# ${name}\n\nQuorum made this note because ${sources.length} notes link to “${name}” and no note had that name. What those notes say about it:\n\n${sources.map((s) => `- [[${s}]]: ${s}`).join('\n')}\n`;
// pins a note's file time to the end of the fix, so it reads as unchanged since
const settle = (s, rel, at = T) => utimesSync(path.join(s.dir, rel), new Date(at), new Date(at));
const ids = (res) => res.reasons.map((r) => r.id);

describe('readRun', () => {
  it('reads the action back from an old run that kept only its outcome and steps', () => {
    expect(readRun(created('Lantern', 'notes/Lantern.md'))).toMatchObject({ action: 'create', made: 'notes/Lantern.md' });
    expect(readRun(aliased('lantern-x', 'Lantern', 2, 'a.md'))).toMatchObject({ action: 'alias', toName: 'Lantern', links: 2, sources: ['a.md'] });
    expect(readRun(relinked('old-plan', 'Harbor Plan', 3, 2, 'a.md'))).toMatchObject({ action: 'relink', toName: 'Harbor Plan', links: 3, files: 2 });
    expect(readRun(unlinked('ghost', 'a.md'))).toMatchObject({ action: 'unlink', links: 1 });
  });
});

describe('recheckRun flags', () => {
  it('flags a note written from one real source and a generated report', () => {
    const s = setup({ 'notes/a.md': 'see [[Lantern]]', 'memory/drift-report.md': 'dead: [[Lantern]]', 'notes/Lantern.md': stub('Lantern', ['notes/a', 'memory/drift-report']) });
    const res = recheckRun(created('Lantern', 'notes/Lantern.md'), { vault: s.vault });
    expect(res.flagged).toBe(true);
    expect(ids(res)).toEqual(['few-sources']);
    expect(res.evidence).toContainEqual(['Generated reports among them', 'memory/drift-report.md']);
  });
  it('leaves a note written from two real sources alone', () => {
    const s = setup({ 'notes/a.md': 'see [[Lantern]]', 'notes/b.md': 'also [[Lantern]]', 'notes/Lantern.md': stub('Lantern', ['notes/a', 'notes/b']) });
    expect(recheckRun(created('Lantern', 'notes/Lantern.md'), { vault: s.vault }).flagged).toBe(false);
  });
  it('flags a note written in a session log folder', () => {
    const s = setup({ 'memory/sessions/a.md': '[[Ferry]]', 'memory/sessions/b.md': '[[Ferry]]', 'memory/sessions/Ferry.md': stub('Ferry', ['memory/sessions/a', 'memory/sessions/b']) });
    expect(ids(recheckRun(created('Ferry', 'memory/sessions/Ferry.md'), { vault: s.vault }))).toContain('no-create-folder');
  });
  it('flags a note whose name is a folder, a script or a skill', () => {
    const s = setup({ 'n/a.md': '[[orchard]] [[tidy-links]] [[pathfinder]]', 'n/b.md': '[[orchard]] [[tidy-links]] [[pathfinder]]', 'orchard/index.md': '# Orchard', 'n/orchard.md': stub('orchard', ['n/a', 'n/b']), 'n/tidy-links.md': stub('tidy-links', ['n/a', 'n/b']), 'n/pathfinder.md': stub('pathfinder', ['n/a', 'n/b']) });
    mkdirSync(path.join(s.dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(s.dir, 'scripts', 'tidy-links.py'), 'print(1)');
    const skills = temp('qskills-');
    mkdirSync(path.join(skills, 'pathfinder'));
    const finder = createElsewhere({ vault: s.dir, skillRoots: [skills], useGit: false });
    const check = (t) => recheckRun(created(t, `n/${t}.md`), { vault: s.vault, find: (n) => finder.find(n) });
    expect(check('orchard').reasons.map((r) => r.text).join(' ')).toMatch(/A folder with that name is at orchard/);
    expect(check('tidy-links').reasons.map((r) => r.text).join(' ')).toMatch(/A script with that name is at scripts\/tidy-links.py/);
    expect(check('pathfinder').reasons.map((r) => r.text).join(' ')).toMatch(/A skill with that name/);
  });
  it('flags a note that exists on another branch, and not the same note committed on one', () => {
    const s = setup({ 'n/a.md': '[[Beacon]]', 'n/b.md': '[[Beacon]]', 'n/Beacon.md': stub('Beacon', ['n/a', 'n/b']) });
    const other = recheckRun(created('Beacon', 'n/Beacon.md'), { vault: s.vault, find: () => ({ kind: 'branch', where: 'research/Beacon.md', branch: 'draft' }) });
    expect(ids(other)).toEqual(['exists-elsewhere']);
    const same = recheckRun(created('Beacon', 'n/Beacon.md'), { vault: s.vault, find: () => ({ kind: 'branch', where: 'n/Beacon.md', branch: 'main' }) });
    expect(same.flagged).toBe(false);
  });
  it('flags a note that dropped the confidential mark of a source', () => {
    const s = setup({ 'n/a.md': '---\nconfidential: internal\n---\n[[Quarry]]', 'n/b.md': '[[Quarry]]', 'n/Quarry.md': stub('Quarry', ['n/a', 'n/b']) });
    expect(ids(recheckRun(created('Quarry', 'n/Quarry.md'), { vault: s.vault }))).toEqual(['confidential-dropped']);
  });
  it('flags a dead link removed from a generated report, and leaves one removed from a person\'s note', () => {
    const s = setup({ 'reports/weekly.md': 'x', 'n/a.md': 'x' });
    expect(ids(recheckRun(unlinked('ghost', 'reports/weekly.md'), { vault: s.vault }))).toEqual(['generated-source']);
    expect(recheckRun(unlinked('ghost', 'n/a.md'), { vault: s.vault }).flagged).toBe(false);
  });
  it('flags a relink onto a note an earlier fix wrote', () => {
    const s = setup({ 'n/a.md': '[[Dock Plan]] and [[dock-brief]]', 'n/b.md': '[[Dock Plan]]', 'n/Dock Plan.md': stub('Dock Plan', ['n/a', 'n/b']) });
    const made = created('Dock Plan', 'n/Dock Plan.md', { id: 'fix:dock plan:1', startedAt: T - 9000, endedAt: T - 8000 });
    const moved = relinked('dock-brief', 'Dock Plan', 1, 1, 'n/a.md');
    const res = recheckRun(moved, { vault: s.vault, runs: [moved, made] });
    expect(ids(res)).toEqual(['onto-stub']);
    expect(res.reasons[0].text).toMatch(/an earlier fix wrote for “Dock Plan”/);
  });
  it('flags an alias added to a stub Quorum wrote', () => {
    const s = setup({ 'n/Harbor.md': `---\naliases:\n  - harbor-team\n---\n${stub('Harbor', ['n/a', 'n/b'])}`, 'n/a.md': '[[Harbor]]', 'n/b.md': '[[harbor-team]]' });
    expect(ids(recheckRun(aliased('harbor-team', 'Harbor', 1, 'n/b.md'), { vault: s.vault }))).toEqual(['onto-stub']);
  });
  it('flags a relink onto a generated report that is also the linking note', () => {
    const s = setup({ 'memory/scan-report.md': '# Scan Report\n[[memory/scan-report|scan]]' });
    const res = recheckRun(relinked('scan', 'Scan Report', 1, 1, 'memory/scan-report.md'), { vault: s.vault });
    expect(ids(res)).toEqual(['generated-source', 'onto-generated', 'onto-self']);
  });
  it('flags a relink matched through a title that holds the note body', () => {
    const s = setup({ 'n/one-line.md': '# Onboarding Research\\n\\nAuthor: someone\\n\\nThe whole body sits on this line', 'n/a.md': '[[n/one-line|plan]]' });
    const res = recheckRun(relinked('free-plan', 'Onboarding Research\\n\\nAuthor: someone\\n\\nThe whole body sits on this line', 1, 1, 'n/a.md'), { vault: s.vault });
    expect(ids(res)).toEqual(['title-body']);
    expect(res.main).toBe('n/one-line.md');
  });
  it('leaves an alias and a relink onto real notes alone', () => {
    const s = setup({ 'n/Lighthouse.md': '---\naliases: [beam, lighthouse-x]\n---\n# Lighthouse', 'n/a.md': '[[lighthouse-x]]', 'n/b.md': '[[n/Lighthouse|old]]' });
    expect(recheckRun(aliased('lighthouse-x', 'Lighthouse', 1, 'n/a.md'), { vault: s.vault }).flagged).toBe(false);
    expect(recheckRun(relinked('old-light', 'Lighthouse', 1, 1, 'n/b.md'), { vault: s.vault }).flagged).toBe(false);
  });
});

describe('undoPlan', () => {
  it('uses the undo record when the notes still read as the fix left them', async () => {
    const s = setup({ 'n/a.md': 'see [[Lighthouse]]', 'n/Lighthouse.md': '# Lighthouse' });
    const r = relinked('old-light', 'Lighthouse', 1, 1, 'n/a.md');
    const files = [{ rel: 'n/a.md', before: 'see [[old-light]]', after: sha(s.read('n/a.md')) }];
    const plan = undoPlan(r, { vault: s.vault, undoFiles: files });
    expect(plan).toMatchObject({ ok: true, kind: 'record' });
    expect(await applyPlan(s.dir, plan, async () => {})).toEqual(['n/a.md']);
    expect(s.read('n/a.md')).toBe('see [[old-light]]');
  });
  it('refuses the undo record when a note changed after the fix, and names the note to open', () => {
    const s = setup({ 'n/a.md': 'see [[Lighthouse]] and a later edit' });
    const r = relinked('old-light', 'Lighthouse', 1, 1, 'n/a.md');
    const plan = undoPlan(r, { vault: s.vault, undoFiles: [{ rel: 'n/a.md', before: 'see [[old-light]]', after: sha('see [[Lighthouse]]') }] });
    expect(plan).toMatchObject({ ok: false, kind: 'record', open: 'n/a.md' });
    expect(plan.why).toMatch(/changed after the fix/);
  });
  it('puts notes back from the versions Quorum saved during the fix', async () => {
    const s = setup({ 'n/a.md': 'kept words' });
    const store = createVersionStore({ dir: temp('qvers-'), now: () => T - 1000 });
    const r = unlinked('ghost', 'n/a.md');
    store.record({ vault: s.dir, rel: 'n/a.md', before: 'kept [[ghost|words]]', after: 'kept words', who: 'agent', reason: `Memory health fix: ${r.outcome}` });
    settle(s, 'n/a.md');
    const versions = fixVersions(store.files(s.dir), r);
    expect(versions).toHaveLength(1);
    const plan = undoPlan(r, { vault: s.vault, versions, readVersion: (rel, id) => store.read(s.dir, rel, id), mtime: s.mtime });
    expect(plan).toMatchObject({ ok: true, kind: 'versions' });
    await applyPlan(s.dir, plan, async () => {});
    expect(s.read('n/a.md')).toBe('kept [[ghost|words]]');
  });
  it('refuses the versions when a later version of the note exists', () => {
    const s = setup({ 'n/a.md': 'edited again' });
    let at = T - 1000;
    const store = createVersionStore({ dir: temp('qvers-'), now: () => at });
    const r = unlinked('ghost', 'n/a.md');
    store.record({ vault: s.dir, rel: 'n/a.md', before: 'kept [[ghost]]', after: 'kept ghost', who: 'agent', reason: `Memory health fix: ${r.outcome}` });
    at = T + 60000;
    store.record({ vault: s.dir, rel: 'n/a.md', before: 'kept ghost', after: 'edited again', who: 'you', reason: 'Edited' });
    const plan = undoPlan(r, { vault: s.vault, versions: fixVersions(store.files(s.dir), r), readVersion: (rel, id) => store.read(s.dir, rel, id), mtime: s.mtime });
    expect(plan).toMatchObject({ ok: false, kind: 'versions', open: 'n/a.md' });
  });
  it('moves a note the fix wrote to the Trash when nothing else is kept', async () => {
    const s = setup({ 'n/Lantern.md': stub('Lantern', ['n/a']) });
    settle(s, 'n/Lantern.md');
    const plan = undoPlan(created('Lantern', 'n/Lantern.md'), { vault: s.vault, mtime: s.mtime });
    expect(plan).toMatchObject({ ok: true, kind: 'trash' });
    const trashed = [];
    await applyPlan(s.dir, plan, async (abs) => { trashed.push(path.relative(s.dir, abs)); rmSync(abs); });
    expect(trashed).toEqual(['n/Lantern.md']);
    expect(existsSync(path.join(s.dir, 'n/Lantern.md'))).toBe(false);
  });
  it('refuses to trash a note the fix wrote when it changed after the fix', () => {
    const s = setup({ 'n/Lantern.md': `${stub('Lantern', ['n/a'])}\nMy own notes` });
    settle(s, 'n/Lantern.md', T + 3600000);
    const plan = undoPlan(created('Lantern', 'n/Lantern.md'), { vault: s.vault, mtime: s.mtime });
    expect(plan).toMatchObject({ ok: false, kind: 'trash', open: 'n/Lantern.md' });
  });
  it('refuses to trash a different note renamed onto the path the fix wrote, though its file time is old', () => {
    const s = setup({ 'n/Lantern.md': '# Lantern\n\nA note a person wrote long ago' });
    settle(s, 'n/Lantern.md');
    const plan = undoPlan(created('Lantern', 'n/Lantern.md'), { vault: s.vault, mtime: s.mtime });
    expect(plan).toMatchObject({ ok: false, kind: 'trash', open: 'n/Lantern.md' });
  });
  it('takes an alias back out when the text before is certain, and refuses when it is not', async () => {
    const block = setup({ 'n/Lighthouse.md': '---\naliases:\n  - beam\n  - lighthouse-x\ntags: [a]\n---\n# Lighthouse' });
    settle(block, 'n/Lighthouse.md');
    const plan = undoPlan(aliased('lighthouse-x', 'Lighthouse', 1, 'n/a.md'), { vault: block.vault, mtime: block.mtime });
    expect(plan).toMatchObject({ ok: true, kind: 'exact' });
    await applyPlan(block.dir, plan, async () => {});
    expect(block.read('n/Lighthouse.md')).toBe('---\naliases:\n  - beam\ntags: [a]\n---\n# Lighthouse');
    const unsure = setup({ 'n/Lighthouse.md': '---\ntags: [a]\naliases:\n  - lighthouse-x\n---\n# Lighthouse' });
    settle(unsure, 'n/Lighthouse.md');
    const no = undoPlan(aliased('lighthouse-x', 'Lighthouse', 1, 'n/a.md'), { vault: unsure.vault, mtime: unsure.mtime });
    expect(no).toMatchObject({ ok: false, kind: 'exact', open: 'n/Lighthouse.md' });
  });
  it('points relinked links back when they are the only links to the note, and refuses otherwise', async () => {
    const s = setup({ 'n/Lighthouse.md': '# Lighthouse', 'n/a.md': 'see [[Lighthouse|the light]] and [[Lighthouse#Keeper]]' });
    settle(s, 'n/a.md');
    const r = relinked('old-light', 'Lighthouse', 2, 1, 'n/a.md');
    const plan = undoPlan(r, { vault: s.vault, mtime: s.mtime });
    expect(plan).toMatchObject({ ok: true, kind: 'exact' });
    await applyPlan(s.dir, plan, async () => {});
    expect(s.read('n/a.md')).toBe('see [[old-light|the light]] and [[old-light#Keeper]]');
    s.put('n/a.md', 'see [[Lighthouse]]');
    s.put('n/b.md', 'also [[Lighthouse]]');
    s.sync();
    const no = undoPlan(relinked('old-light', 'Lighthouse', 1, 1, 'n/a.md'), { vault: s.vault, mtime: s.mtime });
    expect(no).toMatchObject({ ok: false, kind: 'exact' });
    expect(no.why).toMatch(/Other links also point at/);
  });
  it('offers no undo for a removed link without a record or versions', () => {
    const s = setup({ 'n/a.md': 'ghost' });
    const plan = undoPlan(unlinked('ghost', 'n/a.md'), { vault: s.vault, mtime: s.mtime });
    expect(plan).toMatchObject({ ok: false, kind: 'none', open: 'n/a.md' });
  });
  it('refuses at Undo time when the note changed after the plan was made', async () => {
    const s = setup({ 'n/Lantern.md': stub('Lantern', ['n/a']) });
    settle(s, 'n/Lantern.md');
    const plan = undoPlan(created('Lantern', 'n/Lantern.md'), { vault: s.vault, mtime: s.mtime });
    s.put('n/Lantern.md', 'my edit');
    const trashed = [];
    await expect(applyPlan(s.dir, plan, async (abs) => trashed.push(abs))).rejects.toThrow(/changed after the fix/);
    expect(trashed).toEqual([]);
  });
});

describe('removeAlias', () => {
  it('reverses an inline alias list', () => {
    expect(removeAlias('---\naliases: [beam, lighthouse-x]\n---\nx', 'lighthouse-x')).toBe('---\naliases: [beam]\n---\nx');
    expect(removeAlias('---\naliases: [lighthouse-x]\n---\nx', 'lighthouse-x')).toBe('---\naliases: []\n---\nx');
    expect(removeAlias('---\naliases: [lighthouse-x, beam]\n---\nx', 'lighthouse-x')).toBeNull();
  });
});

describe('recheckAll', () => {
  it('reuses cached results under the same version and checks again after a rule version change', () => {
    const s = setup({ 'reports/weekly.md': 'x' });
    const runs = [unlinked('ghost', 'reports/weekly.md'), { ...unlinked('other', 'reports/weekly.md'), status: 'error' }];
    const first = recheckAll(runs, { vault: s.vault }, null, '2.1');
    expect(Object.keys(first.results)).toEqual([runs[0].id]);
    const stale = { version: '2.1', results: { [runs[0].id]: { flagged: false, reasons: [] } } };
    expect(recheckAll(runs, { vault: s.vault }, stale, '2.1').results[runs[0].id].flagged).toBe(false);
    expect(recheckAll(runs, { vault: s.vault }, stale, '3.1').results[runs[0].id].flagged).toBe(true);
  });
});
