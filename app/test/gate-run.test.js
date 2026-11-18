// The gate run main makes after a sweep or a fix (gateRun.js): a run with kept verdicts builds again only the items
// whose signature changed and gives the verdicts a run over everything gives; the verdict file is written whole through
// a temporary file; the note hashes the review items carry are read again only for a note that changed (fixJournal.js).
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGateStore, gatePasses, sameVerdicts } from '../gateRun.js';
import { runGate } from '../qualityGate.js';
import { createNoteHashes, hashNotes, noteMemo } from '../fixJournal.js';

const item = (n, extra = {}) => ({ id: `r:find:${n}`, kind: 'finding', ruleId: 'note.stale', key: String(n), ops: [{ op: 'annotate', rel: `n${n}.md`, text: `line ${n}` }], hashes: { [`n${n}.md`]: `h${n}` }, ...extra });
const items = (k) => Array.from({ length: k }, (_, i) => item(i));

describe('gate passes', () => {
  it('builds every item twice with no kept verdicts', async () => {
    const first = items(5);
    const asked = [];
    const r = await gatePasses({ first, kept: null, again: async (x) => { asked.push(x); return items(5); } });
    expect(asked).toEqual([null]);
    expect(r.rebuilt).toBe(5);
    expect(r.same).toBe(false);
    expect([...r.verdicts.values()].every((v) => v.bucket === 'show' && v.sig)).toBe(true);
    expect([...r.g.verdicts.keys()]).toEqual([...runGate([first, items(5)]).verdicts.keys()]);
  });

  it('builds nothing again when no item changed, and gives the kept verdicts', async () => {
    const full = await gatePasses({ first: items(6), again: async () => items(6) });
    let calls = 0;
    const r = await gatePasses({ first: items(6), kept: full.verdicts, again: async () => { calls++; return []; } });
    expect(calls).toBe(0);
    expect(r.rebuilt).toBe(0);
    expect(r.same).toBe(true);
    expect(sameVerdicts(full.verdicts, r.verdicts)).toBe(true);
  });

  it('builds again only the changed items and matches a run over everything', async () => {
    const before = await gatePasses({ first: items(6), again: async () => items(6) });
    // item 2's note changed, item 4 is gone, item 9 is new and its fix changes between the passes
    const now = () => [...items(6).filter((i) => i.key !== '4').map((i) => (i.key === '2' ? item(2, { hashes: { 'n2.md': 'h2b' } }) : i)), item(9)];
    const second = () => now().map((i) => (i.key === '9' ? item(9, { ops: [{ op: 'annotate', rel: 'n9.md', text: 'moved' }] }) : i));
    let asked = null;
    const inc = await gatePasses({ first: now(), kept: before.verdicts, again: async (x) => { asked = x.map((i) => i.key); return second().filter((i) => x.some((y) => y.id === i.id)); } });
    const full = await gatePasses({ first: now(), again: async () => second() });
    expect(asked).toEqual(['2', '9']);
    expect(inc.rebuilt).toBe(2);
    expect(inc.same).toBe(false);
    expect(sameVerdicts(full.verdicts, inc.verdicts)).toBe(true);
    expect(inc.verdicts.get('r:find:9').reasons).toContain('unstable');
    expect(inc.verdicts.has('r:find:4')).toBe(false);
  });

  it('marks a changed item that is gone in the second pass as unstable', async () => {
    const before = await gatePasses({ first: items(2), again: async () => items(2) });
    const first = [item(0), item(1, { hashes: { 'n1.md': 'new' } })];
    const r = await gatePasses({ first, kept: before.verdicts, again: async () => [] });
    expect(r.verdicts.get('r:find:1').reasons).toContain('unstable');
    expect(r.verdicts.get('r:find:0').bucket).toBe('show');
  });
});

describe('what starts a gate run in main.js', () => {
  it('a sweep and a fix run start one; a read of the items never does', () => {
    const main = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../main.js'), 'utf8');
    const callers = [...main.matchAll(/(?<!function )scheduleGate\(/g)].map((m) => [...main.slice(0, m.index).matchAll(/^(?:async )?function (\w+)/gm)].at(-1)[1]);
    expect(callers.sort()).toEqual(['pumpFixes', 'sweepNow']);
    const gateOf = main.slice(main.indexOf('function gateOf('), main.indexOf('const gateChecking'));
    expect(gateOf).not.toMatch(/gateNow|scheduleGate|setTimeout/);
  });
});

describe('the gate store', () => {
  it('keeps every vault, writes the whole file through a temporary file and reads it back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gate-store-'));
    const file = path.join(dir, 'sub', 'memory-gate.json');
    const a = createGateStore(file);
    expect(a.get('/v1')).toBe(null);
    await Promise.all([a.put('/v1', { at: 1, verdicts: { x: { bucket: 'show' } } }), a.put('/v2', { at: 2, verdicts: {} })]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '/v1': { at: 1, verdicts: { x: { bucket: 'show' } } }, '/v2': { at: 2, verdicts: {} } });
    expect(readdirSync(path.dirname(file))).toEqual(['memory-gate.json']);
    expect(createGateStore(file).get('/v2')).toEqual({ at: 2, verdicts: {} });
    writeFileSync(file, 'not json');
    expect(createGateStore(file).get('/v1')).toBe(null);
  });
});

describe('note hashes kept by modified time and size', () => {
  it('answers what hashNotes answers and reads a note again only when it changed', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'note-hashes-'));
    writeFileSync(path.join(vault, 'a.md'), 'one');
    writeFileSync(path.join(vault, 'b.md'), 'two');
    const hashes = createNoteHashes();
    const rels = ['a.md', 'b.md', 'missing.md', 'a.md'];
    expect(hashes(vault, rels)).toEqual(hashNotes(vault, rels));
    let reads = 0;
    const memo = noteMemo((t) => { reads++; return t.length; });
    expect(memo(vault, 'a.md')).toBe(3);
    expect(memo(vault, 'a.md')).toBe(3);
    expect(reads).toBe(1);
    expect(memo(vault, 'a.md', true)).toBe(3);
    expect(reads).toBe(2);
    writeFileSync(path.join(vault, 'a.md'), 'three');
    utimesSync(path.join(vault, 'a.md'), new Date(), new Date(Date.now() + 5000));
    expect(memo(vault, 'a.md')).toBe(5);
    expect(hashes(vault, ['a.md'])).toEqual(hashNotes(vault, ['a.md']));
    expect(memo(vault, 'missing.md')).toBe(null);
    expect(memo(vault, '../outside.md')).toBe(null);
    expect(existsSync(path.join(vault, 'missing.md'))).toBe(false);
  });
});
