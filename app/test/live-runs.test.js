import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLiveRuns, liveState, stopAndRestore } from '../liveRuns.js';
import { createVersionStore } from '../memoryVersions.js';
import { createKeeper, CHANGELOG } from '../keeper.js';
import { plan, writeStarter } from '../starter.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

function fakeTimers() {
  const list = [];
  return { list, setTimer: (fn, ms) => { const t = { fn, ms }; list.push(t); return t; }, clearTimer: (t) => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); }, fire: () => { const due = list.splice(0); for (const t of due) t.fn(); } };
}

describe('live run state', () => {
  it('names files and their folders while a run is going, and drops them when it ends', () => {
    const seen = [];
    const live = createLiveRuns({ onChange: (s) => seen.push(s) });
    const id = live.start({ who: 'keeper', label: 'Upkeep', stop: async () => {} });
    live.touch(id, 'a/b/x.md', 'v1');
    live.touch(id, 'a/y.md', 'v2');
    live.touch(id, 'a/y.md', 'v3');
    const s = live.state();
    expect(s.files).toEqual({ 'a/b/x.md': id, 'a/y.md': id });
    expect(s.folders).toEqual(['a', 'a/b']);
    expect(s.runs[0]).toMatchObject({ who: 'keeper', label: 'Upkeep', stoppable: true, wholeVault: false });
    expect(live.get(id).files.get('a/y.md')).toEqual(['v2', 'v3']);
    // a second write to a known file does not announce a change
    expect(seen).toHaveLength(3);
    live.end(id);
    expect(live.state()).toEqual({ runs: [], files: {}, folders: [], vault: [] });
  });
  it('lists runs over the whole vault on their own, and a run without a stop is not stoppable', () => {
    const live = createLiveRuns();
    const id = live.start({ who: 'agent', label: 'Agent', wholeVault: true });
    expect(live.state()).toMatchObject({ vault: [id], files: {}, runs: [{ stoppable: false, wholeVault: true }] });
  });
  it('keeps an import running while writes keep coming, and ends it once they stop', () => {
    const t = fakeTimers();
    const live = createLiveRuns({ setTimer: t.setTimer, clearTimer: t.clearTimer, idleMs: 4000 });
    const a = live.pulse({ who: 'import', label: 'Import' }, 'm/one.md', 'v1');
    const b = live.pulse({ who: 'import', label: 'Import' }, 'm/two.md', 'v2');
    expect(a).toBe(b);
    expect(t.list).toHaveLength(1);
    expect(Object.keys(live.state().files)).toEqual(['m/one.md', 'm/two.md']);
    t.fire();
    expect(live.state().runs).toEqual([]);
  });
  it('gives a file to the newest run that wrote it', () => {
    const s = liveState([{ id: 'r1', files: ['x.md'] }, { id: 'r2', files: ['x.md', 'f/y.md'] }]);
    expect(s.files).toEqual({ 'x.md': 'r2', 'f/y.md': 'r2' });
    expect(s.folders).toEqual(['f']);
  });
});

describe('undo and reject in the version store', () => {
  it('puts back the text from before a run and deletes the run\'s versions and updates', () => {
    const vault = tmp('lr-vault-');
    const store = createVersionStore({ dir: tmp('lr-data-'), autoApprove: () => false });
    const abs = path.join(vault, 'a.md');
    store.record({ vault, rel: 'a.md', before: 'v0', after: 'v1', who: 'keeper', reason: 'earlier' });
    writeFileSync(abs, 'v1');
    const r1 = store.record({ vault, rel: 'a.md', before: 'v1', after: 'v2', who: 'keeper', reason: 'run' });
    const r2 = store.record({ vault, rel: 'a.md', before: 'v2', after: 'v3', who: 'keeper', reason: 'run' });
    writeFileSync(abs, 'v3');
    expect(store.undo(vault, 'a.md', [r1.version.id, r2.version.id])).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('v1');
    expect(store.list(vault, 'a.md').map((v) => v.reason)).toEqual(['earlier']);
    expect(store.review(vault, 'a.md')).toMatchObject({ count: 1, before: 'v0' });
  });
  it('removes a file the run made, and keeps no record of it', () => {
    const vault = tmp('lr-vault-');
    const store = createVersionStore({ dir: tmp('lr-data-') });
    writeFileSync(path.join(vault, 'new.md'), 'made');
    const r = store.record({ vault, rel: 'new.md', before: null, after: 'made', who: 'keeper' });
    expect(store.undo(vault, 'new.md', [r.version.id])).toBe(true);
    expect(existsSync(path.join(vault, 'new.md'))).toBe(false);
    expect(store.list(vault, 'new.md')).toEqual([]);
    expect(store.dots(vault).files).toEqual({});
  });
  it('rejects the waiting updates: the earlier text comes back as a version by you, and the dot clears', () => {
    const vault = tmp('lr-vault-');
    const store = createVersionStore({ dir: tmp('lr-data-'), autoApprove: () => false });
    const abs = path.join(vault, 'a.md');
    writeFileSync(abs, 'two');
    store.record({ vault, rel: 'a.md', before: 'one', after: 'two', who: 'agent', reason: 'edit' });
    expect(store.reject(vault, 'a.md')).toBe('one');
    expect(readFileSync(abs, 'utf8')).toBe('one');
    expect(store.dots(vault).files).toEqual({});
    expect(store.list(vault, 'a.md')[0]).toMatchObject({ who: 'you', reason: 'Rejected the updates' });
    expect(store.reject(vault, 'a.md')).toBeNull();
  });
});

describe('stopping a keeper run', () => {
  it('stops at the next write and puts back every file the run changed', async () => {
    const dir = tmp('lr-keeper-');
    writeStarter(dir, plan({ name: 'Studio', answers: { template: 'founder', role: 'Designer', goals: '', projects: ['Quorum'], people: ['Ada Lovelace'], organize: 'areas' } }));
    const store = createVersionStore({ dir: tmp('lr-data-') });
    const live = createLiveRuns();
    const person = path.join(dir, '02-people', 'ada-lovelace.md');
    const personBefore = readFileSync(person, 'utf8');
    const logBefore = existsSync(path.join(dir, CHANGELOG)) ? readFileSync(path.join(dir, CHANGELOG), 'utf8') : null;
    let release;
    const gate = new Promise((r) => { release = r; });
    let asked;
    const askedP = new Promise((r) => { asked = r; });
    const runText = async () => { asked(); await gate; return '- Ada leads the design review every Tuesday'; };
    const keeper = createKeeper({ brain: () => ({ root: dir, vault: dir }), settings: { brainMade: 'quorum' }, owner: () => 'Rick Bot', versions: store, live, runText, hasModel: () => true });
    writeFileSync(path.join(dir, '08-meetings', '2026-11-10-quorum-sync.md'), '---\nquorum_id: 01X\ntitle: Quorum sync\ndate: 2026-11-10T15:00:00-08:00\nparticipants:\n  - Rick Bot (recorder)\n  - Ada Lovelace\nsource: quorum\n---\n\n# Quorum sync\n\nWe talked about Quorum.\n');
    const running = keeper.run({ reason: 'test', allowCreate: true });
    await askedP;
    // the keeper wrote the person note before asking for facts, so the run names it
    const [run] = live.state().runs;
    expect(run).toMatchObject({ who: 'keeper', stoppable: true });
    expect(live.state().files['02-people/ada-lovelace.md']).toBe(run.id);
    expect(readFileSync(person, 'utf8')).not.toBe(personBefore);
    const stopping = stopAndRestore(live, run.id, { store, vault: dir });
    release();
    const restored = await stopping;
    const result = await running;
    expect(result.stopped).toBe(true);
    expect(result.error).toBeNull();
    expect(restored).toContain('02-people/ada-lovelace.md');
    expect(readFileSync(person, 'utf8')).toBe(personBefore);
    expect(existsSync(path.join(dir, CHANGELOG)) ? readFileSync(path.join(dir, CHANGELOG), 'utf8') : null).toBe(logBefore);
    expect(store.list(dir, '02-people/ada-lovelace.md')).toEqual([]);
    expect(live.state().runs).toEqual([]);
    // nothing was saved as filed, so the next run files the note again
    const again = await keeper.run({ reason: 'test', allowCreate: true });
    expect(again.filed).toBe(1);
  });
});
