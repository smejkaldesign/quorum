// Main's side of the memory engine (memoryEngine.js, run by memoryWorker.js in a utility process). It keeps the engine's
// copy of the vault index current, passes on the settings each call needs, answers the engine's model calls, and gives
// main a contradiction agent with the same calls as createContradictionAgent (contradictionAgent.js). Calls that main
// made in place before (status, pendingCalls) answer from the last reply the engine sent, so they stay synchronous.
//
//   port      the engine's message port: an Electron UtilityProcess or a worker thread (postMessage, on('message'))
//   index()   the vault index (vindex.js), or null
//   vault()   the vault path, or null
//   mayRead(rel, text) the read gate: a note the agent may read
//   cond(heavy) the settings the engine needs now: { enabled, cap, busy, idleMs, drafts }, and with heavy (a sweep or a
//             pass over the vault) also { bar, folders, terms }
//   model(prompt, system) the model call the agent asked for; a cancelled call rejects with { cancelled: true }
//   restart() a fresh port after the engine stopped (it crashed or ran out of memory); the next call uses it
import { ruleText } from './memoryEngine.js';

export function createMemoryHost({ port, index = () => null, vault = () => null, mayRead = () => false, cond = () => ({}), model = async () => { throw new Error('No model'); }, restart = null, log = () => {} }) {
  let seq = 0;
  const calls = new Map();
  // the text of each note the engine holds, as last sent, so a sync sends only the notes whose text changed
  let sent = new Map();
  let sentVault = null;
  let agentView = { status: { used: 0, cap: 0, waiting: 'off', running: false, inflight: 0, claims: 0, judge: 0 }, pendingCalls: 0, pendingNotes: 0 };
  let onStart = null;
  let cur = null;

  function attach(p) {
    cur = p;
    sent = new Map();
    sentVault = null;
    p.on('message', (msg) => receive(p, msg));
    p.on?.('exit', (code) => {
      if (cur !== p) return;
      log('memory engine', 'stopped', code);
      for (const [, c] of calls) c.reject(new Error('The memory engine stopped'));
      calls.clear();
      cur = null;
    });
  }
  function receive(p, msg) {
    if (msg?.event === 'agent-start') { onStart?.(msg.payload); return; }
    if (msg?.event === 'log') { log(...(msg.payload ?? [])); return; }
    if (msg?.ask != null) {
      if (msg.method !== 'model') { p.postMessage({ answer: msg.ask, ok: false, error: `Unknown ask ${msg.method}` }); return; }
      Promise.resolve().then(() => model(msg.payload?.prompt, msg.payload?.system)).then(
        (result) => p.postMessage({ answer: msg.ask, ok: true, result }),
        (e) => p.postMessage({ answer: msg.ask, ok: false, error: String(e?.message ?? e), cancelled: !!e?.cancelled }),
      );
      return;
    }
    const c = calls.get(msg?.id);
    if (!c) return;
    calls.delete(msg.id);
    if (msg.agent) agentView = msg.agent;
    if (msg.ok) c.resolve(msg.result); else c.reject(new Error(msg.error));
  }
  // main passes no port: the first call starts the engine through restart()
  if (port) attach(port);

  function call(method, payload = {}) {
    if (!cur && restart) attach(restart());
    if (!cur) return Promise.reject(new Error('The memory engine is not running'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      cur.postMessage({ id, method, payload });
    });
  }

  // the notes as the index holds them now. A note whose text is the same object as last time is sent as its numbers
  // only; the rest go whole, with text past MAX_RULE_TEXT cut off. A fresh engine (after a crash) starts before the
  // diff, so it gets every note. An engine that answers with fewer notes than the index holds is sent every note again
  async function sync(again = true) {
    const ix = index();
    const v = vault();
    if (!ix || !v) return null;
    if (!cur && restart) attach(restart());
    if (sentVault !== v) { sent = new Map(); sentVault = v; }
    const meta = [];
    const full = [];
    const next = new Map();
    for (const n of ix.snapshot()) {
      meta.push([n.rel, n.mtime, n.size, n.inbound, n.outbound, mayRead(n.rel, n.text)]);
      next.set(n.rel, n.text);
      // chars: the note's full length, or its size in bytes for a note the index read only the head of
      if (sent.get(n.rel) !== n.text) full.push({ rel: n.rel, text: ruleText(n.text), note: n.note, chars: n.cut ? n.size : String(n.text ?? '').length });
    }
    sent = next;
    const r = await call('sync', { vault: v, meta, full, cond: cond() });
    if (again && r && r.notes < meta.length) { log('memory engine', 'missing notes', r.notes, meta.length); sent = new Map(); return sync(false); }
    return r;
  }

  const agent = {
    status: () => agentView.status,
    pendingCalls: () => agentView.pendingCalls,
    pendingNotes: () => agentView.pendingNotes,
    async tick({ onStart: start = () => {}, uncapped = false } = {}) {
      await sync();
      onStart = start;
      try { return await call('tick', { uncapped, cond: cond() }); } finally { onStart = null; }
    },
  };

  return {
    agent,
    sync,
    sweep: async (kind, only = null) => { await sync(); return call('sweep', { kind, only, cond: cond(true) }); },
    refresh: async () => { await sync(); return call('refresh', { cond: cond(true) }); },
    estimate: async () => { await sync(); return call('estimate', { cond: cond(true) }); },
    // forgets what was sent, so the next sync sends every note again (a fresh engine, or a read gate that changed)
    resend: () => { sent = new Map(); },
    close: () => { const p = cur; cur = null; p?.kill?.(); p?.terminate?.(); },
  };
}
