// The memory engine (memoryEngine.js) and the vault index's cut for large notes (vindex.js INDEX_MAX). Every note is
// made up; no model is called.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INDEX_MAX, createVaultIndex } from '../vindex.js';
import { MAX_RULE_TEXT, createMemoryEngine, ruleText } from '../memoryEngine.js';
import { parseNote } from '../linkparse.js';

let dirs = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'qengine-')); dirs.push(d); return d; };

describe('large notes', () => {
  it('indexes a note past INDEX_MAX by its head, cut at a line end', () => {
    const vault = tmp();
    mkdirSync(path.join(vault, 'logs'));
    const line = 'A session line with an accent: café.\n';
    writeFileSync(path.join(vault, 'logs/2026-11-16.md'), `# Log\n\n[[early]]\n${line.repeat(Math.ceil((INDEX_MAX * 1.5) / line.length))}`);
    writeFileSync(path.join(vault, 'early.md'), '# Early\n');
    const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const big = ix.snapshot().find((n) => n.rel === 'logs/2026-11-16.md');
    expect(big.cut).toBe(true);
    expect(Buffer.byteLength(big.text)).toBeLessThanOrEqual(INDEX_MAX);
    expect(big.text.endsWith('café.')).toBe(true);
    expect(big.size).toBeGreaterThan(INDEX_MAX);
    expect(ix.backlinks('early.md').map((l) => l.rel)).toEqual(['logs/2026-11-16.md']);
    expect(ix.snapshot().find((n) => n.rel === 'early.md').cut).toBeUndefined();
  });

  it('gives the rules the head of a note past MAX_RULE_TEXT, with its full length', () => {
    const long = 'x'.repeat(100) + '\n';
    const text = long.repeat(Math.ceil((MAX_RULE_TEXT * 1.2) / long.length));
    expect(ruleText(text).length).toBeLessThanOrEqual(MAX_RULE_TEXT);
    expect(ruleText(text).endsWith('x')).toBe(true);
    expect(ruleText('short')).toBe('short');
  });
});

describe('the memory engine', () => {
  const note = (rel, text) => ({ rel, text, note: parseNote(rel, text) });
  it('keeps its copy of the notes from the changes main sends, and sweeps it', async () => {
    const data = tmp();
    const vault = tmp();
    const e = createMemoryEngine({ dataDir: data });
    const a = note('a.md', '# A\n\nSee [[b]].\n');
    const b = note('b.md', '# B\n\nNothing links here from b.\n');
    e.sync({ vault, meta: [['a.md', 1, 10, 0, 1, true], ['b.md', 1, 10, 1, 0, true]], full: [a, b] });
    expect([...e.notes().keys()].sort()).toEqual(['a.md', 'b.md']);
    // a note sent as numbers only keeps its text; a note missing from the numbers left the index
    e.sync({ vault, meta: [['a.md', 2, 10, 0, 1, true]], full: [] });
    expect([...e.notes().keys()]).toEqual(['a.md']);
    expect(e.notes().get('a.md').text).toBe(a.text);
    expect(e.notes().get('a.md').mtime).toBe(2);
    const r = (await e.handle('sweep', { kind: 'first' })).result;
    expect(r.state.last).toMatchObject({ kind: 'first', notes: 1 });
    expect(Array.isArray(r.tags)).toBe(true);
    // a call names the agent's state with its answer, so main can answer status() without asking
    const { agent } = await e.handle('agent', {});
    expect(agent).toMatchObject({ pendingCalls: 0, status: { inflight: 0 } });
  });
});
