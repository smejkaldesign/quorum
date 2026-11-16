// The model side of contradiction detection: claim extraction per note (stage 2) and the judge for pairs the rules
// cannot settle (stage 4). It runs behind Settings > Memory, Let the agent draft fixes, shares that setting's daily cap
// with the drafter (memoryDraft.js), and waits the same way: never while a recording or a fix runs, or while the
// person used the Mac in the last 2 minutes. One model call per tick.
//
// The rule (rules/contradictions.js) asks for what it needs through the provider on each sweep: claimsOf(note) and
// judgeOf(pair) answer what is stored for the note's text now and queue the rest. readable(rel, text) is main's gate:
// a note the read guard blocks or a note marked confidential is never sent. Claims and verdicts are kept in a file in
// Quorum's data folder by note hash. Plain Node, no Electron, so the tests run a fake model.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { QUIET_MS } from './memoryDraft.js';
import { hashText, indexNote } from './contradictionIndex.js';
import { checkClaims, claimPrompt, stillTrue } from './contradictionClaims.js';
import { checkJudge, judgePrompt } from './contradictionResolve.js';

const RETRY_MS = 24 * 3600000;
const today = (t) => new Date(t).toISOString().slice(0, 10);

export function createContradictionAgent({ file, model, modelId = 'claude', enabled = () => false, cap = () => 40, busy = () => false, idleMs = () => Infinity, readable = () => true, now = () => Date.now(), log = () => {} }) {
  let state = null;
  const load = () => {
    if (state) return state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = null; }
    if (!state || typeof state !== 'object') state = {};
    state.claims ??= {}; state.judged ??= {}; state.failed ??= {}; state.day ??= today(now()); state.count ??= 0;
    return state;
  };
  const save = () => { try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(state)); renameSync(`${file}.tmp`, file); } catch {} };
  const used = () => { const s = load(); if (s.day !== today(now())) { s.day = today(now()); s.count = 0; } return s.count; };
  const waiting = () => {
    if (!enabled()) return 'off';
    if (used() >= cap()) return 'cap';
    if (busy()) return 'busy';
    if (idleMs() < QUIET_MS) return 'typing';
    return null;
  };
  // what the latest sweep asked for and has no answer yet
  let wantClaims = new Map();
  let wantJudge = new Map();
  const tried = (id, h) => { const f = load().failed[id]; return f?.hash === h && now() - f.at < RETRY_MS; };

  // the provider the rule reads in one sweep. begin() clears the queues; each answer is for the text given now
  const provider = {
    begin() { wantClaims = new Map(); wantJudge = new Map(); },
    claimsOf(n) {
      const h = hashText(n.text);
      const got = load().claims[n.rel];
      if (got?.hash === h) return stillTrue(got.claims, n.text);
      const ix = indexNote(n);
      if (ix.worth && !tried(n.rel, h)) wantClaims.set(n.rel, { n: { rel: n.rel, text: n.text, note: n.note }, h, rank: ix.priority });
      return [];
    },
    judgeOf(p, notes) {
      const h = notes.map((x) => hashText(x.text)).join(':');
      const got = load().judged[p.key];
      if (got?.hash === h) return got.label;
      if (!tried(p.key, h)) wantJudge.set(p.key, { p, notes, h });
      return null;
    },
    // drops stored claims and verdicts for notes and pairs the vault no longer has
    end(rels, keys) {
      const s = load();
      const r = new Set(rels);
      const k = new Set(keys);
      let n = 0;
      for (const rel of Object.keys(s.claims)) if (!r.has(rel)) { delete s.claims[rel]; n++; }
      for (const key of Object.keys(s.judged)) if (!k.has(key) && !wantJudge.has(key)) { delete s.judged[key]; n++; }
      if (n) save();
    },
    pending: () => ({ claims: wantClaims.size, judge: wantJudge.size }),
  };

  let running = null;
  async function call(id, h, ask, onReply) {
    const s = load();
    s.count++;
    save();
    try {
      const reply = await model(ask.prompt, ask.system);
      const res = onReply(reply);
      if (res.ok) delete s.failed[id]; else s.failed[id] = { hash: h, at: now(), why: res.why };
      save();
      return res;
    } catch (e) {
      s.failed[id] = { hash: h, at: now(), why: String(e?.message ?? e).slice(0, 200) };
      save();
      return { ok: false, why: s.failed[id].why };
    }
  }
  // one model call: a pair to judge first, then the note that most needs its claims. Answers what it did
  async function tick() {
    if (running) return { skipped: 'running' };
    const why = waiting();
    if (why) return { skipped: why };
    const s = load();
    for (const [key, j] of wantJudge) {
      wantJudge.delete(key);
      if (!j.notes.every((x) => readable(x.rel, x.text))) continue;
      running = call(key, j.h, judgePrompt(j.p, j.notes), (reply) => {
        const r = checkJudge(j.p, j.notes, reply);
        if (!r.label) return { ok: false, why: r.why };
        s.judged[key] = { hash: j.h, at: now(), label: r.label, quotes: r.quotes, reason: r.reason };
        return { ok: true };
      }).then((res) => { log('contradiction judge', key, res.ok ? s.judged[key].label : res.why); return res.ok ? { judged: key, rels: j.notes.map((x) => x.rel), label: s.judged[key].label } : { dropped: key, why: res.why }; }).finally(() => { running = null; });
      return running;
    }
    const next = [...wantClaims.values()].sort((x, y) => x.rank - y.rank || x.n.rel.localeCompare(y.n.rel));
    for (const w of next) {
      wantClaims.delete(w.n.rel);
      if (!readable(w.n.rel, w.n.text)) continue;
      let kept = 0;
      running = call(w.n.rel, w.h, claimPrompt(w.n), (reply) => {
        const r = checkClaims(w.n, reply, modelId);
        if (r.why) return { ok: false, why: r.why };
        s.claims[w.n.rel] = { hash: w.h, at: now(), claims: r.claims, dropped: r.dropped };
        kept = r.claims.length;
        return { ok: true };
      }).then((res) => { log('contradiction claims', w.n.rel, res.ok ? `${kept} claims` : res.why); return res.ok ? { extracted: w.n.rel, rels: [w.n.rel], claims: kept } : { dropped: w.n.rel, why: res.why }; }).finally(() => { running = null; });
      return running;
    }
    return { skipped: 'nothing' };
  }
  const status = () => ({ used: used(), cap: cap(), waiting: waiting(), running: !!running, ...provider.pending() });
  return { provider, tick, status, waiting };
}
