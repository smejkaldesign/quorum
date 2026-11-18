// How main.js wires the AI tools, checked from its source because main.js needs Electron to load: every handler
// appActions.js calls is registered with handleAction (a handler left on plain ipcMain.handle is unreachable from the
// socket), the knowledge base handlers it calls exist in ee/, and the quorum set command cannot turn on the AI setting.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(dir, f), 'utf8');
const main = read('main.js');
const actions = read('appActions.js');

describe('AI tool wiring in main.js', () => {
  it('registers every handler the tools call so the socket reaches it', () => {
    const called = [...new Set([...actions.matchAll(/call\('([a-z-]+)'/g)].map((m) => m[1]))];
    expect(called.length).toBeGreaterThan(8);
    const registered = new Set([...main.matchAll(/handleAction\('([a-z-]+)'/g)].map((m) => m[1]));
    expect(called.filter((n) => !registered.has(n))).toEqual([]);
  });
  it('calls knowledge base handlers that exist', () => {
    const used = [...actions.matchAll(/\['(kb-[a-z-]+)'\]/g)].map((m) => m[1]);
    const ee = read('ee/kbHosted.js') + read('ee/kbSync.js');
    expect(used.length).toBe(3);
    for (const n of used) expect(ee).toContain(`'${n}':`);
  });
  it('keeps the AI setting out of what quorum set can change', () => {
    const line = main.match(/const CLI_SETTINGS = (\{[^\n]*\});/)[1];
    const keys = [...line.matchAll(/(\w+): \[/g)].map((m) => m[1]);
    expect(keys).toEqual(['model', 'autoListen', 'suggestions']);
  });
});
