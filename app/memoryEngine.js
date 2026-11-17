// The memory agent's heavy work, kept off the Electron main process: the review rules of every sweep (rules/index.js),
// the confidential tag scan, the contradiction pipeline over the whole vault (rules/contradictions.js) and the
// contradiction agent's queues and stored answers (contradictionAgent.js). memoryWorker.js runs it in a utility process;
// main talks to it through memoryHost.js. Plain Node, no Electron, so the tests run it in-process or in a worker thread.
//
// The engine holds its own copy of the vault index's notes. Main sends the notes that changed (sync), with the read gate's
// answer for every note, and the settings each call needs (cond). Model calls go back to main (ask('model')), so the
// abort slots, the Claude Code process list and the daily cap stay where they were.
//
// A note longer than MAX_RULE_TEXT reaches the rules as its first MAX_RULE_TEXT characters, with its full length in
// chars. Every rule keeps a per-note cache of lines, shingles or claims; a 100 MB session log made each cache hold
// hundreds of megabytes, and a sweep held the old copy and the new copy of the note at once.
import path from 'node:path';
import { createResolver } from './linkparse.js';
import { createContradictionAgent } from './contradictionAgent.js';
import { createMemorySweep, rescanTags, scanTags } from './memorySweep.js';
import { analyze as contradictionPass } from './rules/contradictions.js';
import { scanHygiene } from './vaultHygiene.js';
import { MAX_RULE_TEXT, ruleText } from './rules/common.js';
import { MEMORY_MODELS } from './memoryModels.js';
import { DECIDER_ON, createDecider } from './decide/index.js';
import { createPairGate } from './decide/gate.js';

// the text cut the rules read (rules/common.js), exported here for the callers that already import it
export { MAX_RULE_TEXT, ruleText };

export function createMemoryEngine({ dataDir, ask = async () => { throw new Error('No model'); }, emit = () => {}, log = () => {}, now = () => Date.now() }) {
  let vault = null;
  // rel -> { rel, text, note, mtime, size, inbound, outbound, chars }
  let notes = new Map();
  let mayRead = new Map();
  let resolve = () => null;
  let list = [];
  let tagScan = null;
  // the last hygiene scan (vaultHygiene.js), with the vault it read
  let hygiene = null;
  // how many notes main's index held at the last sync. The engine sweeps and prunes only when it holds them all
  let expected = 0;
  // what main says holds now: { enabled, cap, busy, idleMs, drafts, bar, folders, terms, confidentialFolders }
  let cond = { enabled: false, cap: 0, busy: false, idleMs: Infinity, drafts: false, bar: null, folders: {}, terms: [] };
  const sweeps = createMemorySweep({ file: path.join(dataDir, 'memory-findings.json'), now });
  // the local decision layer: notes sure to hold no claim and pairs read as the same fact stay on the Mac (decide/)
  const decider = DECIDER_ON ? createDecider({ dir: path.join(dataDir, 'models'), log }) : null;
  const gate = decider ? createPairGate({ decider, file: path.join(dataDir, 'decider-audit.jsonl'), log }) : null;
  const agent = createContradictionAgent({
    file: path.join(dataDir, 'memory-contradictions.json'),
    decider,
    gate,
    // kind ('claims' or 'judge') picks the model in main; lane names the abort of the caller that asked for the call
    model: (prompt, system, { kind = null, lane = null } = {}) => ask('model', { prompt, system, kind, lane }),
    modelId: MEMORY_MODELS.claims,
    enabled: () => cond.enabled === true,
    cap: () => cond.cap ?? 0,
    busy: () => cond.busy === true,
    idleMs: () => cond.idleMs ?? Infinity,
    // the read gate's answer main gave for the note's text now; a note whose text changed since it was queued waits
    // for the next sweep to queue it again
    readable: (rel, text) => mayRead.get(rel) === true && notes.get(rel)?.text === text,
    now,
    log,
  });

  const aliasesOf = (rel) => { const n = notes.get(rel)?.note; if (!n) return []; return typeof n.props?.name === 'string' && n.props.name ? [...(n.aliases ?? []), n.props.name] : (n.aliases ?? []); };
  const relink = () => { list = [...notes.values()]; resolve = createResolver([...notes.keys()], aliasesOf); };
  const lower = (t) => String(t).toLowerCase();
  // suggest.js isExcluded, on the term list main sends
  const excluded = (rel) => { const terms = cond.terms ?? []; if (!terms.length) return false; const l = lower(rel); return terms.some((t) => l.includes(t)); };
  const complete = () => notes.size >= expected;
  const need = () => { if (!complete()) throw new Error(`The memory engine holds ${notes.size} of ${expected} notes`); };
  // the agent's provider, with its prune of stored claims and verdicts left out while the engine misses notes: a
  // claim costs a model call, so it is never dropped for a note the engine was not sent
  const provider = { ...agent.provider, end: (rels, keys) => (complete() ? agent.provider.end(rels, keys) : log('memory engine', 'prune skipped', notes.size, expected)) };
  const contradictions = () => ({ provider: cond.drafts === true ? provider : null, bar: cond.bar ?? null });
  const agentView = () => ({ status: agent.status(), pendingCalls: agent.pendingCalls(), pendingNotes: agent.pendingNotes() });

  // meta: [[rel, mtime, size, inbound, outbound, mayRead]] for every note the index holds now; full: the notes whose
  // text changed since the last sync, { rel, text, note }. A note missing from meta left the index
  function sync({ vault: v, meta = [], full = [], cond: c = null }) {
    if (c) cond = { ...cond, ...c };
    if (v !== vault) { vault = v; notes = new Map(); tagScan = null; }
    const next = new Map();
    const byRel = new Map(full.map((f) => [f.rel, f]));
    let changed = byRel.size > 0;
    mayRead = new Map();
    for (const [rel, mtime, size, inbound, outbound, ok] of meta) {
      const f = byRel.get(rel);
      const was = notes.get(rel);
      if (!f && !was) continue;
      if (!was) changed = true;
      const text = f ? ruleText(f.text) : was.text;
      const chars = f ? f.chars ?? String(f.text ?? '').length : was.chars;
      next.set(rel, { rel, text, note: f ? f.note : was.note, mtime, size, inbound, outbound, chars });
      mayRead.set(rel, ok === true);
    }
    if (next.size !== notes.size) changed = true;
    notes = next;
    expected = meta.length;
    if (changed) relink();
    return { notes: notes.size };
  }

  // a sweep of the review rules: kind 'first', 'full', 'incremental' or 'save' (only: the notes that changed). Answers
  // the vault's state (findings, times, the last run) and the confidential tag scan
  function sweep({ kind, only = null, cond: c = null }) {
    if (c) cond = { ...cond, ...c };
    if (!vault) return null;
    need();
    const tags = kind === 'save' && only && tagScan?.vault === vault ? rescanTags(vault, tagScan.tags, only, excluded) : scanTags(vault, excluded);
    tagScan = { vault, tags };
    // the hygiene rule's folder walk and git status run once per full sweep; the other sweeps reuse the last scan
    if (kind === 'full' || kind === 'first' || hygiene?.vault !== vault) {
      try { hygiene = { vault, ...scanHygiene({ vault, notes: list, file: path.join(dataDir, 'memory-hygiene.json'), now: now() }) }; } catch (e) { log('memory engine', 'hygiene scan', e?.message); hygiene = null; }
    }
    const ctx = { notes: list, resolve, tags, folders: cond.folders ?? {}, contradictions: contradictions(), hygiene };
    const s = sweeps.run(vault, kind, ctx, { only });
    return { state: s, tags };
  }

  // the contradiction pipeline over the whole vault with the agent's provider, so its queues hold every note still to read
  function refresh({ cond: c = null } = {}) {
    if (c) cond = { ...cond, ...c };
    if (!vault) return agentView();
    need();
    contradictionPass({ notes: list, resolve, contradictions: contradictions() });
    return agentView();
  }

  // what a catch-up would cost now: stage 1's notes to read packed into claim calls, leaving out stored ones
  function estimate({ cond: c = null } = {}) {
    if (c) cond = { ...cond, ...c };
    if (!vault) return { notes: 0, calls: 0, saved: 0, claimed: 0, judged: 0 };
    const a = contradictionPass({ notes: list, resolve });
    return agent.estimate(a.toRead);
  }

  async function tick({ uncapped = false, parallel = 1, lane = null, cond: c = null } = {}) {
    if (c) cond = { ...cond, ...c };
    const res = await agent.tick({ uncapped, parallel, lane, onStart: (w) => emit('agent-start', { ...w, lane }) });
    return res;
  }

  const methods = { sync, sweep, refresh, estimate, tick, agent: () => agentView(), findings: ({ vault: v }) => sweeps.state(v) };
  async function handle(method, payload) {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown memory engine call ${method}`);
    const result = await fn(payload ?? {});
    return { result, agent: agentView() };
  }
  return { handle, ...methods, notes: () => notes };
}
