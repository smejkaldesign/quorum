// Live sync (ee/sync.js live()): the Realtime channel that turns remote changes into one debounced pullNow, and the
// vault watcher that turns a changed file into one push. The Supabase client is a fake whose channel stub records
// subscriptions and lets a test fire postgres_changes events; the vault is a temp folder watched for real. HOME points
// at a temp folder before the module loads, so sync-ids.json and sync-pull.json stay out of Application Support.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-live-home-'));
process.env.HOME = home;
const { createSync } = await import('../ee/sync.js');

const NOTE = '---\ntitle: Hello\n---\n# Hello\n\nBody line.\n';
const REMOTE = '---\ntitle: Hello\n---\n# Hello\n\nEdited elsewhere.\n';
const T2 = '2026-11-08T11:00:00.000Z';
const ID = '01JC0000000000000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// past the pull debounce (1s) and past the push debounce (1.5s) with room for the file system event to land
const AFTER_PULL = 1400, AFTER_PUSH = 2600;
const vaults = [], syncs = [];

// a PostgREST-shaped builder plus a Realtime channel stub: on() records each listener, subscribe() answers SUBSCRIBED
// at once, and fire() hands an event to every listener on that table. removeChannel records what was torn down
function fakeClient(rows = {}) {
  const calls = [], channels = [], removed = [];
  const from = (table) => {
    const call = { table, ops: [], rows: null };
    calls.push(call);
    const b = {};
    for (const op of ['select', 'eq', 'is', 'gt', 'in', 'like', 'order', 'range', 'limit', 'update']) b[op] = (...a) => { call.ops.push([op, ...a]); return b; };
    b.upsert = (data, opts) => { call.ops.push(['upsert', opts]); call.rows = data; return b; };
    b.then = (res, rej) => Promise.resolve({ data: call.ops.some(([o]) => o === 'upsert' || o === 'update') ? null : rows[table] ?? [], error: null }).then(res, rej);
    return b;
  };
  const channel = (name) => {
    const ch = { name, listeners: [], status: null };
    ch.on = (type, filter, cb) => { ch.listeners.push({ type, filter, cb }); return ch; };
    ch.subscribe = (cb) => { ch.status = cb; cb('SUBSCRIBED'); return ch; };
    ch.fire = (table, payload = {}) => { for (const l of ch.listeners) if (l.filter.table === table) l.cb({ eventType: 'UPDATE', table, ...payload }); };
    channels.push(ch);
    return ch;
  };
  const removeChannel = (ch) => { removed.push(ch); return Promise.resolve('ok'); };
  const pulls = () => calls.filter((c) => c.table === 'notes' && c.ops.some(([o]) => o === 'select')).length;
  const pushes = () => calls.filter((c) => c.table === 'notes' && c.rows).flatMap((c) => c.rows);
  return { client: { from, channel, removeChannel }, calls, channels, removed, pulls, pushes };
}

function harness({ files = {}, rows = {}, isExcluded } = {}) {
  const vault = mkdtempSync(path.join(tmpdir(), 'quorum-live-vault-'));
  vaults.push(vault);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
  }
  const fake = fakeClient(rows);
  const state = { sync: true, signedIn: true, workspace: { id: `ws-${path.basename(vault)}` }, userId: 'user-1', lastSyncAt: null, lastPullAt: null, syncError: null, live: false };
  const account = { state: () => state, client: () => fake.client, markSync: (patch) => Object.assign(state, patch) };
  const store = { notes: { write: (abs, text) => writeFileSync(abs, text) }, meetings: { root: path.join(vault, '.sessions') } };
  const sync = createSync({ account, store, brain: () => ({ vault }), isExcluded });
  syncs.push(sync);
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); };
  return { vault, state, rows, sync, fake, write };
}
const noteRow = (over) => ({ id: ID, path: 'notes/hello.md', frontmatter: { title: 'Hello' }, body: REMOTE, hash: '', mtime: T2, updated_at: T2, deleted_at: null, ...over });
const readFile = (vault, rel) => readFileSync(path.join(vault, rel), 'utf8');

afterEach(() => { for (const s of syncs.splice(0)) s.stop(); });
afterAll(() => {
  for (const v of vaults) rmSync(v, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('realtime pull', () => {
  it('subscribes to notes and meetings for the workspace and reports live', () => {
    const h = harness();
    expect(h.sync.status().live).toBe(false);
    expect(h.sync.live()).toBe(true);
    expect(h.fake.channels).toHaveLength(1);
    const ch = h.fake.channels[0];
    expect(ch.name).toBe(`sync:${h.state.workspace.id}`);
    expect(ch.listeners.map((l) => l.type)).toEqual(['postgres_changes', 'postgres_changes']);
    expect(ch.listeners.map((l) => l.filter)).toEqual([
      { event: '*', schema: 'public', table: 'notes', filter: `workspace_id=eq.${h.state.workspace.id}` },
      { event: '*', schema: 'public', table: 'meetings', filter: `workspace_id=eq.${h.state.workspace.id}` },
    ]);
    expect(h.sync.status().live).toBe(true);
    expect(h.state.live).toBe(true);
    // a second live() with nothing changed keeps the same channel
    h.sync.live();
    expect(h.fake.channels).toHaveLength(1);
  });

  it('runs pullNow once for a burst of three events', async () => {
    const h = harness({ rows: { notes: [noteRow()] } });
    h.sync.live();
    const ch = h.fake.channels[0];
    ch.fire('notes');
    ch.fire('meetings');
    ch.fire('notes');
    expect(h.fake.pulls()).toBe(0);
    await sleep(AFTER_PULL);
    expect(h.fake.pulls()).toBe(1);
    expect(h.state.lastPullAt).toBeTruthy();
    // the pull wrote the remote note into the vault
    expect(readFile(h.vault, 'notes/hello.md')).toBe(REMOTE);
    await sleep(AFTER_PULL);
    expect(h.fake.pulls()).toBe(1);
  });

  it('drops the channel when sync goes off and moves it on a workspace switch', () => {
    const h = harness();
    h.sync.live();
    const first = h.fake.channels[0];
    h.state.sync = false;
    expect(h.sync.live()).toBe(false);
    expect(h.fake.removed).toEqual([first]);
    expect(h.state.live).toBe(false);
    h.state.sync = true;
    h.state.workspace = { id: 'ws-other' };
    expect(h.sync.live()).toBe(true);
    expect(h.fake.channels).toHaveLength(2);
    expect(h.fake.channels[1].name).toBe('sync:ws-other');
    expect(h.fake.channels[1].listeners[0].filter.filter).toBe('workspace_id=eq.ws-other');
    h.state.workspace = { id: 'ws-third' };
    h.sync.live();
    expect(h.fake.removed).toEqual([first, h.fake.channels[1]]);
    expect(h.fake.channels).toHaveLength(3);
  });

  it('reports polling while the channel is down and pulls again when it rejoins', async () => {
    const h = harness();
    h.sync.live();
    const ch = h.fake.channels[0];
    await sleep(AFTER_PULL);
    expect(h.fake.pulls()).toBe(1);
    ch.status('CHANNEL_ERROR', new Error('socket closed'));
    expect(h.sync.status().live).toBe(false);
    expect(h.state.live).toBe(false);
    ch.status('SUBSCRIBED');
    expect(h.sync.status().live).toBe(true);
    await sleep(AFTER_PULL);
    expect(h.fake.pulls()).toBe(2);
  });
});

describe('vault watcher push', () => {
  // the vault starts empty: FSEvents replays changes made moments before the watcher started, so a file created in
  // the harness would be pushed as well, which is correct and would make the count below ambiguous
  it('pushes a changed file once after the debounce', async () => {
    const h = harness();
    h.sync.live();
    await sleep(300);
    h.write('notes/new.md', NOTE);
    await sleep(200);
    h.write('notes/new.md', `${NOTE}More.\n`);
    expect(h.fake.pushes()).toHaveLength(0);
    await sleep(AFTER_PUSH);
    const rows = h.fake.pushes();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('notes/new.md');
    expect(rows[0].body).toBe(`${NOTE}More.\n`);
    expect(h.state.lastSyncAt).toBeTruthy();
    await sleep(AFTER_PUSH);
    expect(h.fake.pushes()).toHaveLength(1);
  });

  it('pushes nothing for a file the pull wrote', async () => {
    const h = harness({ rows: { notes: [noteRow()] } });
    h.sync.live();
    await sleep(300);
    expect(await h.sync.pullNow()).toEqual({ written: 1, conflicts: 0, removed: 0, skipped: 0 });
    expect(readFile(h.vault, 'notes/hello.md')).toBe(REMOTE);
    await sleep(AFTER_PUSH);
    expect(h.fake.pushes()).toHaveLength(0);
    // an edit after the pull goes up with the id the row carried
    h.write('notes/hello.md', `${REMOTE}Local edit.\n`);
    await sleep(AFTER_PUSH);
    const rows = h.fake.pushes();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ID);
    expect(rows[0].body).toBe(`${REMOTE}Local edit.\n`);
  });

  it('pushes nothing for excluded paths, non-markdown files or a save already pushed', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE }, isExcluded: (rel) => rel.startsWith('private/') });
    h.sync.live();
    await sleep(300);
    expect(await h.sync.pushNote(path.join(h.vault, 'notes/hello.md'))).toBe(true);
    h.write('private/secret.md', NOTE);
    h.write('notes/image.png', 'not markdown');
    h.write('.obsidian/workspace.md', NOTE);
    await sleep(AFTER_PUSH);
    expect(h.fake.pushes().map((r) => r.path)).toEqual(['notes/hello.md']);
  });

  it('stops watching when sync goes off', async () => {
    const h = harness();
    h.sync.live();
    await sleep(300);
    h.state.sync = false;
    h.sync.live();
    h.write('notes/later.md', NOTE);
    await sleep(AFTER_PUSH);
    expect(h.fake.pushes()).toHaveLength(0);
  });
});
