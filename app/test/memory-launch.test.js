// Starting the memory engine the way main.js does at launch (memoryWiring.js startMemoryEngine with no port, so the
// first call forks it). In plain Node with a worker thread, and under Electron with a real utility process when the
// Electron binary can run here (macOS, or Linux with a display). Every note is made up; no model is called.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { startMemoryEngine } from '../memoryWiring.js';
import { createVaultIndex } from '../vindex.js';

const APP = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
let dirs = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'qlaunch-')); dirs.push(d); return d; };

const electronBin = () => { try { const p = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("electron"))'], { cwd: APP, encoding: 'utf8', timeout: 20000 }); return existsSync(p) ? p : null; } catch { return null; } };
const canRunElectron = process.platform === 'darwin' || !!process.env.DISPLAY;

describe('the memory engine at launch', () => {
  it('main.js starts it through startMemoryEngine with no port and forkEngine', () => {
    const main = readFileSync(path.join(APP, 'main.js'), 'utf8');
    expect(main).toContain('const memoryEngine = startMemoryEngine({\n  fork: forkEngine(utilityProcess, here, DATA_DIR),');
    expect(main).not.toContain('createMemoryHost(');
  });

  it('builds with no port and forks on the first call', async () => {
    const vault = tmp();
    const data = tmp();
    mkdirSync(path.join(vault, 'notes'));
    for (let i = 0; i < 4; i++) writeFileSync(path.join(vault, `notes/n${i}.md`), `# N${i}\n\nText ${i}.\n`);
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    let forks = 0;
    const engine = startMemoryEngine({ fork: () => { forks++; return new Worker(new URL('../memoryWorker.js', import.meta.url), { workerData: { dataDir: data } }); }, index: () => ix, vault: () => vault, mayRead: () => true, cond: () => ({}), model: async () => { throw new Error('No model'); } });
    expect(forks).toBe(0);
    const r = await engine.sweep('first');
    expect(forks).toBe(1);
    expect(r.state.last.notes).toBe(4);
    engine.close();
  });

  it.skipIf(!canRunElectron)('runs a sweep in an Electron utility process', () => {
    const bin = electronBin();
    if (!bin) return;
    const out = execFileSync(bin, [path.join(APP, 'test/fixtures/engine-smoke.mjs')], { cwd: APP, encoding: 'utf8', timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const r = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
    expect(r).toMatchObject({ ok: true, notes: 12, error: null });
  }, 70000);
});
