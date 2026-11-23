import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DAY, fileDot, folderDots, lineDiff, noteBody, prune, reviewGroup } from '../memoryReview.js';
import { createVersionStore, snapshot } from '../memoryVersions.js';
import { createKeeper } from '../keeper.js';
import { plan, writeStarter } from '../starter.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const T0 = Date.UTC(2026, 10, 14, 12);

function setup(over = {}) {
  const vault = tmp('mv-vault-');
  const dir = tmp('mv-data-');
  const clock = { t: T0 };
  const changes = [];
  const opts = { auto: true, days: 30, ...over };
  const store = createVersionStore({ dir, now: () => clock.t, autoApprove: () => opts.auto, dotDays: () => opts.days, onChange: (r) => changes.push(...r), ...(over.store ?? {}) });
  return { vault, dir, clock, store, changes, opts };
}

describe('lineDiff', () => {
  it('marks the new and changed lines of the after text and counts changed blocks', () => {
    const a = 'one\ntwo\nthree\nfour\nfive';
    const b = 'one\nTWO\nthree\nfour\nfive\nsix';
    expect(lineDiff(a, b)).toEqual({ changed: [1, 5], blocks: 2 });
  });
  it('counts a removed run as a block with no marked lines', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nd')).toEqual({ changed: [], blocks: 1 });
  });
  it('treats a missing file as every line new, and equal texts as no change', () => {
    expect(lineDiff(null, 'x\ny')).toEqual({ changed: [0, 1], blocks: 1 });
    expect(lineDiff('same\ntext', 'same\ntext')).toEqual({ changed: [], blocks: 0 });
  });
  it('finds a moved line inside a larger edit', () => {
    const r = lineDiff('h\na\nb\nc\nt', 'h\nb\nc\na\nt');
    expect(r.changed).toEqual([3]);
    expect(r.blocks).toBe(2);
  });
});

describe('dot rules', () => {
  const now = T0;
  it('is green while any update waits for approval, at any age', () => {
    expect(fileDot({ updates: [{ at: now - 400 * DAY, approved: false }] }, { now, days: 30 })).toBe('green');
    expect(fileDot({ updates: [{ at: now - DAY, approved: true }, { at: now, approved: false }], openedAt: now + 1 }, { now, days: 30 })).toBe('green');
  });
  it('is blue for an approved update not opened since, until the window ends', () => {
    const rec = { updates: [{ at: now - 5 * DAY, approved: true, approvedAt: now - 5 * DAY }] };
    expect(fileDot(rec, { now, days: 30 })).toBe('blue');
    expect(fileDot(rec, { now, days: 3 })).toBeNull();
    expect(fileDot({ ...rec, openedAt: now - 4 * DAY }, { now, days: 30 })).toBeNull();
  });
  it('counts an accepted update from the time it was accepted', () => {
    const rec = { updates: [{ at: now - 60 * DAY, approved: true, approvedAt: now - DAY }], openedAt: now - 2 * DAY };
    expect(fileDot(rec, { now, days: 30 })).toBe('blue');
  });
  it('has no dot without updates', () => {
    expect(fileDot({ updates: [] }, { now, days: 30 })).toBeNull();
    expect(fileDot(undefined, { now, days: 30 })).toBeNull();
  });
  it('gives each folder the dot of the files under it, green over blue', () => {
    expect(folderDots({ 'a/b/x.md': 'blue', 'a/y.md': 'green', 'c/z.md': 'blue', 'top.md': 'green' })).toEqual({ a: 'green', 'a/b': 'blue', c: 'blue' });
    expect(folderDots({ 'a/b/x.md': 'green', 'a/y.md': 'blue' })).toEqual({ a: 'green', 'a/b': 'green' });
  });
  it('groups the waiting updates for a green banner and the unopened approved ones for a blue banner', () => {
    const rec = { updates: [
      { id: 'a', at: now - 3 * DAY, approved: true, approvedAt: now - 3 * DAY, changes: 1 },
      { id: 'b', at: now - 2 * DAY, approved: false, changes: 2 },
      { id: 'c', at: now - DAY, approved: false, changes: 1 },
    ] };
    expect(reviewGroup(rec, { now, days: 30 })).toMatchObject({ dot: 'green', count: 2, at: now - DAY, changes: 3, first: { id: 'b' } });
    const blue = { updates: [rec.updates[0], { ...rec.updates[1], approved: true, approvedAt: now - 2 * DAY }], openedAt: now - 2.5 * DAY };
    expect(reviewGroup(blue, { now, days: 30 })).toMatchObject({ dot: 'blue', count: 1, first: { id: 'b' } });
    expect(reviewGroup({ updates: [] }, { now, days: 30 })).toBeNull();
  });
});

describe('prune and noteBody', () => {
  it('keeps the newest entries and none older than the age cap', () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ at: T0 - (5 - i) * 100 * DAY }));
    const r = prune(list, { now: T0, max: 2, maxAgeDays: 365 });
    expect(r.keep).toEqual(list.slice(4));
    expect(r.drop).toHaveLength(4);
    expect(prune(list, { now: T0, max: 50, maxAgeDays: 250 }).keep).toEqual(list.slice(3));
  });
  it('drops the frontmatter and the first heading the way the Memory tab shows a note', () => {
    expect(noteBody('---\na: 1\n---\n# Title\n\nBody\n')).toBe('Body');
    expect(noteBody('Intro\n# Later')).toBe('Intro\n# Later');
  });
});

describe('version store', () => {
  it('keeps the earlier text as a version with time, who and reason, outside the vault', () => {
    const { vault, dir, store, changes } = setup();
    const r = store.record({ vault, rel: 'notes/a.md', before: 'old\n', after: 'new\n', who: 'keeper', reason: 'Filed the meeting Sync' });
    expect(r.version).toMatchObject({ at: T0, who: 'keeper', reason: 'Filed the meeting Sync', created: false });
    expect(r.update).toMatchObject({ changes: 1, approved: true, auto: true });
    expect(store.list(vault, 'notes/a.md').map((v) => v.reason)).toEqual(['Filed the meeting Sync']);
    expect(store.read(vault, 'notes/a.md', r.version.id)).toBe('old\n');
    expect(changes).toEqual(['notes/a.md']);
    expect(readdirSync(vault)).toEqual([]);
    expect(existsSync(path.join(store.home(vault), 'index.json'))).toBe(true);
    expect(store.home(vault).startsWith(dir)).toBe(true);
  });
  it('records nothing when the text did not change, and lists versions newest first', () => {
    const { vault, clock, store } = setup();
    expect(store.record({ vault, rel: 'a.md', before: 'x', after: 'x', who: 'keeper' })).toBeNull();
    store.record({ vault, rel: 'a.md', before: 'v1', after: 'v2', who: 'keeper', reason: 'first' });
    clock.t += 1000;
    store.record({ vault, rel: 'a.md', before: 'v2', after: 'v3', who: 'agent', reason: 'second' });
    expect(store.list(vault, 'a.md').map((v) => v.reason)).toEqual(['second', 'first']);
  });
  it('refuses to read an id that is not one of the file\'s versions', () => {
    const { vault, store } = setup();
    const r = store.record({ vault, rel: 'a.md', before: 'v1', after: 'v2', who: 'keeper' });
    expect(store.read(vault, 'b.md', r.version.id)).toBeNull();
    expect(store.read(vault, 'a.md', '../../etc/passwd')).toBeNull();
  });
  it('reads its history back from disk in a new store', () => {
    const { vault, dir, store } = setup();
    store.record({ vault, rel: 'a.md', before: 'v1', after: 'v2', who: 'keeper', reason: 'kept' });
    const again = createVersionStore({ dir, now: () => T0 });
    expect(again.list(vault, 'a.md').map((v) => v.reason)).toEqual(['kept']);
  });
  it('restores a version, and keeps the replaced text as a new version that is no update', () => {
    const { vault, store } = setup();
    writeFileSync(path.join(vault, 'a.md'), 'v2\n');
    const r = store.record({ vault, rel: 'a.md', before: 'v1\n', after: 'v2\n', who: 'keeper', reason: 'edit' });
    expect(store.restore(vault, 'a.md', r.version.id)).toBe('v1\n');
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('v1\n');
    const [top] = store.list(vault, 'a.md');
    expect(top).toMatchObject({ who: 'you' });
    expect(top.reason).toMatch(/^Restored the version from /);
    expect(store.read(vault, 'a.md', top.id)).toBe('v2\n');
    expect(store.dots(vault).files).toEqual({ 'a.md': 'blue' });
    // the restore itself can be restored
    store.restore(vault, 'a.md', top.id);
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('v2\n');
  });
  it('does not restore a version from before the file existed, or outside the vault', () => {
    const { vault, store } = setup();
    const r = store.record({ vault, rel: 'new.md', before: null, after: 'made', who: 'keeper' });
    expect(r.version.created).toBe(true);
    expect(store.restore(vault, 'new.md', r.version.id)).toBeNull();
    const out = store.record({ vault, rel: '../out.md', before: 'a', after: 'b', who: 'keeper' });
    expect(store.restore(vault, '../out.md', out.version.id)).toBeNull();
  });
  it('caps versions per file and drops the text of the ones it lets go', () => {
    const { vault, clock, store } = setup({ store: { maxVersions: 3 } });
    for (let i = 0; i < 5; i++) { store.record({ vault, rel: 'a.md', before: `v${i}`, after: `v${i + 1}`, who: 'keeper', reason: `r${i}` }); clock.t += 1000; }
    expect(store.list(vault, 'a.md').map((v) => v.reason)).toEqual(['r4', 'r3', 'r2']);
    expect(readdirSync(path.join(store.home(vault), 'v'))).toHaveLength(3);
  });
  it('drops versions older than a year at the next write', () => {
    const { vault, clock, store } = setup();
    store.record({ vault, rel: 'a.md', before: 'v0', after: 'v1', who: 'keeper', reason: 'old' });
    clock.t += 366 * DAY;
    store.record({ vault, rel: 'a.md', before: 'v1', after: 'v2', who: 'keeper', reason: 'new' });
    expect(store.list(vault, 'a.md').map((v) => v.reason)).toEqual(['new']);
  });
});

describe('updates and approval', () => {
  it('approves updates when they are made with auto-approve on, which shows blue until the file is opened', () => {
    const { vault, clock, store } = setup();
    store.record({ vault, rel: 'p/a.md', before: 'a', after: 'b', who: 'keeper' });
    expect(store.dots(vault)).toEqual({ files: { 'p/a.md': 'blue' }, folders: { p: 'blue' } });
    expect(store.review(vault, 'p/a.md')).toMatchObject({ dot: 'blue', count: 1, before: 'a' });
    clock.t += 1000;
    store.opened(vault, 'p/a.md');
    expect(store.dots(vault).files).toEqual({});
    expect(store.review(vault, 'p/a.md')).toBeNull();
  });
  it('hides a blue dot after the configured days', () => {
    const { vault, clock, store, opts } = setup({ days: 2 });
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper' });
    clock.t += 3 * DAY;
    expect(store.dots(vault).files).toEqual({});
    opts.days = 30;
    expect(store.dots(vault).files).toEqual({ 'a.md': 'blue' });
  });
  it('leaves updates waiting with auto-approve off; opening keeps them green and accepting approves them', () => {
    const { vault, clock, store } = setup({ auto: false });
    store.record({ vault, rel: 'p/a.md', before: 'one\n', after: 'one\ntwo\n', who: 'keeper', reason: 'r1' });
    clock.t += 1000;
    store.record({ vault, rel: 'p/a.md', before: 'one\ntwo\n', after: 'one\ntwo\nthree\n', who: 'agent', reason: 'r2' });
    store.record({ vault, rel: 'p/b.md', before: 'x', after: 'y', who: 'keeper', reason: 'r3' });
    expect(store.dots(vault)).toEqual({ files: { 'p/a.md': 'green', 'p/b.md': 'green' }, folders: { p: 'green' } });
    expect(store.review(vault, 'p/a.md')).toMatchObject({ dot: 'green', count: 2, at: T0 + 1000, before: 'one\n' });
    store.opened(vault, 'p/a.md');
    expect(store.dots(vault).files['p/a.md']).toBe('green');
    expect(store.approve(vault, 'p/a.md')).toBe(2);
    expect(store.dots(vault).files).toEqual({ 'p/b.md': 'green' });
  });
  it('keeps showing the updates of an open page after opening it cleared the dot', () => {
    const { vault, clock, store } = setup();
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper' });
    const { ids } = store.review(vault, 'a.md');
    clock.t += 1000;
    store.opened(vault, 'a.md');
    expect(store.review(vault, 'a.md')).toBeNull();
    expect(store.review(vault, 'a.md', ids)).toMatchObject({ dot: 'blue', ids, count: 1, before: 'a', created: false });
    store.record({ vault, rel: 'a.md', before: 'b', after: 'c', who: 'agent' });
    expect(store.review(vault, 'a.md', ids)).toMatchObject({ count: 2, before: 'a' });
  });
  it('declines an approved update after its note was opened, and keeps the text it replaced', () => {
    const { vault, clock, store } = setup();
    const abs = path.join(vault, 'a.md');
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper' });
    writeFileSync(abs, 'b');
    const { ids } = store.review(vault, 'a.md');
    clock.t += 1000;
    store.opened(vault, 'a.md');
    expect(store.reject(vault, 'a.md', ids)).toBe('a');
    expect(readFileSync(abs, 'utf8')).toBe('a');
    expect(store.review(vault, 'a.md', ids)).toBeNull();
    const newest = store.list(vault, 'a.md')[0];
    expect(newest).toMatchObject({ who: 'you' });
    expect(store.read(vault, 'a.md', newest.id)).toBe('b');
  });
  it('declines nothing when the note was updated again since the page showed it', () => {
    const { vault, clock, store } = setup();
    const abs = path.join(vault, 'a.md');
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper' });
    const { ids } = store.review(vault, 'a.md');
    clock.t += 1000;
    store.opened(vault, 'a.md');
    clock.t += 1000;
    store.record({ vault, rel: 'a.md', before: 'b', after: 'c', who: 'agent' });
    writeFileSync(abs, 'c');
    expect(store.reject(vault, 'a.md', ids)).toBeNull();
    expect(store.reject(vault, 'a.md', [])).toBeNull();
    expect(readFileSync(abs, 'utf8')).toBe('c');
  });
  it('declines every waiting update, and keeps updates from before them', () => {
    const { vault, clock, store, opts } = setup();
    const abs = path.join(vault, 'a.md');
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper' });
    clock.t += 1000;
    store.opened(vault, 'a.md');
    opts.auto = false;
    clock.t += 1000;
    store.record({ vault, rel: 'a.md', before: 'b', after: 'c', who: 'keeper' });
    writeFileSync(abs, 'c');
    expect(store.reject(vault, 'a.md')).toBe('b');
    expect(store.files(vault)['a.md'].updates).toHaveLength(1);
  });
  it('hands a note the updates made to remove, and leaves the file to it', () => {
    const { vault, store } = setup();
    const abs = path.join(vault, 'new.md');
    store.record({ vault, rel: 'new.md', before: null, after: 'x', who: 'keeper' });
    writeFileSync(abs, 'x');
    const r = store.review(vault, 'new.md');
    expect(r.created).toBe(true);
    const gone = [];
    expect(store.reject(vault, 'new.md', r.ids, (p) => gone.push(p))).toBe('');
    expect(gone).toEqual([abs]);
    expect(existsSync(abs)).toBe(true);
  });
  it('keeps a version without an update for writes that are no agent change', () => {
    const { vault, store } = setup({ auto: false });
    store.record({ vault, rel: 'a.md', before: 'a', after: 'b', who: 'keeper', agent: false });
    expect(store.list(vault, 'a.md')).toHaveLength(1);
    expect(store.dots(vault).files).toEqual({});
  });
});

describe('watching a run', () => {
  it('records every note whose text changed, was made or was removed during the run', async () => {
    const { vault, store } = setup({ auto: false });
    mkdirSync(path.join(vault, 'n'));
    mkdirSync(path.join(vault, '.obsidian'));
    writeFileSync(path.join(vault, 'n/a.md'), 'a1');
    writeFileSync(path.join(vault, 'n/gone.md'), 'bye');
    writeFileSync(path.join(vault, 'same.md'), 'same');
    writeFileSync(path.join(vault, '.obsidian/x.md'), 'x');
    const out = await store.watch(vault, { who: 'agent', reason: 'Chat question' }, async () => {
      writeFileSync(path.join(vault, 'n/a.md'), 'a2');
      writeFileSync(path.join(vault, 'n/new.md'), 'hi');
      rmSync(path.join(vault, 'n/gone.md'));
      writeFileSync(path.join(vault, '.obsidian/x.md'), 'y');
      return 42;
    });
    expect(out).toBe(42);
    expect(Object.keys(store.dots(vault).files).sort()).toEqual(['n/a.md', 'n/gone.md', 'n/new.md']);
    expect(store.list(vault, 'n/gone.md')[0]).toMatchObject({ removed: true, who: 'agent', reason: 'Chat question' });
    expect(store.read(vault, 'n/a.md', store.list(vault, 'n/a.md')[0].id)).toBe('a1');
  });
  it('reads markdown notes only, and skips what the caller leaves out', () => {
    const vault = tmp('mv-snap-');
    mkdirSync(path.join(vault, 'private'));
    writeFileSync(path.join(vault, 'a.md'), 'A');
    writeFileSync(path.join(vault, 'b.txt'), 'B');
    writeFileSync(path.join(vault, 'private/c.md'), 'C');
    expect([...snapshot(vault, (rel) => rel === 'private').keys()]).toEqual(['a.md']);
  });
});

describe('keeper writes keep versions', () => {
  it('records the files a keeper run changes, as the keeper, with the meeting it filed', async () => {
    const dir = tmp('mv-keeper-');
    writeStarter(dir, plan({ name: 'Studio', answers: { template: 'founder', role: 'Designer', goals: '', projects: ['Quorum'], people: ['Ada Lovelace'], organize: 'areas' } }));
    const { store } = setup({ auto: false });
    const keeper = createKeeper({ brain: () => ({ root: dir, vault: dir }), dataDir: `${dir}.data`, settings: { brainMade: 'quorum' }, owner: () => 'Rick Bot', versions: store });
    const note = '---\nquorum_id: 01X\ntitle: Quorum sync\ndate: 2026-11-10T15:00:00-08:00\nparticipants:\n  - Rick Bot (recorder)\n  - Ada Lovelace\nsource: quorum\n---\n\n# Quorum sync\n\nWe talked about Quorum.\n';
    writeFileSync(path.join(dir, '08-meetings', '2026-11-10-quorum-sync.md'), note);
    const r = await keeper.run({ reason: 'test', allowCreate: true });
    expect(r.filed).toBe(1);
    const files = Object.keys(store.dots(dir).files);
    expect(files).toContain('02-people/ada-lovelace.md');
    expect(files.every((f) => !f.startsWith('.quorum/keeper') && f !== '.quorum/changelog.md')).toBe(true);
    const [v] = store.list(dir, '02-people/ada-lovelace.md');
    expect(v).toMatchObject({ who: 'keeper', reason: 'Filed the meeting Quorum sync' });
    expect(store.read(dir, '02-people/ada-lovelace.md', v.id)).not.toContain('[[2026-11-10-quorum-sync]]');
    expect(readFileSync(path.join(dir, '02-people/ada-lovelace.md'), 'utf8')).toContain('[[2026-11-10-quorum-sync]]');
  });
});
