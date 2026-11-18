// The environment the agent CLIs (claude, codex, agy) start with: the person's own, without Quorum's settings and keys.
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentEnv, dotenvNames, forgetBins, resolveBin } from '../agentEnv.js';
import { codexText } from '../runners.js';

const dir = mkdtempSync(path.join(tmpdir(), 'qenv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = {
  HOME: '/tmp/home-p', PATH: '/usr/bin:/bin', USER: 'p', SHELL: '/bin/zsh', TMPDIR: '/tmp/', LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm',
  HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'localhost',
  ANTHROPIC_BASE_URL: 'https://gw.example.com', CLAUDE_CONFIG_DIR: '/tmp/home-p/.claude', CODEX_HOME: '/tmp/home-p/.codex',
  QUORUM_GOOGLE_CLIENT_SECRET: 'x', QUORUM_SUPABASE_ANON_KEY: 'x', QUORUM_ENV: 'development', SUPABASE_SERVICE_ROLE_KEY: 'x',
  VITE_SUPABASE_URL: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_PICKER_API_KEY: 'x', ELECTRON_RUN_AS_NODE: '1', STRIPE_SECRET_KEY: 'x',
};

describe('agentEnv', () => {
  it('keeps what the CLIs need and drops Quorum\'s own names and the .env names', () => {
    const env = agentEnv(BASE, { names: new Set(['STRIPE_SECRET_KEY', 'PATH']) });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'no_proxy']);
  });
  it('reads only the names from the .env files of a build from source', () => {
    mkdirSync(path.join(dir, 'app'), { recursive: true });
    writeFileSync(path.join(dir, '.env'), 'RAILWAY_TOKEN=abc\n# a comment\n');
    writeFileSync(path.join(dir, 'app', '.env.development'), 'DEV_ONLY_KEY=1\n');
    expect([...dotenvNames(dir)].sort()).toEqual(['DEV_ONLY_KEY', 'RAILWAY_TOKEN']);
  });
  it('is what the text runners start with', async () => {
    let seen = null;
    const spawnImpl = (bin, args, opts) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.stdin = { end: () => {} }; proc.kill = () => {};
      seen = opts;
      setTimeout(() => { proc.stdout.emit('data', '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}'); proc.emit('close', 0); }, 0);
      return proc;
    };
    const before = { ...process.env };
    Object.assign(process.env, { QUORUM_GOOGLE_CLIENT_SECRET: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x' });
    try { await codexText({ prompt: 'x', spawnImpl }); }
    finally { for (const k of ['QUORUM_GOOGLE_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) if (!(k in before)) delete process.env[k]; }
    expect(seen.env.QUORUM_GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(seen.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(seen.env.HOME).toBe(process.env.HOME);
  });
});

describe('resolveBin', () => {
  it('finds a CLI on PATH once and returns its absolute path', () => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'quorum-test-cli');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    forgetBins();
    expect(resolveBin('quorum-test-cli', { pathVar: `relative/dir${path.delimiter}${bin}` })).toBe(file);
    expect(resolveBin('quorum-test-cli', { pathVar: '' })).toBe(file);
    expect(resolveBin('quorum-missing-cli', { pathVar: bin })).toBe('quorum-missing-cli');
  });
  it('skips a file that is not executable', () => {
    const file = path.join(dir, 'plain-cli');
    writeFileSync(file, 'x');
    chmodSync(file, 0o644);
    expect(resolveBin('plain-cli', { pathVar: dir })).toBe('plain-cli');
  });
});
