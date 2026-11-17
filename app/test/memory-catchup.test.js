// Check everything now (memoryCatchup.js) on the synthetic contradiction vault (test/fixtures/contradictions) and a
// synthetic missing-note item. Every note, name and line is made up. The model is always a fake.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createResolver, parseNote } from '../linkparse.js';
import { createContradictionAgent } from '../contradictionAgent.js';
import { createDrafter, evidenceRels } from '../memoryDraft.js';
import { createAgentActivity } from '../agentActivity.js';
import { analyze } from '../rules/contradictions.js';
import { catchupLabel, createCatchup, notesLabel } from '../memoryCatchup.js';
import { createLastRunStore } from '../catchupPlan.js';
import { createVaultIndex } from '../vindex.js';
import { synthModel, writeSynthVault } from './fixtures/synthVault.js';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/contradictions');
const walk = (dir, base = '') => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f), `${base}${f}/`) : [`${base}${f}`]));
const note = (rel, text) => ({ rel, text, note: parseNote(rel, text), mtime: 0, size: text.length, inbound: 0, outbound: 0 });
function vault() {
  const root = path.join(DIR, 'vault');
  const notes = walk(root).filter((r) => r.endsWith('.md')).sort().map((rel) => note(rel, readFileSync(path.join(root, rel), 'utf8')));
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  return { notes, resolve: createResolver(notes.map((n) => n.rel), (rel) => byRel.get(rel)?.note.aliases ?? []) };
}
const confidentialText = (text) => /^confidential:\s*(?!false|none|no\b)\S/m.test(text);

const createItem = { id: 'r:link:zephyr', kind: 'link', key: 'zephyr', target: 'zephyr', title: 'zephyr', reviewOnly: true, ops: [{ op: 'create', rel: 'notes/zephyr.md', sources: ['notes/a.md', 'notes/b.md'] }] };
const DRAFT_NOTES = { 'notes/a.md': '# A\nThe zephyr project ships in March.\nOther line.', 'notes/b.md': '# B\nzephyr owner is the platform group.' };
const GOOD_DRAFT = JSON.stringify({ kind: 'create', text: 'Zephyr ships in March.', quotes: [{ path: 'notes/a.md', line: 2, text: 'ships in March' }], confidence: 'high' });

let dirs = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'qcatch-')); dirs.push(d); return d; };

// the app's wiring with fakes: one fake model for both, which answers a draft prompt with a draft and a claim prompt
// with no claims. hold: a promise the model waits on, so a test can cancel a call while it runs
function setup(opts = {}) {
  const dir = tmp();
  const v = vault();
  const calls = [];
  const signals = { draft: null, claims: null };
  let gate = null;
  const model = (kind) => async () => {
    const signal = signals[kind]?.signal ?? null;
    calls.push(kind);
    if (opts.hold) await new Promise((resolve, reject) => { gate = resolve; signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }))); });
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    if (kind === 'claims' && opts.failClaims) return 'not an answer';
    return kind === 'draft' ? GOOD_DRAFT : JSON.stringify({ claims: [] });
  };
  const now = () => Date.UTC(2026, 10, 16, 12);
  // the person typed a moment ago and the daily cap is used up: a catch-up runs anyway
  const drafter = createDrafter({ file: path.join(dir, 'drafts.json'), model: model('draft'), items: () => [createItem], evidence: (i) => evidenceRels(i).map((rel) => ({ rel, text: DRAFT_NOTES[rel] })), enabled: () => opts.enabled ?? true, cap: () => opts.cap ?? 0, busy: () => opts.busy?.() ?? false, idleMs: () => 0, now });
  const agent = createContradictionAgent({ file: path.join(dir, 'contra.json'), model: model('claims'), enabled: () => opts.enabled ?? true, cap: () => opts.cap ?? 0, busy: () => opts.busy?.() ?? false, idleMs: () => 0, readable: (rel, text) => !confidentialText(text), now });
  const shown = [];
  const activity = createAgentActivity({ emit: (s) => shown.push(s), setTimer: () => null, clearTimer: () => {} });
  const ctx = { notes: v.notes, resolve: v.resolve, contradictions: { provider: agent.provider } };
  const catchup = createCatchup({ drafter, agent, activity, refresh: async () => { analyze(ctx); }, bind: (kind, ctl) => { signals[kind] = ctl; }, notes: () => v.notes.length, wait: async () => {}, busyWaitMs: 0, ...(opts.catchup?.({ agent, v }) ?? {}) });
  return { catchup, drafter, agent, activity, calls, shown, v, release: () => gate?.(), ctx };
}

describe('Check everything now', () => {
  it('runs every pending draft and claim batch in one pass, past the daily cap, and stops by itself', async () => {
    const s = setup();
    analyze(s.ctx);
    const claimCalls = s.agent.pendingCalls();
    expect(claimCalls).toBeGreaterThan(0);
    // a draft and its second draft, then every claim batch
    expect(s.catchup.remaining()).toBe(2 + claimCalls);
    // the normal tick waits on the used up cap
    expect((await s.drafter.tick()).skipped).toBe('cap');
    await s.catchup.start();
    expect(s.catchup.running()).toBe(true);
    const last = await s.catchup.done();
    expect(last).toMatchObject({ end: 'done', done: 2 + claimCalls, notes: s.v.notes.length });
    expect(s.calls.filter((c) => c === 'draft')).toHaveLength(2);
    expect(s.calls.filter((c) => c === 'claims')).toHaveLength(claimCalls);
    expect(s.catchup.running()).toBe(false);
    expect(s.catchup.remaining()).toBe(0);
    // the pass's calls did not count against the daily cap, so the normal cap applies as before
    expect(s.drafter.status().used).toBe(0);
    expect(s.agent.status().used).toBe(0);
  });

  it('shows its progress in the agent activity banner at once, and hides it when the pass ends', async () => {
    const s = setup();
    await s.catchup.start();
    const first = s.shown.find(Boolean);
    expect(first.kind).toBe('catchup');
    expect(first.cancellable).toBe(true);
    await s.catchup.done();
    const progress = s.shown.filter((x) => x?.progress);
    const end = progress[progress.length - 1];
    expect(end.label).toBe(catchupLabel(s.v.notes.length, end.progress.done, end.progress.total));
    expect(end.label).toMatch(/^Checking all \d+ notes: \d+ of \d+ calls$/);
    expect(s.shown[s.shown.length - 1]).toBeNull();
  });

  it('runs one model call at a time, and Cancel stops the call, gives nothing to the cap and leaves the rest for later', async () => {
    const s = setup({ hold: true, cap: 40 });
    await s.catchup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls).toEqual(['draft']);
    // a second start while it runs is the same pass
    expect((await s.catchup.start()).running).toBe(true);
    expect(s.calls).toEqual(['draft']);
    expect(s.catchup.cancel()).toBe(true);
    const last = await s.catchup.done();
    expect(last.end).toBe('cancelled');
    expect(last.done).toBe(0);
    expect(s.drafter.status().used).toBe(0);
    // the cancelled draft is not marked failed: the normal drafter asks for it again under the cap
    expect(s.drafter.pendingCalls()).toBe(2);
  });

  it('waits while a recording or a fix runs, then goes on', async () => {
    let busy = 3;
    const s = setup({ busy: () => busy-- > 0 });
    await s.catchup.start();
    const last = await s.catchup.done();
    expect(last.end).toBe('done');
    expect(s.calls.length).toBe(last.done);
    expect(busy).toBeLessThan(0);
  });

  it('never sends a confidential note, and stops when drafting is off', async () => {
    const s = setup();
    await s.catchup.start();
    await s.catchup.done();
    const sent = s.calls.length;
    expect(sent).toBeGreaterThan(0);
    const confidential = s.v.notes.filter((n) => confidentialText(n.text)).map((n) => n.rel);
    expect(confidential.length).toBeGreaterThan(0);
    for (const rel of confidential) expect(s.agent.estimate([{ rel, text: s.v.notes.find((n) => n.rel === rel).text, rank: 0 }]).notes).toBe(0);
    const off = setup({ enabled: false });
    await off.catchup.start();
    expect((await off.catchup.done()).end).toBe('off');
    expect(off.calls).toEqual([]);
  });

  it('estimates the claim calls of a first pass from stage 1, leaving out notes whose claims are stored', async () => {
    const s = setup();
    const a = analyze({ notes: s.v.notes, resolve: s.v.resolve });
    const before = s.agent.estimate(a.toRead);
    expect(before.calls).toBeGreaterThan(0);
    await s.catchup.start();
    await s.catchup.done();
    expect(s.agent.estimate(a.toRead).calls).toBe(0);
  });
  // the note count counts the notes saved from earlier passes, and the last pass is kept in the data folder
  const counted = (file, review = () => []) => ({ agent, v }) => ({
    saved: () => agent.estimate(analyze({ notes: v.notes, resolve: v.resolve }).toRead).saved,
    left: () => agent.pendingNotes(),
    review,
    store: createLastRunStore(file),
  });

  it('counts notes checked of the notes to check, so a second pass starts at the notes saved by the first', async () => {
    const dir = tmp();
    const file = path.join(dir, 'last.json');
    const s = setup({ catchup: counted(file) });
    await s.catchup.start();
    const first = await s.catchup.done();
    expect(first.of).toBeGreaterThan(0);
    expect(first.checked).toBe(first.of);
    expect(first.saved).toBe(0);
    const labels = s.shown.filter((x) => x?.progress).map((x) => x.label);
    expect(labels[labels.length - 1]).toBe(notesLabel(first.checked, first.of));
    // a new pass on the same stored claims: nothing reads 0 of N, the saved notes count from the start
    const again = createCatchup({ drafter: s.drafter, agent: s.agent, activity: s.activity, refresh: async () => { analyze(s.ctx); }, notes: () => s.v.notes.length, wait: async () => {}, busyWaitMs: 0, ...counted(file)({ agent: s.agent, v: s.v }) });
    const st = await again.start();
    expect(st.running).toBe(true);
    expect(st.saved).toBe(first.of);
    expect(st.checked).toBe(first.of);
    const second = await again.done();
    expect(second.checked).toBe(first.of);
    // the last pass reads again from the data folder
    expect(createLastRunStore(file).load()).toMatchObject({ end: 'done', checked: first.of, of: first.of });
    // the start list is written once and removed when the pass ends; the saves carry counts only
    expect(existsSync(path.join(dir, 'last-before.json'))).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).before).toBeUndefined();
  });

  it('keeps the last pass after a restart, shows a pass a crash stopped as crashed, and Dismiss sticks', async () => {
    const dir = tmp();
    const file = path.join(dir, 'last.json');
    const store = createLastRunStore(file, () => 5000);
    store.saveBefore([{ id: 'r:find:a', type: 'other', drafted: false }]);
    store.save({ end: 'running', done: 3, total: 9, notes: 12, checked: 4, of: 10, saved: 1, startedAt: 1000 });
    const items = [{ id: 'r:find:a', type: 'other', drafted: true }, { id: 'r:find:b', type: 'contradiction', drafted: false }];
    const s = setup({ catchup: () => ({ store: createLastRunStore(file), review: () => items }) });
    const st = s.catchup.status();
    expect(st.running).toBe(false);
    expect(st.last).toMatchObject({ end: 'crashed', checked: 4, of: 10, startedAt: 1000, endedAt: 5000 });
    expect(st.last.added).toMatchObject({ contradictions: 1, drafts: 1, other: 0 });
    expect(st.last.before).toBeUndefined();
    expect(s.catchup.dismiss()).toBe(true);
    expect(createLastRunStore(file).load()).toMatchObject({ end: 'crashed', dismissed: true });
  });

  it('tells what a pass added to Needs review', async () => {
    let items = [{ id: 'r:link:x', type: 'other', drafted: false }];
    const s = setup({ catchup: () => ({ review: () => items }) });
    await s.catchup.start();
    items = [...items, { id: 'r:find:c', type: 'contradiction', drafted: false }, { id: 'r:link:zephyr', type: 'other', drafted: true }];
    const last = await s.catchup.done();
    expect(last.added).toEqual({ contradictions: 1, drafts: 1, other: 0, ids: ['r:find:c', 'r:link:zephyr'] });
  });
  it('saves a cancelled pass as cancelled, with what it added', async () => {
    const dir = tmp();
    const file = path.join(dir, 'last.json');
    let items = [];
    const s = setup({ hold: true, cap: 40, catchup: () => ({ store: createLastRunStore(file), review: () => items }) });
    await s.catchup.start();
    await new Promise((r) => setTimeout(r, 0));
    items = [{ id: 'r:find:c', type: 'contradiction', drafted: false }];
    expect(s.catchup.cancel()).toBe(true);
    const last = await s.catchup.done();
    expect(last).toMatchObject({ end: 'cancelled', added: { contradictions: 1, drafts: 0, other: 0, ids: ['r:find:c'] } });
    expect(createLastRunStore(file).load()).toMatchObject({ end: 'cancelled', added: { contradictions: 1 } });
  });

  it('counts the notes of a failed claim call as skipped, so checked and skipped add up to the notes to check', async () => {
    const dir = tmp();
    const s = setup({ failClaims: true, catchup: counted(path.join(dir, 'last.json')) });
    await s.catchup.start();
    const last = await s.catchup.done();
    expect(last.end).toBe('done');
    expect(last.skipped).toBeGreaterThan(0);
    expect(last.checked).toBeLessThan(last.of);
    expect(last.checked + last.skipped).toBe(last.of);
  });

  it('waits for the vault to read before it tells what a crashed pass added', () => {
    const dir = tmp();
    const file = path.join(dir, 'last.json');
    const store = createLastRunStore(file, () => 5000);
    store.saveBefore([]);
    store.save({ end: 'running', done: 1, total: 4, notes: 12, startedAt: 1000 });
    let items = null;
    const s = setup({ catchup: () => ({ store: createLastRunStore(file), review: () => items }) });
    // the vault has not read yet: nothing is told, and the start list is kept for later
    const first = s.catchup.status();
    expect(first.last.end).toBe('crashed');
    expect(first.last.added).toBeUndefined();
    expect(existsSync(path.join(dir, 'last-before.json'))).toBe(true);
    items = [{ id: 'r:link:x', type: 'other', drafted: false }];
    expect(s.catchup.status().last.added).toEqual({ contradictions: 0, drafts: 0, other: 1, ids: ['r:link:x'] });
    expect(existsSync(path.join(dir, 'last-before.json'))).toBe(false);
  });
});

describe('Check everything now with calls in parallel', () => {
  // a generated vault of 300 notes (test/fixtures/synthVault.js) and a fake model that holds each call until released
  async function parallelSetup(parallel) {
    const root = tmp();
    writeSynthVault(path.join(root, 'vault'), { notes: 300 });
    const ix = createVaultIndex({ vault: path.join(root, 'vault'), isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    ix.sync();
    const asked = new Map();
    const open = new Set();
    let most = 0;
    let signal = null;
    const signals = [];
    const model = async (prompt, system, opts) => {
      const mine = signal;
      signals.push(mine);
      for (const b of prompt.split('<note path="').slice(1)) { const rel = b.slice(0, b.indexOf('"')); asked.set(rel, (asked.get(rel) ?? 0) + 1); }
      const judge = /Claim A in/.test(prompt);
      if (judge) asked.set(prompt, (asked.get(prompt) ?? 0) + 1);
      expect(opts.kind).toBe(judge ? 'judge' : 'claims');
      open.add(mine);
      most = Math.max(most, open.size);
      try {
        await new Promise((resolve, reject) => { const t = setTimeout(resolve, 5); mine?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled'), { cancelled: true })); }); });
      } finally { open.delete(mine); }
      return synthModel(prompt);
    };
    const agent = createContradictionAgent({ file: path.join(root, 'contra.json'), model, enabled: () => true, cap: () => 0, idleMs: () => 0 });
    // the signal a lane passes reaches the model the way memoryHost.js routes it, before the call starts
    const lanes = { ...agent, tick: (o) => { signal = o.signal ?? null; return agent.tick(o); } };
    const drafter = createDrafter({ file: path.join(root, 'drafts.json'), model: async () => '', items: () => [], evidence: () => null, enabled: () => true, cap: () => 0, idleMs: () => 0 });
    const activity = createAgentActivity({ emit: () => {}, setTimer: () => null, clearTimer: () => {} });
    const ctx = { notes: ix.snapshot(), resolve: (t, f) => ix.resolve(t, f), contradictions: { provider: agent.provider } };
    const catchup = createCatchup({ drafter, agent: lanes, activity, refresh: async () => { analyze(ctx); }, notes: () => 300, wait: async () => {}, busyWaitMs: 0, parallel: () => parallel });
    return { catchup, asked, signals, most: () => most, open, activity };
  }

  it('runs up to four calls at once, each with its own abort, and asks for each note and pair once', async () => {
    const s = await parallelSetup(4);
    await s.catchup.start();
    const last = await s.catchup.done();
    expect(last.end).toBe('done');
    expect(s.most()).toBe(4);
    expect(new Set(s.signals).size).toBe(s.signals.length);
    expect(s.signals.every((x) => x instanceof AbortSignal)).toBe(true);
    expect([...s.asked.values()].every((n) => n === 1)).toBe(true);
    expect([...s.asked.keys()].some((k) => k.includes('Claim A in'))).toBe(true);
  });

  it('cancels every call that runs on Cancel', async () => {
    const s = await parallelSetup(4);
    const st = await s.catchup.start();
    while (s.open.size < 4) await new Promise((r) => setTimeout(r, 1));
    const running = [...s.open];
    s.activity.cancel(st.id);
    const last = await s.catchup.done();
    expect(last.end).toBe('cancelled');
    expect(running.every((x) => x.aborted)).toBe(true);
  });
});
