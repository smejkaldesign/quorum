import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { claudeRun } from '../claudeCli.js';

const fake = ({ out = '', code = 0, error = false, hang = false } = {}) => (bin, args, opts) => {
  const p = new EventEmitter();
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.kill = () => {};
  p.seen = { bin, args, env: opts.env };
  setTimeout(() => { if (error) { p.emit('error', new Error('ENOENT')); return; } if (hang) return; p.stdout.emit('data', out); p.emit('close', code); }, 0);
  return p;
};

describe('claude CLI helper', () => {
  it('collects output and leaves the API key out', async () => {
    process.env.ANTHROPIC_API_KEY = 'set-for-test';
    let seen;
    const spawnImpl = (...a) => { const p = fake({ out: 'ok\n' })(...a); seen = p.seen; return p; };
    expect(await claudeRun(['mcp', 'list'], { spawnImpl })).toEqual({ ok: true, out: 'ok\n' });
    expect(seen.args).toEqual(['mcp', 'list']);
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });
  it('says when claude is missing and when it took too long', async () => {
    expect(await claudeRun(['mcp', 'list'], { spawnImpl: fake({ error: true }) })).toMatchObject({ ok: false, missing: true });
    expect(await claudeRun(['mcp', 'list'], { spawnImpl: fake({ hang: true }), timeout: 20 })).toMatchObject({ ok: false, timedOut: true });
  });
});
