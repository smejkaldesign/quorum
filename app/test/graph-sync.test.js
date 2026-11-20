// Cloud graph sync (ee/graphSync.js, migration 0049) between two real memory graphs on temp vaults, through the real
// vault index. The Supabase client is an in-memory fake that applies the same rules as the migration: graph_put writes
// only on the caller's own knowledge base notes and refuses unreviewed model edges, graph_heads and the links read
// return only notes the caller can read, and a note that leaves its knowledge base loses its rows.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-gsync-home-'));
process.env.HOME = home;
const { createVaultIndex } = await import('../vindex.js');
const { createMemoryGraph } = await import('../graph/index.js');
const { createGraphSync, MODEL_PUBLISH_MIN, publishable, safePath, teamId } = await import('../ee/graphSync.js');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const WS = '01GR00000000000000000000WA';
const KB = '01GR00000000000000000000KH';
const LEAD = '01GR00000000000000000000KM';
const OPT_OUT = /acme/i;
const CONFIDENTIAL = /^confidential:/m;

const cleanup = [];
afterEach(() => { while (cleanup.length) { try { cleanup.pop()(); } catch { /* closed */ } } });
afterAll(() => rmSync(home, { recursive: true, force: true }));

// ---- the fake server
function fakeServer() {
  const notes = [];
  let links = [];
  const readers = new Map([[KB, new Set(['alice', 'bob'])], [LEAD, new Set(['alice'])]]);
  let n = 0;
  const id = () => `01GR${String(++n).padStart(22, '0')}`;
  const live = (x) => !x.deleted_at;
  const canRead = (user, note) => !!note && live(note) && (note.user_id === user || (!!note.kb_id && !!readers.get(note.kb_id)?.has(user)));
  const noteOf = (nid) => notes.find((x) => x.id === nid);
  const server = {
    notes, readers, offline: false, calls: [],
    get links() { return links; },
    // what sync would have pushed: the file's text hash, and the note's knowledge base
    note(user, rel, text, kb = KB) {
      let row = notes.find((x) => x.user_id === user && x.path === rel);
      if (!row) { row = { id: id(), user_id: user, workspace_id: WS, path: rel, deleted_at: null }; notes.push(row); }
      Object.assign(row, { hash: sha(text), kb_id: kb });
      return row;
    },
    // migration 0049's trigger: a note out of its knowledge base, or deleted, loses its graph rows
    leaveKb(row, patch = { kb_id: null }) { Object.assign(row, patch); links = links.filter((l) => l.from_note !== row.id); },
  };
  class Query {
    constructor(rows) { this.rows = rows; }
    eq(c, v) { this.rows = this.rows.filter((r) => r[c] === v); return this; }
    in(c, vs) { this.rows = this.rows.filter((r) => vs.includes(r[c])); return this; }
    not(c, op, v) { if (op === 'is' && v === null) this.rows = this.rows.filter((r) => r[c] !== null && r[c] !== undefined); return this; }
    is(c, v) { if (v === null) this.rows = this.rows.filter((r) => r[c] === null || r[c] === undefined); return this; }
    select() { return this; }
    order(c) { this.rows = [...this.rows].sort((a, b) => String(a[c]).localeCompare(String(b[c]))); return this; }
    range(a, b) { this.rows = this.rows.slice(a, b + 1); return this; }
    then(ok, bad) { return Promise.resolve(server.offline ? { data: null, error: { message: 'offline' } } : { data: this.rows.map((r) => ({ ...r })), error: null }).then(ok, bad); }
  }
  // a refused call, chainable like a query
  const refused = (message) => ({ order() { return this; }, range() { return this; }, then: (ok, bad) => Promise.resolve({ data: null, error: { message } }).then(ok, bad) });
  server.client = (user) => ({
    from(table) {
      server.calls.push({ user, table });
      if (table === 'notes') return new Query(notes.filter((x) => canRead(user, x)));
      if (table === 'links') return new Query(links.filter((l) => l.user_id === user || canRead(user, noteOf(l.from_note))));
      throw new Error(`no table ${table}`);
    },
    rpc(name, args) {
      server.calls.push({ user, rpc: name, args });
      if (server.offline) return refused('offline');
      if (name === 'graph_heads') {
        const heads = new Map();
        for (const l of links) {
          const note = noteOf(l.from_note);
          if (l.workspace_id !== args.workspace_id || !note?.kb_id || !live(note) || !(l.user_id === user || canRead(user, note))) continue;
          const h = heads.get(note.id) ?? { note_id: note.id, kb_id: note.kb_id, path: note.path, author: note.user_id, graph_hash: l.graph_hash, note_hash: l.note_hash, edges: 0 };
          h.edges++;
          heads.set(note.id, h);
        }
        return new Query([...heads.values()]);
      }
      if (name === 'graph_put') {
        const note = noteOf(args.note_id);
        if (!note || note.user_id !== user || !live(note)) return refused('That note is not yours');
        if (args.edges.length && !note.kb_id) return refused('new row violates row-level security policy for table "links"');
        if (args.edges.some((e) => !publishable(e))) return refused('violates check constraint "links_model_reviewed"');
        links = links.filter((l) => !(l.from_note === note.id && l.user_id === user));
        for (const e of args.edges) links.push({ ...e, user_id: user, workspace_id: WS, from_note: note.id, graph_hash: args.graph_hash, deleted_at: null });
        return { then: (ok) => Promise.resolve({ data: args.edges.length, error: null }).then(ok) };
      }
      throw new Error(`no rpc ${name}`);
    },
  });
  return server;
}

// ---- one person's Mac: a vault, its index and graph wired as main.js wires them, and the graph sync
async function mac(server, user, files, { sync = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), `gsync-${user}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'v');
  mkdirSync(vault, { recursive: true });
  const put = (rel, t) => { const a = path.join(vault, rel); mkdirSync(path.dirname(a), { recursive: true }); writeFileSync(a, t); };
  for (const [rel, t] of Object.entries(files)) put(rel, t);
  const isExcludedPath = (rel) => rel.startsWith('private/');
  const isExcludedText = (t) => OPT_OUT.test(t) || CONFIDENTIAL.test(t);
  let g = null;
  const ix = createVaultIndex({ vault, isExcludedPath: (r) => isExcludedPath(r) || OPT_OUT.test(r), isExcludedText: (t) => OPT_OUT.test(t), redact: (t) => t, onChange: () => {}, onIndexed: (r) => g?.update(r) });
  ix.sync();
  g = createMemoryGraph({ dataDir: path.join(root, 'd'), vault, vindex: ix, isExcluded: (t) => OPT_OUT.test(t) });
  cleanup.push(() => g.close());
  await g.build();
  const state = { sync, signedIn: true, workspace: { id: WS }, userId: user };
  const account = { state: () => state, client: () => server.client(user) };
  const logs = [];
  const gs = createGraphSync({ account, graph: () => g, vault: () => vault, isExcluded: isExcludedPath, isExcludedText, log: (...a) => logs.push(a.join(' ')), minGap: 0 });
  const edit = (rel, t) => { put(rel, t); ix.syncPaths([rel]); };
  // a note sync pushed into a knowledge base
  const share = (rel, kb = KB) => server.note(user, rel, (files[rel] = readText(vault, rel)), kb);
  return { user, vault, g, ix, gs, state, logs, edit, share, team: () => g.store.db().prepare("select * from edges where source_rel like 'team:%' order by id").all() };
}
const readText = (vault, rel) => readFileSync(path.join(vault, rel), 'utf8');

const HERON = '# Heron\n';
const KICKOFF = (extra = '') => `---\nvisibility: public\ndate: 2026-01-05\nproject: "[[Heron]]"\nattendees:\n  - "[[Ada Lovelace]]"\n---\n# Kickoff\n\nDecision: Database: Postgres\nSee [[Secret]] and [[Plan]].\n${extra}`;
const REVIEW = (extra = '') => `---\nvisibility: public\ndate: 2026-03-05\nproject: "[[Heron]]"\nattendees:\n  - "[[Ada Lovelace]]"\n---\n# Review\n\nDecision: Database: SQLite\n${extra}`;
const ALICE = { 'projects/Heron.md': HERON, 'meetings/2026-01-05 Kickoff.md': KICKOFF(), 'meetings/2026-03-05 Review.md': REVIEW(), 'private/Secret.md': '# Secret\n\nThe raise for [[Ada Lovelace]].\n', 'leads/Plan.md': '---\nvisibility: public\n---\n# Plan\n\nHire [[Grace Hopper]].\n' };
const KICK = 'meetings/2026-01-05 Kickoff.md';
const REV = 'meetings/2026-03-05 Review.md';

async function team() {
  const server = fakeServer();
  const alice = await mac(server, 'alice', ALICE);
  const bob = await mac(server, 'bob', { 'people/Ada Lovelace.md': '---\ntype: person\n---\n# Ada Lovelace\n' });
  const kick = alice.share(KICK), rev = alice.share(REV), plan = alice.share('leads/Plan.md', LEAD);
  return { server, alice, bob, kick, rev, plan };
}
const decisionsOf = (m) => m.g.decisions({ about: 'Heron', current: false, budget: 99999 }).decisions;

describe('Cloud graph sync', () => {
  it('publishes the edges of knowledge base notes with their provenance, and nothing from private notes', async () => {
    const { server, alice } = await team();
    const r = await alice.gs.run();
    expect(r.error).toBeNull();
    expect(r.published).toBe(3);
    const rows = server.links;
    expect(rows.some((l) => l.kind === 'decision_about' && l.provenance && Number.isInteger(l.source_line))).toBe(true);
    expect(rows.some((l) => l.kind === 'attended' && l.src === 'person:ada-lovelace')).toBe(true);
    // the private note never shows up, as a source or as an end
    expect(JSON.stringify(rows)).not.toMatch(/private\/|Secret|raise/);
    // a link to a note in another knowledge base (Plan, in Leadership) stays here: the Handbook's readers cannot open it
    expect(rows.filter((l) => l.from_note !== server.notes.find((x) => x.path === 'leads/Plan.md').id).some((l) => /leads\/Plan/.test(l.dst))).toBe(false);
    // cross-note supersession travels by key
    const old = rows.find((l) => l.kind === 'decision_about' && l.superseded_by_key);
    expect(old).toBeTruthy();
    expect(rows.some((l) => l.edge_key === old.superseded_by_key)).toBe(true);
    expect(old.valid_to).toBeTruthy();
  });

  it('reads a teammate\'s edges into the local graph, marked as the team\'s, so entity and decisions see them', async () => {
    const { alice, bob, kick } = await team();
    await alice.gs.run();
    const r = await bob.gs.run();
    expect(r.error).toBeNull();
    // Kickoff and Review; Plan is in a knowledge base Bob cannot read
    expect(r.imported).toBe(2);
    const edges = bob.team();
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.source_rel.startsWith('team:meetings/'))).toBe(true);
    const marked = JSON.parse(edges[0].props).team;
    expect(marked).toMatchObject({ kb: KB, author: 'alice' });
    expect(edges.some((e) => JSON.parse(e.props).team.note === kick.id)).toBe(true);
    // the same person node as Bob's own note
    const attended = edges.filter((e) => e.kind === 'attended');
    expect(attended.map((e) => e.src)).toContain('person:ada-lovelace');
    expect(bob.g.store.node('person:ada-lovelace').rel).toBe('people/Ada Lovelace.md');
    expect(attended.map((e) => e.dst)).toContain(teamId(`meeting:${KICK}`));
    expect(bob.g.store.node(teamId(`meeting:${KICK}`)).rel).toBe(`team:${KICK}`);
    // decisions: both, the older one superseded by the newer one, as on Alice's Mac
    const d = decisionsOf(bob);
    expect(d).toHaveLength(2);
    expect(d.find((x) => /Postgres/.test(x.text)).supersededBy.text).toMatch(/SQLite/);
    expect(bob.g.decisions({ about: 'Heron', budget: 99999 }).decisions.map((x) => x.text).join()).not.toMatch(/Postgres/);
    const ada = bob.g.entity('Ada Lovelace', { budget: 99999 });
    expect(JSON.stringify(ada)).toMatch(/Kickoff/);
    // nothing from Leadership, nothing private
    expect(JSON.stringify(edges)).not.toMatch(/Grace|Plan|Secret/);
  });

  it('is incremental: an unchanged set is neither sent nor read again; an edit sends and reads one note', async () => {
    const { server, alice, bob } = await team();
    await alice.gs.run();
    await bob.gs.run();
    const puts = () => server.calls.filter((c) => c.rpc === 'graph_put').length;
    const reads = () => server.calls.filter((c) => c.table === 'links').length;
    const [p0, r0] = [puts(), reads()];
    expect((await alice.gs.run()).published).toBe(0);
    expect((await bob.gs.run()).imported).toBe(0);
    expect([puts(), reads()]).toEqual([p0, r0]);
    // an edit the graph read but sync has not pushed yet waits, and so does the note whose decision it supersedes
    alice.edit(REV, REVIEW('Decision: Hosting: Fly\n'));
    const waiting = await alice.gs.run();
    expect(waiting.published).toBe(0);
    expect(waiting.waiting).toBe(2);
    expect(puts()).toBe(p0);
    alice.share(REV);
    expect((await alice.gs.run()).published).toBe(1);
    const r = await bob.gs.run();
    expect(r.imported).toBe(1);
    expect(decisionsOf(bob).map((x) => x.text).join()).toMatch(/Fly/);
  });

  it('removes a note\'s edges when it leaves the knowledge base, and the fact it superseded holds again', async () => {
    const { server, alice, bob, rev } = await team();
    await alice.gs.run();
    await bob.gs.run();
    server.leaveKb(rev);
    const r = await bob.gs.run();
    expect(r.removed).toBe(1);
    expect(bob.team().some((e) => e.source_rel === `team:${REV}`)).toBe(false);
    expect(bob.g.store.node(teamId(`meeting:${REV}`))).toBeNull();
    const d = decisionsOf(bob);
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/Postgres/);
    expect(d[0].supersededBy ?? null).toBeNull();
    // a deleted note goes the same way
    server.leaveKb(server.notes.find((x) => x.path === KICK), { deleted_at: '2026-11-20T00:00:00Z' });
    expect((await bob.gs.run()).removed).toBe(1);
    expect(bob.team()).toHaveLength(0);
    expect(bob.g.store.node('person:ada-lovelace')).toBeTruthy();
  });

  it('withdraws a note that becomes confidential, and never publishes a model edge no one reviewed', async () => {
    const { server, alice } = await team();
    const kickRow = server.notes.find((x) => x.path === KICK);
    const store = alice.g.store;
    // the model pass's edges (wave 2): one unsure, one a person approved
    store.addEdge({ src: `meeting:${KICK}`, dst: 'project:heron', kind: 'about', provenance: 'model', source_rel: KICK, confidence: MODEL_PUBLISH_MIN / 2 });
    store.addEdge({ src: `meeting:${KICK}`, dst: 'person:ada-lovelace', kind: 'works_on', provenance: 'model', source_rel: KICK, confidence: 0.3, props: { approved: true } });
    await alice.gs.run();
    const model = server.links.filter((l) => l.provenance === 'model');
    expect(model).toHaveLength(1);
    expect(model[0].props).toEqual({ approved: true });
    // marked confidential on this Mac: sync stops pushing it, and its edges come back off the server
    alice.edit(KICK, KICKOFF().replace('visibility: public', 'visibility: public\nconfidential: personal'));
    const r = await alice.gs.run();
    expect(r.withdrawn).toBe(1);
    expect(server.links.some((l) => l.from_note === kickRow.id)).toBe(false);
  });

  it('keeps what it has when the server is unreachable and catches up on the next run', async () => {
    const { server, alice, bob } = await team();
    server.offline = true;
    const r = await alice.gs.run();
    expect(r.error).toMatch(/offline/);
    expect(server.links).toHaveLength(0);
    server.offline = false;
    expect((await alice.gs.run()).published).toBe(3);
    await bob.gs.run();
    const before = bob.team().length;
    server.offline = true;
    expect((await bob.gs.run()).error).toMatch(/offline/);
    expect(bob.team()).toHaveLength(before);
    server.offline = false;
    expect((await bob.gs.run()).error).toBeNull();
    expect(bob.team()).toHaveLength(before);
  });

  it('keeps the team\'s edges through local edits, and clears them on sign-out or another workspace', async () => {
    const { alice, bob } = await team();
    await alice.gs.run();
    await bob.gs.run();
    const n = bob.team().length;
    bob.edit('people/Ada Lovelace.md', '---\ntype: person\n---\n# Ada Lovelace\n\nWorks on [[Heron]].\n');
    expect(bob.team()).toHaveLength(n);
    bob.state.workspace = { id: '01GR00000000000000000000WB' };
    const r = await bob.gs.run();
    expect(r.removed).toBe(2);
    expect(bob.team()).toHaveLength(0);
    bob.state.workspace = { id: WS };
    await bob.gs.run();
    expect(bob.team()).toHaveLength(n);
    expect(bob.gs.clear()).toBe(2);
    expect(bob.team()).toHaveLength(0);
    expect(bob.g.store.node(teamId(`meeting:${KICK}`))).toBeNull();
  });

  it('does nothing with sync off, signed out or no graph', async () => {
    const server = fakeServer();
    const alice = await mac(server, 'alice', ALICE, { sync: false });
    alice.share(KICK);
    expect(await alice.gs.run()).toEqual({ skipped: true });
    alice.state.sync = true;
    alice.state.signedIn = false;
    expect(await alice.gs.run()).toEqual({ skipped: true });
    expect(server.calls).toHaveLength(0);
    const none = createGraphSync({ account: { state: () => ({ sync: true, signedIn: true, workspace: { id: WS }, userId: 'x' }), client: () => server.client('x') }, graph: () => null });
    expect(await none.run()).toEqual({ skipped: true });
    expect(none.clear()).toBe(0);
  });

  it('turns a burst of calls into one trailing run', async () => {
    const server = fakeServer();
    const alice = await mac(server, 'alice', ALICE);
    let t = 1_000_000;
    const gs = createGraphSync({ account: { state: () => alice.state, client: () => server.client('alice') }, graph: () => alice.g, vault: () => alice.vault, minGap: 15000, now: () => t });
    await gs.run();
    const heads = () => server.calls.filter((c) => c.rpc === 'graph_heads').length;
    expect(heads()).toBe(1);
    expect(await gs.run()).toEqual({ deferred: true });
    expect(await gs.run()).toEqual({ deferred: true });
    expect(heads()).toBe(1);
    gs.stop();
    t += 15000;
    await gs.run();
    expect(heads()).toBe(2);
  });

  it('accepts only vault-relative markdown paths', () => {
    expect(safePath('a/b.md')).toBe('a/b.md');
    for (const p of ['../x.md', '/abs.md', 'a//b.md', 'a/./b.md', 'x.txt', null]) expect(safePath(p)).toBeNull();
    expect(teamId('note:projects/Heron.md')).toBe('note:team:projects/Heron.md');
    expect(publishable({ provenance: 'model', confidence: 0.79 })).toBe(false);
    expect(publishable({ provenance: 'model', confidence: 0.8 })).toBe(true);
    expect(publishable({ provenance: 'rule', confidence: 0.1 })).toBe(true);
  });
});
