import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GENERATED_RULES, cleanTitle, contextNote, createPlan, generatedRule, genericTarget, linkReport, reportLine } from '../linkRules.js';
import { createElsewhere, folderIndex, withFound } from '../linkElsewhere.js';
import { createVaultIndex } from '../vindex.js';
import { issueOf, optionsOf } from '../memoryHealth.js';

// Synthetic fixtures for each bug class the link-fix eval found. Names and text are made up.
let vault;
const put = (rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };
const fresh = () => { vault = mkdtempSync(path.join(tmpdir(), 'qrules-')); return vault; };
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });
const index = () => { const i = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} }); i.sync(); return i; };
const health = (target) => index().linkHealth().find((m) => m.target.toLowerCase() === target.toLowerCase()) ?? null;

describe('generated reports and logs', () => {
  it('names a rule for each kind of generated note', () => {
    expect(generatedRule('memory/drift-report.md')?.id).toBe('report-file');
    expect(generatedRule('log.md')?.id).toBe('log-file');
    expect(generatedRule('notes/changelog.md')?.id).toBe('log-file');
    expect(generatedRule('ops/reports/weekly.md')?.id).toBe('report-folder');
    expect(generatedRule('a/b.md', { generated: 'true' })?.id).toBe('generated-frontmatter');
    expect(generatedRule('a/b.md', { type: 'report' })?.id).toBe('generated-frontmatter');
    expect(generatedRule('projects/report-ideas.md')).toBeNull();
    expect(generatedRule('memory/sessions/2026-01-02.md')).toBeNull();
    for (const r of GENERATED_RULES) expect(r.why).toMatch(/^[A-Z].+[^.]$/);
  });
  it('never counts a report as a linking note, so one real note cannot reach two sources', () => {
    fresh();
    put('projects/plan.md', '# Plan\nsee [[orbit-tracker]]');
    put('memory/drift-report.md', '# Drift\n- [[orbit-tracker]] is missing');
    const m = health('orbit-tracker');
    expect(m.sources).toEqual(['projects/plan.md']);
    expect(optionsOf(m)).not.toContain('create');
  });
  it('drops a link that only a report or a log holds, so no fix ever edits one', () => {
    fresh();
    put('memory/drift-report.md', '# Drift\n- [[target]] and [[name-goes-here]]');
    put('log.md', '# Log\n- wrote [[sample link]] notes');
    put('ops/notes.md', '---\ngenerated: true\n---\n# Generated\n[[made-up-thing]]');
    put('real.md', '# Real\nnothing broken');
    expect(index().linkHealth()).toEqual([]);
  });
  it('never offers a report as the note a link points at', () => {
    fresh();
    put('memory/overlap-scan-report.md', '# Overlap scan report');
    put('notes/a.md', '[[overlap-scan]]');
    expect(health('overlap-scan').candidates).toEqual([]);
  });
});

describe('candidate scoring', () => {
  it('never offers the linking note as the fix for its own link', () => {
    fresh();
    put('eval/finish-checklist-ledger.md', '# Finish checklist ledger\nfrom [[finish-checklist]]');
    expect(health('finish-checklist').candidates.map((c) => c.rel)).toEqual([]);
  });
  it('takes a title from the first line of a heading, so a one-line note does not match every link', () => {
    expect(cleanTitle('Kite onboarding\\n\\nThe whole body follows about lantern mirror quartz')).toBe('Kite onboarding');
    expect(cleanTitle(`${'word '.repeat(60)}end`).length).toBeLessThanOrEqual(120);
    fresh();
    put('inbox/kite.md', '# Kite onboarding\\n\\nNotes on lantern mirror quartz and the gadget pipeline, with a long body saved as one line');
    put('notes/a.md', 'see [[lantern-mirror-quartz]]');
    expect(index().note('inbox/kite.md').title).toBe('Kite onboarding');
    expect(health('lantern-mirror-quartz').candidates).toEqual([]);
  });
  it('treats a hyphen memory prefix like an underscore one', () => {
    fresh();
    put('memory/feedback_quiet_hours.md', '# Quiet hours');
    put('notes/a.md', '[[feedback-quiet-hours]]');
    expect(health('feedback-quiet-hours').candidates[0]).toMatchObject({ rel: 'memory/feedback_quiet_hours.md', exact: true });
  });
});

describe('writing a missing note', () => {
  const m = (sources, confidential = []) => ({ target: 'Orbit', sources, count: sources.length, candidates: [], confidential });
  it('needs two or more linking notes', () => {
    expect(createPlan(m(['projects/a.md']))).toMatchObject({ ok: false });
    expect(createPlan(m(['projects/a.md', 'projects/b.md']))).toEqual({ ok: true, folder: 'projects', confidential: null });
  });
  it('picks the folder most linking notes sit in, a sub-folder over the vault root on a tie', () => {
    expect(createPlan(m(['k/a.md', 'p/b.md', 'p/c.md'])).folder).toBe('p');
    expect(createPlan(m(['index.md', 'p/b.md'])).folder).toBe('p');
    expect(createPlan(m(['a.md', 'b.md'])).folder).toBe('');
  });
  it('never writes into session logs or eval runs', () => {
    expect(createPlan(m(['memory/sessions/2026-01-01.md', 'memory/sessions/2026-01-02.md']))).toMatchObject({ ok: false, reason: expect.stringMatching(/session logs or eval runs/) });
    expect(createPlan(m(['memory/eval/x/a.md', 'memory/eval/x/b.md', 'projects/c.md'])).folder).toBe('projects');
  });
  it('carries a confidential mark forward when any linking note has one', () => {
    expect(createPlan(m(['p/a.md', 'p/b.md'], ['false', 'team-internal'])).confidential).toBe('team-internal');
    const issue = issueOf({ ...m(['p/a.md', 'p/b.md'], ['team-internal']), contexts: [{ rel: 'p/a.md', text: 'Orbit is the tracker for launch windows and crew rotations' }] });
    expect(issue).toMatchObject({ action: 'create', reviewOnly: true, confidential: 'team-internal', createIn: 'p' });
    expect(contextNote(issue)).toMatch(/^---\nconfidential: team-internal\n---\n\n# Orbit\n/);
    expect(contextNote(issueOf(m(['p/a.md', 'p/b.md'])))).toMatch(/^# Orbit\n/);
  });
  it('reads the mark from the linking notes in the index', () => {
    fresh();
    put('team/a.md', '---\nconfidential: team-internal\n---\n[[orbit]]');
    put('team/b.md', '[[orbit]]');
    expect(issueOf(health('orbit'))).toMatchObject({ action: 'create', confidential: 'team-internal' });
  });
  it('makes a weak match review-only and offers it before writing a note', () => {
    const weak = { rel: 'misc/orbit-notes-old.md', title: 'Orbit notes old', name: null, exact: false, score: 0.4, cover: 0.5, kindClash: false, shared: ['orbit', 'old'], neighbor: false, sameFolder: false };
    const i = issueOf({ target: 'orbit tracker old', sources: ['p/a.md', 'p/b.md'], count: 2, candidates: [weak] });
    expect(i).toMatchObject({ action: 'relink', next: 'create', reviewOnly: true });
  });
});

describe('the existence check before writing a note', () => {
  const opts = (extra = {}) => ({ useGit: false, skillRoots: [], ...extra });
  it('finds folders, scripts, skills and files outside the vault in the repo', () => {
    const root = fresh();
    vault = root;
    put('vault/projects/checks-2026-01-01/index.md', '# Checks');
    put('vault/projects/sprint-folder/a.md', '# A');
    put('vault/scripts/tidy-links.py', 'print(1)');
    put('tools/skills/pack-up/SKILL.md', '# Pack up');
    put('context/tool-notes.md', '# Tools');
    const f = createElsewhere(opts({ vault: path.join(root, 'vault'), gitTop: () => root }));
    expect(f.find('checks-2026-01-01')).toEqual({ kind: 'folder', where: 'projects/checks-2026-01-01' });
    expect(f.find('tidy-links')).toMatchObject({ kind: 'script', where: 'vault/scripts/tidy-links.py' });
    expect(f.find('pack-up')).toMatchObject({ kind: 'skill', where: 'tools/skills/pack-up' });
    expect(f.find('tool-notes')).toMatchObject({ kind: 'file', where: 'context/tool-notes.md' });
    expect(f.find('nothing-here')).toBeNull();
  });
  it('finds skills in the skill folders it is given', () => {
    const root = fresh();
    put('home-skills/learn-loop/SKILL.md', '# x');
    put('vault/a.md', '# a');
    const f = createElsewhere(opts({ vault: path.join(root, 'vault'), skillRoots: [path.join(root, 'home-skills')] }));
    expect(f.find('learn-loop')).toMatchObject({ kind: 'skill' });
  });
  it('finds notes on other local branches, and skips the check without git', () => {
    const root = fresh();
    put('vault/a.md', '# a');
    let reads = 0;
    const f = createElsewhere(opts({
      vault: path.join(root, 'vault'), gitTop: () => root,
      listBranches: () => [{ name: 'topic/review', sha: 'abc' }],
      listTree: (_root, sha, prefix) => { reads++; expect([sha, prefix]).toEqual(['abc', 'vault']); return ['vault/knowledge/merge-notes-review.md', 'vault/x.txt']; },
    }));
    expect(f.find('merge-notes-review')).toEqual({ kind: 'branch', where: 'knowledge/merge-notes-review.md', branch: 'topic/review' });
    f.find('merge-notes-review');
    expect(reads).toBe(1);
    expect(createElsewhere(opts({ vault: path.join(root, 'vault') })).find('merge-notes-review')).toBeNull();
  });
  it('reads the branch list once for many links, and again after reset', () => {
    const root = fresh();
    put('vault/a.md', '# a');
    let lists = 0;
    const f = createElsewhere(opts({ vault: path.join(root, 'vault'), gitTop: () => root, listBranches: () => { lists++; return []; }, listTree: () => [] }));
    for (const t of ['one', 'two', 'three', 'four']) f.find(t);
    expect(lists).toBe(1);
    f.reset();
    f.find('one');
    expect(lists).toBe(2);
  });
  it('points a link to a folder at its index note, and leaves a link to a skill or a branch note for review', () => {
    expect(folderIndex('p/checks', ['p/checks/index.md', 'p/checks/x.md'])).toBe('p/checks/index.md');
    expect(folderIndex('p/sprint', ['p/sprint/a.md'])).toBeNull();
    const finder = { find: (t) => ({ checks: { kind: 'folder', where: 'p/checks' }, 'pack-up': { kind: 'skill', where: 'tools/skills/pack-up' }, 'merge-notes-review': { kind: 'branch', where: 'k/merge-notes-review.md', branch: 'topic/review' } })[t] ?? null };
    const items = withFound([
      { target: 'checks', sources: ['a.md'], count: 1, candidates: [] },
      { target: 'pack-up', sources: ['a.md', 'b.md'], count: 2, candidates: [] },
      { target: 'merge-notes-review', sources: ['a.md', 'b.md'], count: 2, candidates: [] },
    ], finder, ['p/checks/index.md']);
    const [folder, skill, branch] = items.map(issueOf);
    expect(folder).toMatchObject({ action: 'relink', next: 'leave', candidate: { rel: 'p/checks/index.md', folder: true } });
    expect(folder.problem).toMatch(/index note of the folder with that name/);
    expect(skill).toMatchObject({ action: 'leave', category: 'elsewhere', title: '2 notes link to “pack-up”, which is a skill' });
    expect(branch).toMatchObject({ action: 'leave', category: 'elsewhere' });
    expect(branch.problem).toMatch(/on the branch topic\/review/);
  });
  it('keeps an exact name match over anything found elsewhere', () => {
    const finder = { find: () => ({ kind: 'folder', where: 'x' }) };
    const [m] = withFound([{ target: 'ada', sources: ['a.md'], count: 1, candidates: [{ rel: 'people/ada.md', title: 'Ada', name: null, exact: true }] }], finder, []);
    expect(issueOf(m).action).toBe('alias');
  });
});

describe('no notes for link names that only reports or examples hold', () => {
  const plan = (target, sources) => createPlan({ target, sources, count: sources.length, candidates: [], confidential: [] });
  it('never writes a note named by a common word or a placeholder', () => {
    for (const t of ['link', 'Links', 'wiki links', 'filename-without-extension', 'filename', 'note', 'page', 'todo', '<note name>', 'your-note', 'name-goes-here', 'some-topic']) expect(genericTarget(t)).toBe(true);
    for (const t of ['Orbit', 'nova-apps-platform', 'link-rot-study', 'Page Turner']) expect(genericTarget(t)).toBe(false);
    expect(plan('link', ['p/a.md', 'p/b.md'])).toMatchObject({ ok: false, reason: expect.stringMatching(/common word or a placeholder/) });
    expect(plan('Orbit', ['p/a.md', 'p/b.md'])).toMatchObject({ ok: true });
  });
  it('reads lines and notes that report on links', () => {
    expect(reportLine('- [[link]] dead-wikilink in `notes/a.md`')).toBe(true);
    expect(reportLine('[[filename-without-extension]] has no matching vault file')).toBe(true);
    expect(reportLine('Use `[[name]]` to link a note, see [[Setup]]')).toBe(true);
    expect(reportLine('Fly the [[Kite]] on Sunday with `npm start`')).toBe(false);
    expect(linkReport('# Vault drift report\n- [[a]]\n')).toBe(true);
    expect(linkReport('# Notes\n- [[a]] dead link\n- [[b]] dead link\n')).toBe(true);
    expect(linkReport('# Notes\nOne dead link to [[a]] here.\nSee [[b]].\n')).toBe(false);
    expect(linkReport('', 'Broken links found 2026-11-10')).toBe(true);
  });
  it('drops links that a drift report lists as findings, so approving writes no stub', () => {
    fresh();
    put('ops/vault-drift-2026-11-15.md', '# Vault drift 2026-11-15\n\n- `a.md`: [[link]] (dead-wikilink)\n- `b.md`: [[filename-without-extension]] has no matching vault file\n- [[wiki links]] dead-wikilink\n');
    put('ops/lint-2026-11-16.md', '# Lint\n\nPattern `[[filename-without-extension]]` shows the syntax.\n');
    put('projects/plan.md', '# Plan\nWe write [[wiki links]] by hand. See [[link]] too.\n');
    put('projects/roadmap.md', '# Roadmap\nAll [[wiki links]] get checked. The [[link]] page.\n');
    const i = index();
    const names = i.linkHealth().map((h) => h.target.toLowerCase());
    expect(names).not.toContain('filename-without-extension');
    const prose = i.linkHealth().find((h) => h.target === 'wiki links');
    expect(prose.sources.sort()).toEqual(['projects/plan.md', 'projects/roadmap.md']);
    expect(optionsOf(prose)).not.toContain('create');
    expect(optionsOf(i.linkHealth().find((h) => h.target === 'link'))).not.toContain('create');
  });
  it('treats links in inline code and fenced code as code, also with double backticks', () => {
    fresh();
    put('a.md', '# A\nType ``[[ghost-one]]`` here.\n\n```\n[[ghost-two]]\n```\n~~~md\n[[ghost-three]]\n~~~\n');
    const names = index().linkHealth().map((h) => h.target);
    expect(names).toEqual([]);
  });
  it('never puts a stub in a sessions or log folder, at any depth', () => {
    expect(plan('nova-apps-platform', ['MyBrain/memory/sessions/2026-11-01.md', 'MyBrain/memory/sessions/2026-11-02.md'])).toMatchObject({ ok: false });
    expect(plan('nova-apps-platform', ['MyBrain/memory/sessions/2026-11-01.md', 'MyBrain/memory/sessions/2026-11-02.md', 'MyBrain/04-projects/a.md'])).toMatchObject({ ok: true, folder: 'MyBrain/04-projects' });
    expect(plan('nova-apps-platform', ['work/logs/a.md', 'work/logs/b.md', 'work/c.md']).folder).toBe('work');
  });
});
