import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LARGE_FILE, contextBudget, memoryCut, projectDir, projectSlugs } from '../context-budget.js';
import { LEARNED_CLOSE, LEARNED_OPEN, folders } from '../keeper.js';
import { detect, resolvePlugins, scanContext } from '../plugins.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const temp = (name) => mkdtempSync(path.join(tmpdir(), `${name}-`));
const lines = (n, f = (i) => `- [Entry ${i}](entry-${i}.md) one line`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

// a vault and a fake home with Claude Code's auto memory for it, both under the temp folder
function setup({ memory = 0, claude = '# Rules\n\nWrite plainly.\n' } = {}) {
  const home = temp('ctx-home');
  const root = temp('ctx-vault');
  put(root, 'CLAUDE.md', claude);
  if (memory) put(home, `.claude/projects/${projectSlugs(root)[0]}/memory/MEMORY.md`, lines(memory));
  return { home, root };
}

describe('context budget', () => {
  it('names the memory entries past line 200', () => {
    expect(memoryCut(lines(237))).toEqual({ lines: 237, cut: 37 });
    expect(memoryCut(lines(200))).toEqual({ lines: 200, cut: 0 });
    expect(memoryCut(lines(198) + '\n\n\n- [Late](late.md)\n')).toMatchObject({ cut: 1 });
  });
  it('finds the project folder under either slug form', () => {
    const home = temp('ctx-home');
    const root = path.join(temp('ctx-a'), 'my.vault');
    mkdirSync(root);
    expect(projectDir(root, home)).toBe(path.join(home, '.claude/projects', projectSlugs(root)[0]));
    const older = path.join(home, '.claude/projects', path.resolve(root).replace(/[/.]/g, '-'));
    mkdirSync(older, { recursive: true });
    expect(projectDir(root, home)).toBe(older);
  });
  it('reports a 237-line MEMORY.md as 37 entries that never load', () => {
    const { home, root } = setup({ memory: 237 });
    const c = contextBudget({ root, home });
    const mem = c.files.find((f) => f.scope === 'memory');
    expect(mem).toMatchObject({ lines: 237, cut: 37 });
    expect(mem.path.startsWith('~/.claude/projects/')).toBe(true);
    expect(mem.warn).toMatch(/^37 memory entries never load\./);
    expect(c.warnings.some((w) => w.includes('37 memory entries never load'))).toBe(true);
    // only the first 200 lines count toward a session
    expect(mem.loaded).toBeLessThan(mem.chars);
  });
  it('lists the user file, the root file and nested files with their scope', () => {
    const { home, root } = setup();
    put(home, '.claude/CLAUDE.md', '# Mine\n');
    put(root, 'projects/alpha/CLAUDE.md', '# Alpha\n');
    put(root, 'node_modules/pkg/CLAUDE.md', '# skipped\n');
    put(root, '.hidden/CLAUDE.md', '# skipped\n');
    const c = contextBudget({ root, home });
    const by = Object.fromEntries(c.files.map((f) => [f.path, f.scope]));
    expect(by).toMatchObject({ '~/.claude/CLAUDE.md': 'user', 'CLAUDE.md': 'project', 'projects/alpha/CLAUDE.md': 'nested' });
    expect(Object.keys(by).some((p) => p.includes('node_modules') || p.includes('.hidden'))).toBe(false);
    // nested files are not part of every session
    expect(c.total.chars).toBe('# Mine\n'.length + '# Rules\n\nWrite plainly.\n'.length);
  });
  it('shows the learned block share and the agent read limit', () => {
    const facts = Array.from({ length: 10 }, (_, i) => `- Fact ${i} about the team ([[note-${i}]], 2026-11-0${i % 9 + 1})`).join('\n');
    const learned = `${LEARNED_OPEN}\n## Learned from meetings\n\n${facts}\n${LEARNED_CLOSE}\n`;
    const { home, root } = setup({ claude: `# Rules\n\n${'x'.repeat(17000)}\n\n${learned}` });
    // without the Instructions item in the agent's prompt, there is no agent cut to report
    expect(contextBudget({ root, home }).agent).toBe(null);
    const c = contextBudget({ root, home, instructions: path.join(root, 'CLAUDE.md') });
    expect(c.quorum).toMatchObject({ path: 'CLAUDE.md', chars: learned.length - 1, everySession: true });
    expect(c.quorum.share).toBeGreaterThan(0);
    expect(c.quorum.share).toBeLessThan(0.1);
    expect(c.agent).toMatchObject({ path: 'CLAUDE.md', limit: 16000, learnedCut: true });
    expect(c.agent.cut).toBe(c.files.find((f) => f.path === 'CLAUDE.md').chars - 16000);
    expect(c.warnings.at(-1)).toMatch(/first 16,000 characters.*learned facts/);
  });
  it('names .quorum/learned.md when the block in CLAUDE.md only points to it', () => {
    const pointer = `${LEARNED_OPEN}\n## Learned from meetings\n\nSee .quorum/learned.md.\n${LEARNED_CLOSE}\n`;
    const { home, root } = setup({ claude: `# Rules\n\n${pointer}` });
    put(root, '.quorum/learned.md', '# Learned from meetings\n\n- A fact\n');
    const c = contextBudget({ root, home });
    expect(c.quorum).toMatchObject({ chars: pointer.length - 1, aside: { path: '.quorum/learned.md', chars: 34 } });
    expect(c.files.some((f) => f.path === '.quorum/learned.md')).toBe(false);
  });
  it('reports the cut for a custom instructions file the agent loads', () => {
    const { home, root } = setup();
    const custom = path.join(temp('ctx-custom'), 'RULES.md');
    writeFileSync(custom, 'z'.repeat(16500));
    const c = contextBudget({ root, home, instructions: custom });
    expect(c.agent).toMatchObject({ path: custom, chars: 16500, cut: 500, learnedCut: false });
    expect(c.warnings.at(-1)).toMatch(/^.*RULES\.md: Quorum's own agent reads the first 16,000 characters, so the last 500/);
  });
  it('follows .claude/CLAUDE.md, rules and @imports, once each and no deeper than five hops', () => {
    const { home, root } = setup({ claude: '# Rules\n\nSee @docs/style.md and @~/shared.md. Mail ada@example.com.\n\n```\n@docs/not-this.md\n```\n' });
    put(root, 'docs/style.md', 'Style. Also @../CLAUDE.md and @chain/1.md\n');
    put(root, 'docs/not-this.md', 'skipped\n');
    for (let i = 1; i <= 7; i++) put(root, `docs/chain/${i}.md`, `Hop ${i} @${i + 1}.md\n`);
    put(home, 'shared.md', 'Shared rules\n');
    put(root, '.claude/CLAUDE.md', '# Project rules\n');
    put(root, '.claude/rules/always.md', '# Always\n');
    put(root, '.claude/rules/tests.md', '---\npaths:\n  - "test/**"\n---\n# Tests\n');
    const c = contextBudget({ root, home });
    const by = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(by['docs/style.md']).toMatchObject({ scope: 'project', importedBy: 'CLAUDE.md' });
    expect(by['~/shared.md']).toMatchObject({ scope: 'project', importedBy: 'CLAUDE.md' });
    expect(by['docs/not-this.md']).toBeUndefined();
    expect(Object.keys(by).some((p) => p.includes('example.com'))).toBe(false);
    expect(by['.claude/CLAUDE.md'].scope).toBe('project');
    expect(by['.claude/rules/always.md'].scope).toBe('project');
    expect(by['.claude/rules/tests.md'].scope).toBe('paths');
    // CLAUDE.md -> style -> 1 -> 2 -> 3 -> 4 is five hops; 5.md and beyond are not read
    expect(Object.keys(by).filter((p) => p.startsWith('docs/chain/')).sort()).toEqual(['docs/chain/1.md', 'docs/chain/2.md', 'docs/chain/3.md', 'docs/chain/4.md']);
    expect(c.files.filter((f) => f.path === 'CLAUDE.md')).toHaveLength(1);
  });
  it('finds the learned block in a vault deep under the root or in a dot folder', () => {
    const learned = `${LEARNED_OPEN}\n- A fact\n${LEARNED_CLOSE}\n`;
    for (const sub of ['.vault', 'a/b/c/d/e/vault']) {
      const { home, root } = setup();
      const vault = path.join(root, sub);
      put(vault, 'CLAUDE.md', `# Vault\n\n${learned}`);
      const c = contextBudget({ root, vault, home });
      expect(c.quorum).toMatchObject({ path: `${sub}/CLAUDE.md`, everySession: false, share: null });
    }
  });
  it('warns on a CLAUDE.md past the size Claude Code flags', () => {
    const { home, root } = setup({ claude: 'y'.repeat(LARGE_FILE + 1) });
    const c = contextBudget({ root, home });
    expect(c.files.find((f) => f.path === 'CLAUDE.md').warn).toMatch(/^Over 40,000 characters/);
  });
  it('leaves the job to a vault with its own context check', () => {
    const { root } = setup();
    expect(resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'context')).toMatchObject({ owner: 'quorum', report: true, evidence: [] });
    put(root, '.claude/hooks/context-budget.sh', 'echo\n');
    const row = resolvePlugins(detect(scanContext(root, root, folders(root)))).find((r) => r.id === 'context');
    expect(row).toMatchObject({ owner: 'vault', isNew: true, evidence: [{ path: '.claude/hooks/context-budget.sh', why: 'hook' }] });
  });
});
