// Main's side of the memory engine (memoryHost.js) against the real engine in a worker thread. Every note is made up;
// the model is a fake.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { createMemoryHost } from '../memoryHost.js';
import { synthModel, writeSynthVault } from './fixtures/synthVault.js';

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

describe('the memory host after the engine stops', () => {
  it('sends a fresh engine every note, so its sweep sees the whole vault and no stored claim is dropped', async () => {
    const vault = tmp();
    const data = tmp();
    writeSynthVault(vault, { notes: 60 });
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const workers = [];
    const host = createMemoryHost({
      port: null, restart: () => { const w = new Worker(WORKER, { workerData: { dataDir: data } }); workers.push(w); return w; },
      index: () => ix, vault: () => vault, mayRead: () => true, model: async (prompt) => synthModel(prompt),
      cond: () => ({ enabled: true, cap: 0, busy: false, idleMs: 0, drafts: true, bar: null, folders: {}, terms: [] }),
    });
    hosts.push(host);
    await host.refresh();
    for (let i = 0; i < 3; i++) await host.agent.tick({ uncapped: true });
    const stored = () => Object.keys(JSON.parse(readFileSync(path.join(data, 'memory-contradictions.json'), 'utf8')).claims).length;
    const before = stored();
    expect(before).toBeGreaterThan(20);
    // the engine dies (a crash or out of memory); the next call starts a new one
    const gone = new Promise((r) => workers[0].once('exit', r));
    await workers[0].terminate();
    await gone;
    const r = await host.sweep('full');
    expect(workers).toHaveLength(2);
    expect(r.state.last.notes).toBe(ix.rels().length);
    await host.refresh();
    expect(stored()).toBe(before);
  });
});
