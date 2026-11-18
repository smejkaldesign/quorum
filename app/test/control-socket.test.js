import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateDir, startControl } from '../control.js';

describe('control socket', () => {
  it('gives group and others no access from creation, ends 0600 and restores the umask', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qctl-'));
    const sock = path.join(dir, 'q.sock');
    const before = process.umask();
    const stop = startControl(sock, async (req) => ({ echo: req.cmd }), () => {});
    expect(statSync(sock).mode & 0o077).toBe(0);
    expect(process.umask()).toBe(before);
    const reply = await new Promise((resolve) => {
      const c = net.connect(sock, () => c.write('{"cmd":"ping"}\n'));
      c.on('data', (d) => { resolve(JSON.parse(String(d))); c.end(); });
    });
    expect(reply).toEqual({ ok: true, result: { echo: 'ping' } });
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    stop();
  });

  it('privateDir creates the data folder as 0700 and tightens an existing one', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'qdata-'));
    const fresh = path.join(base, 'Quorum');
    privateDir(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    const loose = path.join(base, 'Quorum Dev');
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    privateDir(loose);
    expect(statSync(loose).mode & 0o777).toBe(0o700);
  });
});
