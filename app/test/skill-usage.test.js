import { describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectSlugs } from '../context-budget.js';
import { folders } from '../keeper.js';
import { detect, resolvePlugins, scanContext } from '../plugins.js';
import { namesIn, scanTranscripts, setStash, skillUsage, stashSkill } from '../skill-usage.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const temp = (name) => mkdtempSync(path.join(tmpdir(), `${name}-`));
const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const skill = (name, body = 'Does one thing.') => `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n\n${body}\n`;
const toolUse = (name, at) => JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'private words' }, { type: 'tool_use', name: 'Skill', input: { skill: name } }] } });
const typed = (name, at) => JSON.stringify({ type: 'user', timestamp: at, message: { content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>secret</command-args>` } });
const said = (at) => JSON.stringify({ type: 'user', timestamp: at, message: { content: 'Please plan the release with the Skill tool.' } });

// a vault with 32 skills, and transcripts in a fake home where only two of them ran
function setup() {
  const home = temp('skills-home');
  const root = temp('skills-vault');
  for (let i = 1; i <= 30; i++) put(root, `.claude/skills/idle-${i}/SKILL.md`, skill(`idle-${i}`));
  put(root, '.claude/skills/plan/SKILL.md', skill('plan'));
  put(root, '.claude/skills/ship/SKILL.md', skill('ship', 'Run /idle-3 first, then ship.'));
  const proj = path.join(home, '.claude/projects', projectSlugs(root)[0]);
  put(proj, 'a.jsonl', [said(ago(120)), toolUse('plan', ago(10)), toolUse('plan', ago(3)), 'not json'].join('\n') + '\n');
  put(proj, 'b.jsonl', [typed('ship', ago(75))].join('\n') + '\n');
  return { home, root, proj };
}

describe('skill usage', () => {
  it('reads skill names from tool calls and typed commands only', () => {
    expect(namesIn(JSON.parse(toolUse('plan', ago(1))))).toEqual(['plan']);
    expect(namesIn(JSON.parse(typed('ship', ago(1))))).toEqual(['ship']);
    expect(namesIn({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SlashCommand', input: { command: '/plan now' } }] } })).toEqual(['plan']);
    expect(namesIn(JSON.parse(said(ago(1))))).toEqual([]);
  });
  it('shows 30 unused skills and counts the ones that ran', async () => {
    const { home, root } = setup();
    const u = await skillUsage({ root, home, now: NOW });
    expect(u.transcripts).toBe(2);
    expect(u.coverageDays).toBe(120);
    const by = Object.fromEntries(u.skills.map((s) => [s.name, s]));
    expect(by.plan).toMatchObject({ runs: 2, last: ago(3), unused: { 60: false, 90: false } });
    expect(by.ship).toMatchObject({ runs: 1, unused: { 60: true, 90: false } });
    expect(u.skills.filter((s) => s.unused[90]).length).toBe(30);
    expect(u.skills.filter((s) => s.unused[60]).length).toBe(31);
    expect(by['idle-3'].namedBy).toEqual(['ship']);
    expect(by['idle-4'].namedBy).toEqual([]);
    // nothing from the transcripts beyond names and dates comes back
    expect(JSON.stringify(u)).not.toMatch(/private words|secret|Please plan/);
  });
  it('reads subagent transcripts and dates coverage from the first timestamped line', async () => {
    const { proj } = setup();
    put(proj, 'sess-1/subagents/agent-a.jsonl', [JSON.stringify({ type: 'summary' }), toolUse('ship', ago(2)), toolUse('plan', ago(200))].join('\n') + '\n');
    const t = await scanTranscripts(proj);
    expect(t.files).toBe(3);
    expect(t.uses.ship).toMatchObject({ runs: 2, last: ago(2) });
    // the first timestamped line of each file sets its start, so the late line dated 200 days ago does not
    expect(t.first).toBe(ago(120));
  });
  it('reuses the counts of a transcript that has not changed', async () => {
    const { proj } = setup();
    const cache = new Map();
    await scanTranscripts(proj, cache);
    const before = cache.get(path.join(proj, 'a.jsonl'));
    await scanTranscripts(proj, cache);
    expect(cache.get(path.join(proj, 'a.jsonl'))).toBe(before);
    writeFileSync(path.join(proj, 'a.jsonl'), toolUse('plan', ago(1)) + '\n');
    const t = await scanTranscripts(proj, cache);
    expect(t.uses.plan).toMatchObject({ runs: 1, last: ago(1) });
  });
  it('stashes by changing only that SKILL.md frontmatter, and unstashes back', async () => {
    const { home, root } = setup();
    const file = path.join(root, '.claude/skills/idle-7/SKILL.md');
    const original = readFileSync(file, 'utf8');
    const others = readdirSync(path.join(root, '.claude/skills')).filter((d) => d !== 'idle-7').map((d) => readFileSync(path.join(root, '.claude/skills', d, 'SKILL.md'), 'utf8'));
    expect(stashSkill(root, 'idle-7', true)).toEqual({ changed: true, path: '.claude/skills/idle-7/SKILL.md' });
    expect(readFileSync(file, 'utf8')).toBe(original.replace('description: The idle-7 skill\n', 'description: The idle-7 skill\ndisable-model-invocation: true\n'));
    expect(stashSkill(root, 'idle-7', true).changed).toBe(false);
    expect((await skillUsage({ root, home, now: NOW })).skills.find((s) => s.dir === 'idle-7').stashed).toBe(true);
    stashSkill(root, 'idle-7', false);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readdirSync(path.join(root, '.claude/skills')).filter((d) => d !== 'idle-7').map((d) => readFileSync(path.join(root, '.claude/skills', d, 'SKILL.md'), 'utf8'))).toEqual(others);
    expect(readdirSync(path.join(root, '.claude/skills/idle-7'))).toEqual(['SKILL.md']);
  });
  it('keeps a linked skill a link', () => {
    const { root } = setup();
    const elsewhere = temp('skills-src');
    put(elsewhere, 'linked/SKILL.md', skill('linked'));
    symlinkSync(path.join(elsewhere, 'linked'), path.join(root, '.claude/skills/linked'));
    stashSkill(root, 'linked', true);
    expect(lstatSync(path.join(root, '.claude/skills/linked')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(elsewhere, 'linked/SKILL.md'), 'utf8')).toContain('disable-model-invocation: true');
  });
  it('refuses a name outside the skills folder', () => {
    const { root } = setup();
    for (const bad of ['../x', '..', 'a/b', '', '/etc']) expect(() => stashSkill(root, bad, true)).toThrow('Unknown skill');
    expect(() => stashSkill(root, 'missing', true)).toThrow('Unknown skill');
  });
  it('edits the stash line and nothing else', () => {
    expect(setStash('# no frontmatter\n', true)).toBe('---\ndisable-model-invocation: true\n---\n# no frontmatter\n');
    expect(setStash('---\nname: a\ndisable-model-invocation: false\n---\nbody\n', true)).toBe('---\nname: a\ndisable-model-invocation: true\n---\nbody\n');
    expect(setStash('---\nname: a\n---\nbody\n', false)).toBe(null);
    expect(setStash('---\r\nname: a\r\n---\r\nbody\r\n', true)).toBe('---\r\nname: a\r\ndisable-model-invocation: true\r\n---\r\nbody\r\n');
  });
  it('starts off with a note on what it reads, and leaves the job to a vault that already tracks skill usage', () => {
    const { root } = setup();
    const row = resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'skills');
    expect(row).toMatchObject({ owner: 'vault', report: true, isNew: false, evidence: [] });
    expect(row.note).toMatch(/transcripts in ~\/\.claude\/projects, on this Mac only/);
    put(root, 'scripts/skill-usage.py', 'print(1)\n');
    expect(resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'skills')).toMatchObject({ owner: 'vault', evidence: [{ path: 'scripts/skill-usage.py', why: 'script' }] });
  });
});
