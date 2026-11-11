import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentArgs, safetySettings } from '../agent.js';

describe('safetySettings', () => {
  it('passes the compiled guardrails to the read guard as flags and attaches only the included hooks that exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-safety-'));
    mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
    writeFileSync(path.join(root, '.claude/hooks/opted-out-guard.py'), '# guard\n');
    writeFileSync(path.join(root, '.claude/hooks/tripwire.sh'), '# post\n');
    const s = safetySettings(root, {
      denyDirs: ['02-personal', 'clients/acme'], frontmatterKeys: ['confidential', 'legal_hold'], secretPattern: null, secretsOff: false,
      hooks: [{ path: path.join(root, '.claude/hooks/opted-out-guard.py'), stage: 'pre' }, { path: path.join(root, '.claude/hooks/tripwire.sh'), stage: 'post' }, { path: path.join(root, '.claude/hooks/missing.py'), stage: 'pre' }],
    });
    const guard = s.hooks.PreToolUse[0].hooks[0].command;
    expect(guard).toContain('read-guard.py');
    expect(guard).toContain('--deny "02-personal" --deny "clients/acme"');
    expect(guard).toContain('--frontmatter-key "confidential" --frontmatter-key "legal_hold"');
    expect(guard).toContain('--log-denied');
    expect(guard).not.toContain('--no-secrets');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[1].hooks[0].command).toBe(`python3 "${path.join(root, '.claude/hooks/opted-out-guard.py')}"`);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(`zsh "${path.join(root, '.claude/hooks/tripwire.sh')}"`);
  });
  it('turns the secret rule off or extends it when the rules say so, and runs with nothing but the built-in guard by default', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-safety-'));
    expect(safetySettings(root, { secretsOff: true }).hooks.PreToolUse[0].hooks[0].command).toContain('--no-secrets');
    expect(safetySettings(root, { secretPattern: String.raw`\.sqlite$` }).hooks.PreToolUse[0].hooks[0].command).toContain(String.raw`--secret-pattern "\.sqlite$"`);
    const plain = safetySettings(root);
    expect(plain.hooks.PreToolUse).toHaveLength(1);
    expect(plain.hooks.PostToolUse).toHaveLength(0);
  });
});

describe('power-ups in the agent command line', () => {
  const base = { model: 'sonnet', system: 'S', root: '/v', guards: { denyDirs: [] } };
  const flag = (args, name) => args[args.indexOf(name) + 1];
  it('stays read-only with nothing included', () => {
    const a = agentArgs(base);
    expect(flag(a, '--tools')).toBe('Read,Grep,Glob');
    expect(flag(a, '--setting-sources')).toBe('');
    expect(a).not.toContain('--mcp-config');
    expect(flag(a, '--append-system-prompt')).toBe('S');
  });
  it('puts the instructions file into the prompt, and leaves it to Claude Code once project settings load', () => {
    const readFile = () => '# Rules\nbe literal';
    const a = agentArgs({ ...base, extra: { dirs: [], powers: { instructions: '/v/CLAUDE.md' } }, readFile });
    expect(flag(a, '--append-system-prompt')).toContain('be literal');
    const b = agentArgs({ ...base, extra: { dirs: [], powers: { instructions: '/v/CLAUDE.md', skills: true } }, readFile });
    expect(flag(b, '--append-system-prompt')).toBe('S');
    expect(flag(b, '--setting-sources')).toBe('project');
    expect(flag(b, '--tools')).toBe('Read,Grep,Glob,Skill');
  });
  it('opens the Agent tool for agents and names each MCP server from the vault config', () => {
    const readFile = () => JSON.stringify({ mcpServers: { granola: {}, plane: {} } });
    const a = agentArgs({ ...base, extra: { dirs: [], powers: { agents: true, mcp: '/v/.mcp.json' } }, readFile });
    expect(flag(a, '--tools')).toBe('Read,Grep,Glob,Agent');
    expect(a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--setting-sources'))).toEqual(['Read', 'Grep', 'Glob', 'Agent', 'mcp__granola', 'mcp__plane']);
    expect(a).toContain('--strict-mcp-config');
    expect(flag(a, '--mcp-config')).toBe('/v/.mcp.json');
  });
  it('a broken .mcp.json adds no servers and no config', () => {
    const a = agentArgs({ ...base, extra: { dirs: [], powers: { mcp: '/v/.mcp.json' } }, readFile: () => '{' });
    expect(a).not.toContain('--mcp-config');
  });
});
