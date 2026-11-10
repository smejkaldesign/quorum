import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TRADEOFFS, dueFor, importPrompt, parseSummary, runImport, runnerCommand } from '../sources/agent-import.js';

const source = { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp' };
const quorum = { runtime: '/Applications/Quorum.app/Contents/MacOS/Quorum', cli: '/x/cli/quorum.mjs', env: { ELECTRON_RUN_AS_NODE: '1' } };

describe('the task and the trade-offs', () => {
  it('names both servers, the window and the import tool, and forbids files and commands', () => {
    const p = importPrompt({ source, server: 'granola-notes', since: '2026-11-01T00:00:00Z' });
    expect(p).toContain('"granola-notes" MCP server');
    expect(p).toContain('on or after 2026-11-01');
    expect(p).toContain('import_meeting');
    expect(p).toContain('do not read or write files');
    expect(importPrompt({ source, server: 'g' })).not.toContain('on or after');
  });
  it('states the four costs in plain words', () => {
    const t = TRADEOFFS('Claude Code', 'Granola');
    expect(t).toHaveLength(4);
    expect(t[0]).toMatch(/tokens/);
    expect(t[1]).toMatch(/wording can change/);
    expect(t[3]).toMatch(/signed in/);
  });
});

describe('runnerCommand', () => {
  it('adds the quorum server to Claude Code for the run and allows only the two servers\' tools', () => {
    const c = runnerCommand('claude-code', { server: 'granola', prompt: 'do it', quorum });
    expect(c.bin).toBe('claude');
    expect(c.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    const cfg = JSON.parse(c.args[c.args.indexOf('--mcp-config') + 1]);
    expect(cfg.mcpServers.quorum).toEqual({ command: quorum.runtime, args: [quorum.cli, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect(c.args).not.toContain('--strict-mcp-config');
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1, c.args.indexOf('--allowedTools') + 3)).toEqual(['mcp__granola__*', 'mcp__quorum__*']);
    expect(c.stdin).toBe('do it');
  });
  it('gives Codex the quorum server as config overrides and reads the prompt from stdin', () => {
    const c = runnerCommand('codex', { server: 'granola', prompt: 'do it', quorum });
    expect(c.bin).toBe('codex');
    expect(c.args[0]).toBe('exec');
    expect(c.args).toContain('--json');
    expect(c.args).toContain(`mcp_servers.quorum.command=${JSON.stringify(quorum.runtime)}`);
    expect(c.args).toContain('mcp_servers.quorum.args=["/x/cli/quorum.mjs","mcp"]');
    expect(c.args).toContain('mcp_servers.quorum.env={ ELECTRON_RUN_AS_NODE = "1" }');
    expect(c.args.at(-1)).toBe('-');
  });
  it('passes Antigravity the prompt as an argument, since it has no per-run MCP flag', () => {
    const c = runnerCommand('antigravity', { server: 'granola', prompt: 'do it', quorum });
    expect(c.bin).toBe('agy');
    expect(c.args.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(c.stdin).toBeNull();
  });
});

describe('runImport', () => {
  const fakeSpawn = (behave) => (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.stdin = { end: (s) => { proc.input = s; } };
    proc.kill = () => {};
    setTimeout(() => behave(proc, bin, args), 0);
    return proc;
  };
  it('counts what landed in the folder and reads the agent\'s one-line summary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-import-'));
    const spawnImpl = fakeSpawn((proc) => {
      writeFileSync(path.join(dir, '2026-11-09-a.md'), '---\nsource_id: a\n---\n');
      writeFileSync(path.join(dir, '2026-11-09-b.md'), '---\nsource_id: b\n---\n');
      proc.stdout.emit('data', JSON.stringify({ type: 'result', result: 'Imported 2, skipped 5' }));
      proc.emit('close', 0);
    });
    let spawned = null;
    const spy = (bin, args, opts) => { spawned = { bin, args, opts }; return spawnImpl(bin, args, opts); };
    const r = await runImport({ runnerId: 'claude-code', server: 'granola', source, since: null, quorum, dir, cwd: dir, spawnImpl: spy, env: { PATH: '/bin', ANTHROPIC_API_KEY: 'never', OPENAI_API_KEY: 'never' } });
    expect(spawned.opts.cwd).toBe(dir);
    expect(spawned.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned.opts.env.OPENAI_API_KEY).toBeUndefined();
    expect(r).toMatchObject({ imported: 2, skipped: 5, listed: 7, caughtUp: true, said: { imported: 2, skipped: 5 } });
  });
  it('turns a non-zero exit into the first stderr line and a missing binary into a plain message', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-import-'));
    await expect(runImport({ runnerId: 'codex', server: 'g', source, quorum, dir, spawnImpl: fakeSpawn((proc) => { proc.stderr.emit('data', 'not logged in\nmore'); proc.emit('close', 2); }) })).rejects.toThrow('not logged in');
    await expect(runImport({ runnerId: 'codex', server: 'g', source, quorum, dir, spawnImpl: fakeSpawn((proc) => { const e = new Error('spawn codex ENOENT'); e.code = 'ENOENT'; proc.emit('error', e); }) })).rejects.toThrow('codex is not on PATH');
  });
});

describe('schedule', () => {
  it('runs at most once an hour or once a day, never when off', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(dueFor('off', null, now)).toBe(false);
    expect(dueFor('hourly', null, now)).toBe(true);
    expect(dueFor('hourly', '2026-11-10T11:30:00Z', now)).toBe(false);
    expect(dueFor('hourly', '2026-11-10T10:59:00Z', now)).toBe(true);
    expect(dueFor('daily', '2026-11-09T12:30:00Z', now)).toBe(false);
    expect(dueFor('daily', '2026-11-09T11:00:00Z', now)).toBe(true);
    expect(parseSummary('all done. Imported 3, skipped 10')).toEqual({ imported: 3, skipped: 10 });
    expect(parseSummary('nothing')).toBeNull();
  });
});
