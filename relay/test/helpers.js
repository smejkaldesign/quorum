import { EventEmitter } from 'node:events';

// a supabase-js shaped client over plain arrays: from(table) with eq/is/gte/select/maybeSingle/insert, rpc(name)
export function fakeDb({ tables = {}, rpcs = {}, failInsert = () => null } = {}) {
  const inserted = [];
  // timestamps compare as instants, the way Postgres does, whatever their text form
  const asTime = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };
  const ops = { eq: (r, k, v) => r[k] === v, is: (r, k, v) => (v === null ? r[k] == null : r[k] === v), gte: (r, k, v) => (asTime(r[k]) != null && asTime(v) != null ? asTime(r[k]) >= asTime(v) : r[k] >= v) };
  const from = (table) => {
    const filters = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b = {
      select() { return b; },
      order() { return b; },
      eq(k, v) { filters.push((r) => ops.eq(r, k, v)); return b; },
      is(k, v) { filters.push((r) => ops.is(r, k, v)); return b; },
      gte(k, v) { filters.push((r) => ops.gte(r, k, v)); return b; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: async (row) => { const error = failInsert(row, inserted); if (error) return { error }; inserted.push(row); return { data: null, error: null }; },
      then: (res, rej) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    };
    return b;
  };
  return { from, rpc: async (name, args) => (rpcs[name] ? rpcs[name](args) : { data: null, error: new Error(`no rpc ${name}`) }), inserted };
}

export const fakeAnon = (users = {}) => ({ auth: { getUser: async (token) => (users[token] ? { data: { user: users[token] }, error: null } : { data: { user: null }, error: new Error('invalid JWT') }) } });

// the server side of a ws connection: what the relay calls on it, and what a test can push into it
export class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closedWith = null; }
  send(data) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); }
  close(code, reason) { if (this.closedWith) return; this.closedWith = { code, reason }; this.readyState = 3; setImmediate(() => this.emit('close', code)); }
  terminate() { this.close(1006, 'terminate'); }
  text(obj) { this.emit('message', Buffer.from(JSON.stringify(obj)), false); }
  binary(buf) { this.emit('message', buf, true); }
  events(name) { return this.sent.filter((m) => !Buffer.isBuffer(m) && m.event === name); }
}

// an engine whose sessions record what they were fed and can be driven from the test
export function fakeEngine({ fail = false } = {}) {
  const sessions = [];
  return {
    sessions,
    open(opts) {
      const s = { opts, fed: [], closed: false, finished: false, ready: fail ? Promise.reject(new Error('engine down')) : Promise.resolve(), send: (pcm) => s.fed.push(pcm), close: () => { s.closed = true; }, finish: async () => { s.finished = true; }, emit: (evt) => opts.onEvent(evt), fail: (err) => opts.onError(err) };
      s.ready.catch(() => {});
      sessions.push(s);
      return s;
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const pcm = (seconds, sampleRate = 16000) => Buffer.alloc(Math.round(seconds * sampleRate) * 2);
export const frame = (index, buf) => Buffer.concat([Buffer.from([index]), buf]);

export const WS = '01JD0000000000000000000001';
export const CONNECTOR = '01JD0000000000000000000002';
export const USER = '11111111-1111-4111-8111-111111111111';
export const TOKEN = 'good-token';

export function baseTables({ seats = 1, hourPacks = 0, usage = [], voice = {} } = {}) {
  return {
    members: [{ workspace_id: WS, user_id: USER, role: 'member', deleted_at: null }],
    workspaces: [{ id: WS, seats, hour_packs: hourPacks, plan: 'paid', deleted_at: null }],
    workspace_settings: [{ workspace_id: WS, voice }],
    workspace_usage: usage,
  };
}

export const relayConfig = (over = {}) => ({ engine: 'assemblyai', keys: { assemblyai: 'k-a', deepgram: 'k-d', anthropic: 'k-m' }, maxSessionSeconds: 4 * 3600, idleMs: 20000, helloMs: 10000, openaiModel: 'gpt-4o-mini', ...over });
