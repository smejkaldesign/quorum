// Main's side of the memory engine (memoryHost.js) against the real engine in a worker thread. Every note is made up;
// no model is called.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { createMemoryHost } from '../memoryHost.js';

const WORKER = new URL('../memoryWorker.js', import.meta.url);
let dirs = [];
let hosts = [];
afterEach(() => { for (const h of hosts) h.close(); hosts = []; for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'qhost-')); dirs.push(d); return d; };

function vaultOf(n) {
  const vault = tmp();
  mkdirSync(path.join(vault, 'notes'));
  for (let i = 0; i < n; i++) writeFileSync(path.join(vault, `notes/n${i}.md`), `# N${i}\n\nSome text for note ${i}.\n`);
  const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
  ix.sync();
  return { vault, ix };
}

describe('the memory host', () => {
  it('starts the engine on the first call when main passes no port', async () => {
    const { vault, ix } = vaultOf(5);
    const data = tmp();
    let forks = 0;
    const host = createMemoryHost({ port: null, restart: () => { forks++; return new Worker(WORKER, { workerData: { dataDir: data } }); }, index: () => ix, vault: () => vault, mayRead: () => true });
    hosts.push(host);
    expect(forks).toBe(0);
    const r = await host.sweep('first');
    expect(forks).toBe(1);
    expect(r.state.last.notes).toBe(5);
  });
});
