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
import { MAX_NOTE, checkClaimsBatch, claimPrompt, stillTrue } from './contradictionClaims.js';
import { checkJudge, judgePrompt } from './contradictionResolve.js';

const RETRY_MS = 24 * 3600000;
// one claim call reads several notes, up to about 12k input tokens of note text (4 characters a token)
export const BATCH_CHARS = 44000;
export const BATCH_NOTES = 20;
const size = (text) => Math.min(MAX_NOTE, String(text ?? '').length) + 200;

// the notes of each call, in priority order: notes are added to a call while they fit the budget. entries: [{ rank,
// rel, text }]. Answers the batches as lists of entries; the eval script uses it to count calls
export function packBatches(entries, { chars = BATCH_CHARS, notes = BATCH_NOTES } = {}) {
  const sorted = [...entries].sort((x, y) => x.rank - y.rank || x.rel.localeCompare(y.rel));
  const out = [];
  let cur = [];
  let used = 0;
  for (const e of sorted) {
    const n = size(e.text);
    if (cur.length && (used + n > chars || cur.length >= notes)) { out.push(cur); cur = []; used = 0; }
    cur.push(e);
    used += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
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
    // worth: the rule's word that the note should be read even when stage 1 alone would skip it (it links to a note
    // that is read)
    claimsOf(n, { worth = null } = {}) {
      const h = hashText(n.text);
      const got = load().claims[n.rel];
      if (got?.hash === h) return stillTrue(got.claims, n.text);
      const ix = indexNote(n);
      if ((worth ?? ix.worth) && ix.readable && !tried(n.rel, h)) wantClaims.set(n.rel, { rel: n.rel, text: n.text, n: { rel: n.rel, text: n.text, note: n.note }, h, rank: ix.priority + (ix.worth ? 0 : 20) });
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
  // one model call for these ids ([[id, hash]]); a failure marks every id, so none is asked again for a day
  async function call(ids, ask, onReply) {
    const s = load();
    s.count++;
    save();
    const fail = (why) => { for (const [id, h] of ids) s.failed[id] = { hash: h, at: now(), why }; };
    try {
      const reply = await model(ask.prompt, ask.system);
      const res = onReply(reply);
      if (res.ok) for (const [id] of ids) delete s.failed[id]; else fail(res.why);
      save();
      return res;
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 200);
      fail(why);
      save();
      return { ok: false, why };
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
      running = call([[key, j.h]], judgePrompt(j.p, j.notes), (reply) => {
        const r = checkJudge(j.p, j.notes, reply);
        if (!r.label) return { ok: false, why: r.why };
        s.judged[key] = { hash: j.h, at: now(), label: r.label, quotes: r.quotes, reason: r.reason };
        return { ok: true };
      }).then((res) => { log('contradiction judge', key, res.ok ? s.judged[key].label : res.why); return res.ok ? { judged: key, rels: j.notes.map((x) => x.rel), label: s.judged[key].label } : { dropped: key, why: res.why }; }).finally(() => { running = null; });
      return running;
    }
    // a note the read gate keeps out is never sent and leaves the queue
    for (const [rel, w] of wantClaims) if (!readable(rel, w.text)) wantClaims.delete(rel);
    const [batch] = packBatches([...wantClaims.values()]);
    if (!batch) return { skipped: 'nothing' };
    for (const w of batch) wantClaims.delete(w.rel);
    const rels = batch.map((w) => w.rel);
    let kept = 0;
    running = call(batch.map((w) => [w.rel, w.h]), claimPrompt(batch.map((w) => w.n)), (reply) => {
      const r = checkClaimsBatch(batch.map((w) => w.n), reply, modelId);
      if (r.why) return { ok: false, why: r.why };
      for (const w of batch) {
        const got = r.byRel.get(w.rel);
        s.claims[w.rel] = { hash: w.h, at: now(), claims: got.claims, dropped: got.dropped };
        kept += got.claims.length;
      }
      return { ok: true };
    }).then((res) => { log('contradiction claims', `${rels.length} notes`, res.ok ? `${kept} claims` : res.why); return res.ok ? { extracted: rels, rels, claims: kept } : { dropped: rels, why: res.why }; }).finally(() => { running = null; });
    return running;
  }
  const status = () => ({ used: used(), cap: cap(), waiting: waiting(), running: !!running, ...provider.pending() });
  return { provider, tick, status, waiting };
}
