import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const calls = [];
vi.mock('node:child_process', () => ({
  spawn: (cmd, args) => {
    calls.push({ cmd, args });
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { end: () => setTimeout(() => { p.stdout.emit('data', 'ok'); p.emit('close', 0); }, 0) };
    p.kill = () => {};
    return p;
  },
}));

const { claudeText } = await import('../models.js');

describe('claudeText', () => {
  it('runs Claude Code with the person\'s hooks and MCP servers off', async () => {
    await expect(claudeText({ prompt: 'hi', system: 'Reply with ok.', model: 'haiku', cwd: '/tmp' })).resolves.toBe('ok');
    const { cmd, args } = calls.at(-1);
    expect(cmd).toBe('claude');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });
});
