import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import { openMemoryDb } from '../search/db.js';
import { createMemorySearch, createSearchIndex } from '../search/index.js';
import { createHybridSearch } from '../search/hybrid.js';
import { hashEmbedder } from '../search/embed.js';
import { makeEvalVault } from '../search/eval/make-vault.mjs';
import { miniGraph } from '../search/eval/miniGraph.js';

let dir;
let vault;
const put = (rel, text) => { const f = path.join(vault, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
// an embedder that counts the texts it was asked for
function counting() {
  const e = hashEmbedder();
  const seen = [];
  return { ...e, seen, embed: (texts) => { seen.push(...texts); return e.embed(texts); } };
}
const OPTED = /falcon secret/i;
function vindexOf() {
  const v = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: (t) => OPTED.test(t), redact: (t) => t.split('\n').map((l) => (OPTED.test(l) ? '[withheld]' : l)).join('\n'), onChange: () => {} });
  v.sync();
  return v;
}
function setup(embedder = counting(), opts = {}) {
  const v = vindexOf();
  const { db } = openMemoryDb({ file: path.join(dir, 'memory.db') });
  const index = createSearchIndex({ db, embedder, pauseMs: 5, retryMs: 5, ...opts });
  const graph = miniGraph(v.snapshot(), (t, from) => v.resolve(t, from));
  const hybrid = createHybridSearch({ db, embedder, graph: () => graph, version: index.version });
  return { v, db, index, hybrid, embedder };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'quorum-search-'));
  vault = path.join(dir, 'vault');
  makeEvalVault(vault, { notes: 150, tokens: 200 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('search index on a generated vault', () => {
  it('builds chunks, FTS and vectors, and skips notes whose text did not change', async () => {
    const { v, index, hybrid, embedder } = setup();
    expect(await index.build(v.snapshot())).toBe(150);
    await index.drain();
    const s = index.status();
    expect(s.notes).toBe(150);
    expect(s.embedded).toBe(s.chunks);
    expect(s.pending).toBe(0);
    const calls = embedder.seen.length;
    expect(await index.build(v.snapshot())).toBe(0);
    await index.drain();
    expect(embedder.seen.length).toBe(calls);
    const r = await hybrid.search({ q: 'QX-1000' });
    expect(r.results[0].rel).toBe('projects/Project Heron.md');
    expect(r.results[0].parts.fts).toBe(1);
  });

  it('re-embeds only the section that changed, and a renamed note keeps its vectors', async () => {
    const { v, index, embedder } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const rel = 'projects/Project Heron.md';
    const before = embedder.seen.length;
    const note = v.snapshot().find((n) => n.rel === rel);
    put(rel, note.text.replace('## Goal\n', '## Goal\n\nA new first line under the goal.\n'));
    v.sync();
    await index.update(v.snapshot().filter((n) => n.rel === rel));
    await index.drain();
    expect(embedder.seen.slice(before)).toHaveLength(1);
    expect(embedder.seen.at(-1)).toContain('A new first line under the goal.');
    const mark = embedder.seen.length;
    renameSync(path.join(vault, rel), path.join(vault, 'projects/Heron renamed.md'));
    v.sync();
    await index.update(v.snapshot().filter((n) => n.rel === 'projects/Heron renamed.md'), [rel]);
    await index.drain();
    // the title comes from the note's first heading, so every chunk hash is the same and no chunk is embedded again
    expect(embedder.seen.slice(mark)).toHaveLength(0);
    expect(index.status()).toMatchObject({ notes: 150, pending: 0 });
  });

  it('holds the embed queue while paused and runs it after', async () => {
    let live = true;
    const { v, index } = setup(counting(), { paused: () => live });
    await index.build(v.snapshot());
    const run = index.drain();
    await new Promise((r) => setTimeout(r, 30));
    expect(index.status()).toMatchObject({ state: 'paused', embedded: 0 });
    live = false;
    await run;
    expect(index.status().pending).toBe(0);
  });

  it('keeps chunks queued when the model fails and fills them once it works', async () => {
    let fail = true;
    const e = hashEmbedder();
    const { v, index } = setup({ ...e, embed: (t) => (fail ? Promise.reject(new Error('The local embedding model is missing')) : e.embed(t)) });
    await index.build(v.snapshot());
    const run = index.drain();
    await new Promise((r) => setTimeout(r, 20));
    expect(index.status()).toMatchObject({ state: 'waiting', error: 'The local embedding model is missing', embedded: 0 });
    fail = false;
    await run;
    expect(index.status()).toMatchObject({ pending: 0, error: null });
  });

  it('never indexes withheld lines', async () => {
    put('inbox/private.md', '# Plans\n\nThe falcon secret is the launch date.\nThe public part is the venue.\n');
    const { v, index, hybrid, db } = setup();
    await index.build(v.snapshot());
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE text LIKE '%launch date%'").get().n).toBe(0);
    expect((await hybrid.search({ q: 'launch date', signals: ['fts'] })).results.some((r) => r.rel === 'inbox/private.md')).toBe(false);
    expect((await hybrid.search({ q: 'venue', signals: ['fts'] })).results[0].rel).toBe('inbox/private.md');
  });

  it('filters by folder, kind and date, and trims to the budget with a summary', async () => {
    const { v, index, hybrid } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const all = await hybrid.search({ q: 'project open items', k: 20, budget: 1e6 });
    expect(all.results.length).toBe(20);
    const meetings = await hybrid.search({ q: 'project open items', folders: ['meetings'] });
    expect(meetings.results.every((r) => r.rel.startsWith('meetings/'))).toBe(true);
    const decisions = await hybrid.search({ q: 'database', kinds: ['decision'] });
    expect(decisions.results.length).toBeGreaterThan(0);
    expect(decisions.results.every((r) => r.kind === 'decision')).toBe(true);
    const late = await hybrid.search({ q: 'database', kinds: ['decision'], since: '2026-11-01' });
    expect(late.results.every((r) => r.rel.startsWith('decisions/2026-11'))).toBe(true);
    const small = await hybrid.search({ q: 'project open items', k: 20, budget: 300 });
    expect(small.results.length).toBeLessThan(20);
    expect(small.truncated).toMatchObject({ shown: small.results.length, total: 20 });
    expect(small.truncated.budgetNeeded).toBeGreaterThan(300);
    const tiny = await hybrid.search({ q: 'QX-1000', budget: 20 });
    expect(tiny.results).toHaveLength(1);
    expect(tiny.results[0].text.length).toBeLessThanOrEqual(32);
  });

  it('finds meetings a person attended through the graph, though the name is only in frontmatter', async () => {
    const { v, index, hybrid } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const who = 'Ada Arden';
    const attended = v.snapshot().filter((n) => n.rel.startsWith('meetings/') && n.text.split('\n---')[0].includes(`[[${who}]]`)).map((n) => n.rel);
    expect(attended.length).toBeGreaterThan(0);
    const kw = await hybrid.search({ q: who, signals: ['fts'], k: 100 });
    expect(kw.results.filter((r) => attended.includes(r.rel))).toHaveLength(0);
    const hy = await hybrid.search({ q: `meetings with ${who}`, k: 50 });
    const top = [...new Set(hy.results.map((r) => r.rel))].slice(0, 10);
    expect(top.filter((r) => attended.includes(r)).length).toBeGreaterThan(0);
  });

  it('ranks a superseded decision below the one that replaced it', async () => {
    const { v, index, hybrid } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const r = await hybrid.search({ q: 'Project Heron database', kinds: ['decision'] });
    const rels = r.results.map((x) => x.rel);
    const newer = rels.findIndex((x) => x.includes('Project Heron database change'));
    const older = rels.findIndex((x) => /Project Heron database\.md$/.test(x));
    expect(newer).toBeGreaterThanOrEqual(0);
    expect(older).toBeGreaterThan(newer);
    expect(r.results[older].parts.superseded).toBe(true);
  });

  it('reads the "project" in a project name as part of the name, so project notes get no kind boost', async () => {
    const { v, index, hybrid } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const r = await hybrid.search({ q: 'What database does Project Heron use now?', k: 50 });
    expect(r.results.some((x) => x.rel.startsWith('projects/'))).toBe(true);
    expect(r.results.filter((x) => x.parts.kindHint)).toEqual([]);
    const m = await hybrid.search({ q: 'meetings with Ada Arden', k: 50 });
    const hinted = m.results.filter((x) => x.parts.kindHint);
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.every((x) => x.kind === 'meeting')).toBe(true);
  });
});

describe('hybrid search on the graph store shapes', () => {
  it('reads supersession through decided_in, and note rels from meeting ids', async () => {
    const { v, index, db } = setup();
    await index.build(v.snapshot());
    await index.drain();
    const older = v.rels().find((r) => /^decisions\/.*Project Heron database\.md$/.test(r));
    const meeting = v.rels().find((r) => r.startsWith('meetings/'));
    const dec = `decision:${older}#abcd1234`;
    const edges = [
      { id: 1, src: dec, dst: `note:${older}`, kind: 'decided_in', superseded_by: null },
      { id: 2, src: dec, dst: 'project:heron', kind: 'decision_about', superseded_by: 3 },
      { id: 4, src: `meeting:${meeting}`, dst: 'person:zz-only', kind: 'attended', superseded_by: null },
    ];
    const graph = {
      find: (n) => (n === 'zz only' ? [{ id: 'person:zz-only', kind: 'person', name: 'Zz Only', rel: null }] : []),
      edgesOf: (id, { dir = 'both', kinds = null, current = true } = {}) => edges.filter((e) => (dir === 'both' ? e.src === id || e.dst === id : dir === 'out' ? e.src === id : e.dst === id) && (!kinds || kinds.includes(e.kind)) && (!current || e.superseded_by == null)),
    };
    const hybrid = createHybridSearch({ db, embedder: hashEmbedder(), graph: () => graph, version: index.version });
    const r = await hybrid.search({ q: 'Project Heron database', k: 50, budget: 1e6 });
    expect(r.results.find((x) => x.rel === older).parts.superseded).toBe(true);
    const m = await hybrid.search({ q: 'zz only', signals: ['graph'] });
    expect(m.results.map((x) => x.rel)).toContain(meeting);
  });
});

describe('createMemorySearch', () => {
  it('builds on the first change, follows later changes and reports status', async () => {
    const v = vindexOf();
    const s = createMemorySearch({ dataDir: dir, vault: () => vault, vindex: () => v, embedder: hashEmbedder() });
    await s.changed(v.rels());
    expect(s.status()).toMatchObject({ notes: 150, built: true });
    put('inbox/new idea.md', '# New idea\n\nA kayak rental desk by the river.\n');
    v.sync();
    const at = performance.now();
    await s.changed(['inbox/new idea.md']);
    expect(performance.now() - at).toBeLessThan(100);
    expect((await s.search({ q: 'kayak rental' })).results[0].rel).toBe('inbox/new idea.md');
    rmSync(path.join(vault, 'inbox/new idea.md'));
    v.sync();
    await s.changed(['inbox/new idea.md']);
    expect((await s.search({ q: 'kayak rental' })).results.some((r) => r.rel === 'inbox/new idea.md')).toBe(false);
    s.close();
    expect(createMemorySearch({ dataDir: dir, vault: () => null, vindex: () => v }).status().state).toBe('off');
  });
});
