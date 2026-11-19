// The process the memory engine (memoryEngine.js) runs in. Main starts it with Electron's utilityProcess.fork, which
// gives it its own V8 heap and its own event loop: a sweep that takes seconds no longer stops the windows, and memory the
// rules use never counts against main's heap. The tests start the same file in a worker thread. The data folder comes
// in as the first argument (utilityProcess) or as workerData (worker thread).
//
// Messages from main: { id, method, payload } -> { id, ok, result, agent } or { id, ok: false, error }.
// Questions to main: { ask, method, payload } -> { answer, ok, result } or { answer, ok: false, error, cancelled }.
// Events to main: { event, payload }.
import { parentPort as threadPort, workerData } from 'node:worker_threads';
import { createMemoryEngine } from './memoryEngine.js';
import path from 'node:path';
import { openStore } from './graph/store.js';

const utility = process.parentPort ?? null;
const port = utility ?? threadPort;
if (!port) throw new Error('memoryWorker.js runs as a utility process or a worker thread');
const send = (msg) => port.postMessage(msg);
const dataDir = workerData?.dataDir ?? process.argv[2];

let asks = 0;
const waiting = new Map();
const ask = (method, payload) => new Promise((resolve, reject) => {
  const id = ++asks;
  waiting.set(id, { resolve, reject });
  send({ ask: id, method, payload });
});
// the memory graph's store, opened read-only per vault (graph/store.js); the engine asks for it only once main says
// the graph is built
const graphs = new Map();
const graph = (vault) => {
  if (!vault) return null;
  if (graphs.get(vault)) return graphs.get(vault);
  let v;
  try { v = openStore({ dir: path.join(dataDir, 'memory'), vault, readOnly: true }); } catch { v = null; }
  if (v) graphs.set(vault, v);
  return v;
};
const engine = createMemoryEngine({ dataDir, ask, emit: (event, payload) => send({ event, payload }), log: (...a) => send({ event: 'log', payload: a.map(String) }), graph });

// one call at a time, in the order main sent them, so a sweep never reads the notes while a sync is half applied. A tick
// waits on the model, so the queue moves on while it waits: the engine's agent refuses a second tick on its own
let chain = Promise.resolve();
port.on('message', (e) => {
  const msg = utility ? e.data : e;
  if (msg?.answer != null) {
    const w = waiting.get(msg.answer);
    if (!w) return;
    waiting.delete(msg.answer);
    if (msg.ok) w.resolve(msg.result); else w.reject(Object.assign(new Error(msg.error ?? 'Failed'), msg.cancelled ? { cancelled: true } : {}));
    return;
  }
  if (msg?.id == null) return;
  const run = () => engine.handle(msg.method, msg.payload).then(
    (r) => send({ id: msg.id, ok: true, result: r.result, agent: r.agent }),
    (err) => send({ id: msg.id, ok: false, error: String(err?.message ?? err) }),
  );
  if (msg.method === 'tick') { run(); return; }
  chain = chain.then(run, run);
});
