// Run by Electron in test/memory-launch.test.js: starts the memory engine the way main.js does (startMemoryEngine with
// forkEngine and Electron's utilityProcess) over a small made-up vault in a temp folder, runs one sweep and one pass of
// the pipeline, prints what came back as one JSON line and quits. Opens no window and calls no model.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, utilityProcess } from 'electron';
import { forkEngine, startMemoryEngine } from '../../memoryWiring.js';
import { createVaultIndex } from '../../vindex.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(path.join(tmpdir(), 'qsmoke-'));
const vault = path.join(root, 'vault');
const data = path.join(root, 'data');
mkdirSync(path.join(vault, 'notes'), { recursive: true });
mkdirSync(data);
for (let i = 0; i < 12; i++) writeFileSync(path.join(vault, `notes/n${i}.md`), `---\ndate: 2026-0${1 + (i % 9)}-01\n---\n# N${i}\n\nWe decided Project P${i % 3} database is DB${i}.\n`);

app.dock?.hide();
const out = (o) => { process.stdout.write(`${JSON.stringify(o)}\n`); };
app.whenReady().then(async () => {
  try {
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const engine = startMemoryEngine({
      fork: forkEngine(utilityProcess, appDir, data),
      index: () => ix, vault: () => vault, mayRead: () => true,
      cond: () => ({ enabled: true, cap: 0, busy: false, idleMs: 0, drafts: true, bar: null, folders: {}, terms: [] }),
      model: async () => { throw new Error('No model in the smoke test'); },
    });
    const swept = await engine.sweep('first');
    await engine.refresh();
    out({ ok: true, notes: swept.state.last.notes, pending: engine.agent.pendingCalls(), error: engine.error() });
    engine.close();
  } catch (e) {
    out({ ok: false, error: String(e?.stack ?? e) });
  } finally {
    rmSync(root, { recursive: true, force: true });
    app.quit();
  }
});
