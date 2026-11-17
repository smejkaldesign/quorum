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
import { AUTHORITY, hashText, indexNote } from './contradictionIndex.js';
import { checkClaimsBatch, claimPrompt, excerptOf, stillTrue } from './contradictionClaims.js';
import { JUDGE_BATCH, JUDGE_CHARS, checkJudgeBatch, judgeBatchPrompt, judgePrompt } from './contradictionResolve.js';

const RETRY_MS = 24 * 3600000;
// one claim call reads several notes (contradictionClaims.js excerptOf: whole notes up to 12,000 characters), up to
// about 11k input tokens (4 characters a token) and 20 notes. The answer limits the batch more than the input: output
// is what makes a call slow, so the claims come one compact line each, at most 8 per note
export const BATCH_CHARS = 44000;
export const BATCH_NOTES = 20;
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

// how much a pair is worth judging first, lower first: a decision record on either side, two claims with different
// dates, and a decided claim. A pass that is cancelled has then judged the pairs most likely to matter
export function judgeRank(p) {
  const decision = p.a.authority === AUTHORITY.decision || p.b.authority === AUTHORITY.decision ? 0 : 4;
  const dated = p.a.date && p.b.date && p.a.date !== p.b.date ? 0 : 2;
  const decided = p.a.modality === 'decided' || p.b.modality === 'decided' ? 0 : 1;
  return decision + dated + decided;
}
// the pairs of each judge call, strongest first: up to JUDGE_BATCH pairs while the prompt stays under JUDGE_CHARS.
// entries: [{ p, notes }]
const notePair = (p) => [p.a.rel, p.b.rel].sort().join('\n');
export function judgeBatches(entries, { chars = JUDGE_CHARS, pairs = JUDGE_BATCH } = {}) {
  const sorted = [...entries].sort((x, y) => judgeRank(x.p) - judgeRank(y.p) || String(x.p.key).localeCompare(String(y.p.key)));
  const later = [];
  const out = [];
  let cur = [];
  let used = 0;
  for (const e of sorted) {
    const n = judgePrompt(e.p, e.notes).prompt.length + 40;
    // two pairs on the same two notes never share a call, so their verdicts cannot be swapped
    if (cur.some((x) => notePair(x.p) === notePair(e.p))) { later.push(e); continue; }
    if (cur.length && (used + n > chars || cur.length >= pairs)) { out.push(cur); cur = []; used = 0; }
    cur.push(e);
    used += n;
  }
  if (cur.length) out.push(cur);
  // the pairs held back for sharing notes with a pair of their call go in the calls after
  return later.length ? [...out, ...judgeBatches(later, { chars, pairs })] : out;
}

// decider and gate: the local decision layer (decide/index.js createDecider, decide/gate.js createPairGate). The decider
// keeps notes it is sure hold no claim out of the claim calls; the gate keeps pairs it reads as the same fact out of the
// judge calls, apart from an audit sample. Without them every note and pair goes to the model as before
export function createContradictionAgent({ file, model, modelId = 'claude', enabled = () => false, cap = () => 40, busy = () => false, idleMs = () => Infinity, readable = () => true, decider = null, gate = null, now = () => Date.now(), log = () => {} }) {
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
  // pairs whose batched call failed or left them out: the next calls send each of them alone
  const single = new Set();
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
      if (decider && !decider.worthReading(n).read) return [];
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
      // failed: the ids of a batch the reply could not settle ([[id, why]]); only those wait a day. soft: a failed call
      // whose ids are asked for again one a call, so none of them is marked yet
      if (res.ok) { for (const [id] of ids) delete s.failed[id]; const h = new Map(ids); for (const [id, why] of res.failed ?? []) s.failed[id] = { hash: h.get(id), at: now(), why }; } else if (!res.soft) fail(res.why);
      save();
      return res;
    } catch (e) {
      if (e?.cancelled) { if (charge && s.day === day && s.count > 0) s.count--; save(); return { ok: false, cancelled: true, why: 'Cancelled' }; }
      const why = String(e?.message ?? e).slice(0, 200);
      if (opts?.soft) { save(); return { ok: false, soft: true, why }; }
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
    // a pair the read gate keeps out is never sent and leaves the queue
    for (const [key, j] of wantJudge) if (!j.notes.every((x) => readable(x.rel, x.text))) wantJudge.delete(key);
    // the pairs of this call, strongest first, after the gate: it holds a slot under the parallel limit while it runs
    let pairs = null;
    if (wantJudge.size) {
      const slot = Promise.resolve();
      running.add(slot);
      try { pairs = await gatedBatch(s); } finally { running.delete(slot); }
    }
    if (pairs?.length) {
      const items = pairs.map((j, i) => ({ id: `p${i + 1}`, key: j.p.key, p: j.p, notes: j.notes, h: j.h }));
      const keys = items.map((x) => x.key);
      const done = [];
      const failed = [];
      const missing = [];
      // a call of several pairs that fails is not held against its pairs: each is asked for again in a call of its own
      const soft = items.length > 1;
      onStart({ kind: 'judge', notes: items.length });
      const p = call(items.map((x) => [x.key, x.h]), judgeBatchPrompt(items), (reply) => {
        const r = checkJudgeBatch(items, reply);
        if (r.why) return { ok: false, why: r.why, soft };
        for (const x of items) {
          const v = r.byId.get(x.id);
          // a pair the reply left out is asked for again, alone; a verdict that fails its check waits a day
          if (v.missing && soft) { missing.push(x); continue; }
          if (!v.label) { failed.push([x.key, v.why]); continue; }
          s.judged[x.key] = { hash: x.h, at: now(), label: v.label, quotes: v.quotes, reason: v.reason };
          // an audited pair the gate would have dropped: its verdict goes to the gate's log
          gate?.record(x.key, v.label);
          done.push(x);
        }
        // a reply that settles none of its pairs is a failed call
        if (!done.length && !missing.length) return { ok: false, why: failed[0]?.[1] ?? 'The judge settled no pair', soft };
        return { ok: true, failed };
      }, !uncapped, { kind: 'judge', lane, soft }).then((res) => {
        log('contradiction judge', `${keys.length} pairs`, res.ok ? `${done.length} judged, ${failed.length} dropped, ${missing.length} asked again` : res.why);
        if (res.cancelled) return { cancelled: keys };
        if (!res.ok && res.soft) { alone(items); return { judgeRetry: keys, why: res.why }; }
        if (!res.ok) { for (const k of keys) single.delete(k); return { judgeDropped: keys, why: res.why }; }
        alone(missing);
        for (const x of items) if (!missing.includes(x)) single.delete(x.key);
        return { judged: done.map((x) => x.key), labels: done.map((x) => s.judged[x.key].label), rels: [...new Set(done.flatMap((x) => x.notes.map((n) => n.rel)))], judgeDropped: failed.map(([k]) => k), ...(missing.length ? { judgeRequeued: missing.map((x) => x.key) } : {}) };
      }).finally(() => { running.delete(p); });
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
    const judge = judgeBatches([...wantJudge.values()].filter((j) => j.notes.every((x) => readable(x.rel, x.text)))).length;
    return judge + packBatches([...wantClaims.values()].filter((w) => readable(w.rel, w.text))).length;
  }
  // the claim calls a first full pass makes over these notes ([{ rel, text, rank }], stage 1's notes to read), leaving
  // out the notes whose claims are stored for their text now, the ones that failed in the last day and the ones the read
  // gate keeps out
  function estimate(entries) {
    const s = load();
    let saved = 0;
    const left = (entries ?? []).filter((e) => { const h = hashText(e.text); if (s.claims[e.rel]?.hash === h) { saved++; return false; } return !tried(e.rel, h) && readable(e.rel, e.text) && !(decider && !decider.worthReading(e).read); })
      .map((e) => ({ ...e, chars: excerptOf(e).length })).filter((e) => e.chars);
    const batches = packBatches(left);
    // the characters the claim calls send: each call's prompt (its notes' excerpts) and the system prompt, for the cost
    const promptChars = batches.reduce((n, b) => { const ask = claimPrompt(b); return n + ask.prompt.length + ask.system.length; }, 0);
    // saved: the notes read in an earlier pass; claimed and judged: every note and pair stored, for the pairs per note
    // gated: the stored verdicts the local gate gave (judged 'same' by its tier), for the share of pairs it keeps from the judge
    const verdicts = Object.values(s.judged);
    return { notes: left.length, calls: batches.length, promptChars, saved, claimed: Object.keys(s.claims).length, judged: verdicts.length, gated: verdicts.filter((v) => v.by).length };
  }
  // the notes the latest sweep queued to read that the read gate lets through, for the note count of a catch-up pass
  const pendingNotes = () => [...wantClaims.values()].filter((w) => readable(w.rel, w.text)).length;
  // the pairs of one judge call, taken from the queue strongest first (judgeRank) while they fit JUDGE_BATCH and
  // JUDGE_CHARS. Each pair asks the gate first; a pair it drops is stored as judged 'same' by its tier and sent to no
  // one, and a pair it sends on (an audit among them) joins the call. A pair is in the in-flight set while the gate reads
  // it, so a sweep meanwhile does not queue it again
  // pairs to ask for again, each in a call of its own: back in the queue, marked so the next batch holds them alone
  function alone(items) {
    for (const x of items) { single.add(x.key); if (!wantJudge.has(x.key)) wantJudge.set(x.key, { p: x.p, notes: x.notes, h: x.h }); }
  }
  async function gatedBatch(s) {
    const out = [];
    let used = 0;
    let dropped = 0;
    for (const j of [...wantJudge.values()].sort((x, y) => judgeRank(x.p) - judgeRank(y.p) || String(x.p.key).localeCompare(String(y.p.key)))) {
      if (out.length >= JUDGE_BATCH) break;
      const size = judgePrompt(j.p, j.notes).prompt.length + 40;
      if (out.length && used + size > JUDGE_CHARS) break;
      if (!wantJudge.has(j.p.key)) continue;
      // a pair on the same two notes as a pair of this call waits for the next call, and a pair asked for again goes alone
      if (out.some((x) => notePair(x.p) === notePair(j.p))) continue;
      if (out.length && (single.has(j.p.key) || single.has(out[0].p.key))) continue;
      wantJudge.delete(j.p.key);
      if (gate) {
        inflight.add(j.p.key);
        let g;
        try { g = await gate.check(j.p); } finally { inflight.delete(j.p.key); }
        if (!g.send) { s.judged[j.p.key] = { hash: j.h, at: now(), label: 'same', by: g.tier }; dropped++; continue; }
      }
      out.push(j);
      used += size;
      if (single.has(j.p.key)) break;
    }
    if (dropped) { save(); log('contradiction gate', `${dropped} pairs kept from the judge`); }
    return out;
  }
  const status = () => ({ used: used(), cap: cap(), waiting: waiting(), running: running.size > 0, calls: running.size, inflight: inflight.size, ...provider.pending(), ...(decider ? { tiers: decider.tiers?.() ?? null } : {}), ...(gate ? { audit: gate.stats?.() ?? null } : {}) });
  return { provider, tick, status, waiting, pendingCalls, pendingNotes, estimate };
}
