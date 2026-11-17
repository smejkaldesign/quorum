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
import { checkClaimsBatch, claimPrompt, excerptOf, stillTrue } from './contradictionClaims.js';
import { checkJudge, judgePrompt } from './contradictionResolve.js';

const RETRY_MS = 24 * 3600000;
// one claim call reads the excerpts of several notes (contradictionClaims.js excerptOf), up to about 8k input tokens
// (4 characters a token). The answer limits the batch more than the input: each note can bring a few claims of about 60
// output tokens each, and output is what makes a call slow
export const BATCH_CHARS = 32000;
export const BATCH_NOTES = 30;
// chars: the excerpt's length, worked out once when the note is queued
const size = (e) => (e.chars ?? excerptOf(e.n ?? e).length) + 200;

// the notes of each call, in priority order: notes are added to a call while they fit the budget. entries: [{ rank,
// rel, text, chars }]. Answers the batches as lists of entries; the eval script uses it to count calls
export function packBatches(entries, { chars = BATCH_CHARS, notes = BATCH_NOTES } = {}) {
  const sorted = [...entries].sort((x, y) => x.rank - y.rank || x.rel.localeCompare(y.rel));
  const out = [];
  let cur = [];
  let used = 0;
  for (const e of sorted) {
    const n = size(e);
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
  // uncapped: a catch-up pass (memoryCatchup.js), which neither reads nor counts against the daily cap and does not wait
  // for the person to stop typing
  const waiting = ({ uncapped = false } = {}) => {
    if (!enabled()) return 'off';
    if (!uncapped && used() >= cap()) return 'cap';
    if (busy()) return 'busy';
    if (!uncapped && idleMs() < QUIET_MS) return 'typing';
    return null;
  };
  // what the latest sweep asked for and has no answer yet
  let wantClaims = new Map();
  let wantJudge = new Map();
  // the note paths and pair keys of the model call that runs. A sweep during the call finds no stored answer for them
  // yet; without this set it would queue them again and the next tick would make the same call a second time
  const inflight = new Set();
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
      if (inflight.has(n.rel)) return [];
      const ix = indexNote(n);
      if (!(worth ?? ix.worth) || !ix.readable || tried(n.rel, h)) return [];
      // a note whose excerpt holds no line to read makes no call: its frontmatter facts are read with no model
      const chars = excerptOf(n).length;
      if (chars) wantClaims.set(n.rel, { rel: n.rel, text: n.text, n: { rel: n.rel, text: n.text, note: n.note }, h, chars, rank: ix.priority + (ix.worth ? 0 : 20) });
      return [];
    },
    judgeOf(p, notes) {
      const h = notes.map((x) => hashText(x.text)).join(':');
      const got = load().judged[p.key];
      if (got?.hash === h) return got.label;
      if (inflight.has(p.key)) return null;
      if (!tried(p.key, h)) wantJudge.set(p.key, { p, notes, h });
      return null;
    },
    // drops stored claims and verdicts for notes and pairs the vault no longer has
    end(rels, keys) {
      const s = load();
      const r = new Set(rels);
      const k = new Set(keys);
      let n = 0;
      // a sweep that names less than half of the notes with stored claims is taken for a vault read only in part (an
      // engine that restarted, a folder that is offline): claims and verdicts each cost a model call, so they stay
      const gone = Object.keys(s.claims).filter((rel) => !r.has(rel));
      const partial = gone.length > 20 && gone.length * 2 > Object.keys(s.claims).length;
      if (!partial) {
        for (const rel of gone) { delete s.claims[rel]; n++; }
        for (const key of Object.keys(s.judged)) if (!k.has(key) && !wantJudge.has(key) && !inflight.has(key)) { delete s.judged[key]; n++; }
      }
      // a failure only blocks a retry for a day, so an older one is kept no longer
      for (const [id, f] of Object.entries(s.failed)) if (!(now() - f.at < RETRY_MS)) { delete s.failed[id]; n++; }
      if (n) save();
    },
    pending: () => ({ claims: wantClaims.size, judge: wantJudge.size }),
  };

  // the calls that run: one at a time on the daily-cap path, up to parallel at once in a catch-up
  const running = new Set();
  // one model call for these ids ([[id, hash]]); a failure marks every id, so none is asked again for a day. A call a
  // person cancelled gives its place under the daily cap back (unless the day turned while it ran) and marks nothing,
  // so its notes are asked for again on the next sweep. charge: false for a catch-up call, which the cap does not count
  // opts: { kind, lane } for the model: kind 'claims' or 'judge' picks the model, lane names the caller's abort
  async function call(ids, ask, onReply, charge = true, opts = {}) {
    for (const [id] of ids) inflight.add(id);
    try { return await send(ids, ask, onReply, charge, opts); } finally { for (const [id] of ids) inflight.delete(id); }
  }
  async function send(ids, ask, onReply, charge, opts) {
    const s = load();
    used();
    const day = s.day;
    if (charge) s.count++;
    save();
    const fail = (why) => { for (const [id, h] of ids) s.failed[id] = { hash: h, at: now(), why }; };
    try {
      const reply = await model(ask.prompt, ask.system, opts);
      const res = onReply(reply);
      if (res.ok) for (const [id] of ids) delete s.failed[id]; else fail(res.why);
      save();
      return res;
    } catch (e) {
      if (e?.cancelled) { if (charge && s.day === day && s.count > 0) s.count--; save(); return { ok: false, cancelled: true, why: 'Cancelled' }; }
      const why = String(e?.message ?? e).slice(0, 200);
      fail(why);
      save();
      return { ok: false, why };
    }
  }
  // one model call: a pair to judge first, then the notes that most need their claims. onStart({ kind, notes }) runs
  // just before the call, kind 'judge' or 'claims', so the caller can show the work and offer Cancel. Answers what it did.
  // parallel: how many calls a catch-up runs at once (uncapped only); lane: passed to the model with the call
  async function tick({ onStart = () => {}, uncapped = false, parallel = 1, lane = null } = {}) {
    if (running.size >= (uncapped ? Math.max(1, parallel) : 1)) return { skipped: 'running' };
    const why = waiting({ uncapped });
    if (why) return { skipped: why };
    const s = load();
    for (const [key, j] of wantJudge) {
      wantJudge.delete(key);
      if (!j.notes.every((x) => readable(x.rel, x.text))) continue;
      onStart({ kind: 'judge', notes: j.notes.length });
      const p = call([[key, j.h]], judgePrompt(j.p, j.notes), (reply) => {
        const r = checkJudge(j.p, j.notes, reply);
        if (!r.label) return { ok: false, why: r.why };
        s.judged[key] = { hash: j.h, at: now(), label: r.label, quotes: r.quotes, reason: r.reason };
        return { ok: true };
      }, !uncapped, { kind: 'judge', lane }).then((res) => { log('contradiction judge', key, res.ok ? s.judged[key].label : res.why); if (res.cancelled) return { cancelled: [key] }; return res.ok ? { judged: key, rels: j.notes.map((x) => x.rel), label: s.judged[key].label } : { dropped: key, why: res.why }; }).finally(() => { running.delete(p); });
      running.add(p);
      return p;
    }
    // a note the read gate keeps out is never sent and leaves the queue
    for (const [rel, w] of wantClaims) if (!readable(rel, w.text)) wantClaims.delete(rel);
    const [batch] = packBatches([...wantClaims.values()]);
    if (!batch) return { skipped: 'nothing' };
    for (const w of batch) wantClaims.delete(w.rel);
    const rels = batch.map((w) => w.rel);
    let kept = 0;
    onStart({ kind: 'claims', notes: rels.length });
    const p = call(batch.map((w) => [w.rel, w.h]), claimPrompt(batch.map((w) => w.n)), (reply) => {
      const r = checkClaimsBatch(batch.map((w) => w.n), reply, modelId);
      if (r.why) return { ok: false, why: r.why };
      for (const w of batch) {
        const got = r.byRel.get(w.rel);
        s.claims[w.rel] = { hash: w.h, at: now(), claims: got.claims, dropped: got.dropped };
        kept += got.claims.length;
      }
      return { ok: true };
    }, !uncapped, { kind: 'claims', lane }).then((res) => { log('contradiction claims', `${rels.length} notes`, res.ok ? `${kept} claims` : res.why); if (res.cancelled) return { cancelled: rels }; return res.ok ? { extracted: rels, rels, claims: kept } : { dropped: rels, why: res.why }; }).finally(() => { running.delete(p); });
    running.add(p);
    return p;
  }
  // the model calls the agent still has to make for what the latest sweep asked: a call per pair to judge and per batch of
  // notes to read
  function pendingCalls() {
    const judge = [...wantJudge.values()].filter((j) => j.notes.every((x) => readable(x.rel, x.text))).length;
    return judge + packBatches([...wantClaims.values()].filter((w) => readable(w.rel, w.text))).length;
  }
  // the claim calls a first full pass makes over these notes ([{ rel, text, rank }], stage 1's notes to read), leaving
  // out the notes whose claims are stored for their text now, the ones that failed in the last day and the ones the read
  // gate keeps out
  function estimate(entries) {
    const s = load();
    let saved = 0;
    const left = (entries ?? []).filter((e) => { const h = hashText(e.text); if (s.claims[e.rel]?.hash === h) { saved++; return false; } return !tried(e.rel, h) && readable(e.rel, e.text); })
      .map((e) => ({ ...e, chars: excerptOf(e).length })).filter((e) => e.chars);
    const batches = packBatches(left);
    // the characters the claim calls send: each call's prompt (its notes' excerpts) and the system prompt, for the cost
    const promptChars = batches.reduce((n, b) => { const ask = claimPrompt(b); return n + ask.prompt.length + ask.system.length; }, 0);
    // saved: the notes read in an earlier pass; claimed and judged: every note and pair stored, for the pairs per note
    return { notes: left.length, calls: batches.length, promptChars, saved, claimed: Object.keys(s.claims).length, judged: Object.keys(s.judged).length };
  }
  // the notes the latest sweep queued to read that the read gate lets through, for the note count of a catch-up pass
  const pendingNotes = () => [...wantClaims.values()].filter((w) => readable(w.rel, w.text)).length;
  const status = () => ({ used: used(), cap: cap(), waiting: waiting(), running: running.size > 0, calls: running.size, inflight: inflight.size, ...provider.pending() });
  return { provider, tick, status, waiting, pendingCalls, pendingNotes, estimate };
}
