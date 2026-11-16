// Agent-drafted fixes (Settings > Memory, Let the agent draft fixes; off by default). For the review items the rules
// cannot decide, the agent reads the evidence notes and drafts the fix, with quoted evidence lines and a confidence:
//   create  a missing note several notes link to: the agent writes the note from what the linking notes say
//   point   a weak relink or alias: the agent says whether the note Quorum picked is the right one
//   merge   two notes that repeat each other: the agent writes one merged note, or rewrites the note that is wrong
//           when the two disagree (a contradiction)
//   retro   a Retroactive improvement: an earlier fix Quorum cannot undo exactly, or one that left a note worse. The
//           agent drafts the improvement from the note and its context: point the links at the right note, remove
//           them, rewrite a note the fix wrote into a real one from its sources, or remove that note
//
// A draft shows only after a second, independent draft agrees with it (confirm): the same kind of fix onto the same
// note, with every quote of both drafts checked against its note.
//
// The model runs through the person's own Claude Code sign-in with no tools at all (models.js claudeText), so the agent
// reads only the note text Quorum puts in the prompt and writes nothing. Quorum checks every quote against the note
// line it names and drops a draft when any quote does not match. A kept draft changes the item's fix; Quorum applies it
// through the same batch planner and journal as any other fix. Plain Node, no Electron, so the tests run it with a fake
// model.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FRONT, frontBlock } from './frontmatter.js';
import { aliasText } from './relink.js';
import { RETRO_ACTIONS, retroOps } from './reviewApprove.js';

export const DAILY_CAP = 40;
export const QUIET_MS = 2 * 60000;
export const CONFIDENCE = ['high', 'medium', 'low'];
// what a link's row says when the agent read its notes and found Quorum's match is wrong. Approve then removes the
// dead link and keeps its words
export const WRONG_NOTE = 'The agent found this is the wrong note';
export const WRONG_NOTE_FIX = 'The agent found the note Quorum picked is the wrong one. Approve removes the dead link and keeps its words.';
const MAX_TEXT = 20000;
const MAX_NOTE = 12000;
const RETRY_MS = 24 * 3600000;
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 24);
const baseOf = (rel) => String(rel).split('/').pop().replace(/\.md$/i, '');

// what the agent can draft for an item, or null when the rules decide it on their own
export function draftKind(item) {
  const o = item?.ops?.[0];
  if (item?.kind === 'link' && o?.op === 'create') return 'create';
  if (item?.kind === 'link' && item.reviewOnly && (o?.op === 'relink' || o?.op === 'alias')) return 'point';
  if (item?.kind === 'finding' && item.ruleId === 'note.near-duplicate') return 'merge';
  if (item?.kind === 'pastfix' && item.retro) return 'retro';
  return null;
}

// the notes the agent reads for an item: the linking notes, and the note Quorum picked or the two notes that repeat
export function evidenceRels(item) {
  const o = item.ops?.[0] ?? {};
  const kind = draftKind(item);
  if (kind === 'create') return [...new Set(o.sources ?? [])];
  if (kind === 'point') return [...new Set([...(o.sources ?? []), o.op === 'alias' ? o.rel : o.to])];
  if (kind === 'merge') return [...(item.notes ?? [])];
  if (kind === 'retro') { const r = item.retro; return [...new Set([...(r.sources ?? []), r.wrong ?? r.made, ...(r.candidates ?? []).slice(0, 3)].filter(Boolean))]; }
  return [];
}

// a hash of the evidence notes as they read now: a stored draft holds while it is the same
export const evidenceHash = (notes) => hash(notes.map((n) => `${n.rel}\n${n.text}`).join('\n\u0000'));

const numbered = (text) => String(text).slice(0, MAX_NOTE).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
const block = (n) => `<note path="${n.rel}">\n${numbered(n.text)}\n</note>`;

export const SYSTEM = [
  'You draft one fix for a notes vault. You read only the notes given below; you have no tools and change nothing.',
  'Every claim you make must rest on a quote. A quote is the exact text of one numbered line, or an exact part of it, with the note path and the line number. Copy quotes character for character; do not fix spelling or spacing.',
  'Answer with one JSON object and nothing else.',
  'confidence is high only when the quotes leave no doubt, medium when they point one way, low otherwise.',
].join('\n');

// the prompt for an item: what to draft, the shape of the answer, and the numbered notes
export function draftPrompt(item, notes) {
  const kind = draftKind(item);
  const o = item.ops?.[0] ?? {};
  const quotes = '"quotes": [{ "path": "<note path>", "line": <line number>, "text": "<exact text from that line>" }]';
  let ask;
  if (kind === 'create') {
    ask = [
      `Several notes link to [[${item.target}]], which does not exist. Write the body of that note from what the linking notes say about it.`,
      'Write only what the notes support. Leave out frontmatter. Keep it short.',
      `Answer: { "kind": "create", "text": "<markdown body>", ${quotes}, "confidence": "high" | "medium" | "low" }`,
    ];
  } else if (kind === 'point') {
    const to = o.op === 'alias' ? o.rel : o.to;
    ask = [
      `Some notes link to [[${item.target}]], which does not exist. Quorum matched the name to the note ${to}. Decide whether the links mean that note.`,
      `Answer: { "kind": "point", "to": "${to}" or null when the links mean something else, ${quotes}, "confidence": "high" | "medium" | "low" }`,
    ];
  } else if (kind === 'merge') {
    const [a, b] = item.notes;
    ask = [
      `The notes ${a} and ${b} repeat each other. Draft one of two fixes.`,
      `When they say the same things, merge them: write one body that keeps every fact from both. Answer: { "kind": "merge", "keep": "${a}" or "${b}", "text": "<merged markdown body, no frontmatter>", ${quotes}, "confidence": "high" | "medium" | "low" }`,
      `When they disagree on a fact, rewrite the note that is out of date. Answer: { "kind": "contradiction", "rel": "<the note to rewrite>", "text": "<its corrected body, no frontmatter>", ${quotes}, "confidence": "high" | "medium" | "low" }`,
      'Quote the lines that show the facts you keep, and for a contradiction the lines that disagree.',
    ];
  } else if (kind === 'retro') {
    const r = item.retro;
    const read = new Set(notes.map((n) => n.rel));
    const to = (r.candidates ?? []).filter((c) => read.has(c));
    const did = r.action === 'create' ? `wrote the note ${r.made} for the missing link [[${r.target}]]` : r.action === 'alias' ? `added [[${r.target}]] as an alias of ${r.wrong}` : `pointed the links to [[${r.target}]] at ${r.wrong}`;
    const options = r.action === 'create'
      ? [
        `When the linking notes say enough about it, rewrite ${r.made} into a real note from them. Answer: { "kind": "retro", "action": "rewrite", "text": "<markdown body, no frontmatter>", ${quotes}, "confidence": "high" | "medium" | "low" }`,
        `When they do not, remove it. Answer: { "kind": "retro", "action": "remove", ${quotes}, "confidence": "high" | "medium" | "low" }`,
      ]
      : [
        ...(to.length ? [`When the links mean one of these notes, point them there: ${to.join(', ')}. Answer: { "kind": "retro", "action": "relink", "to": "<one of those paths>", ${quotes}, "confidence": "high" | "medium" | "low" }`] : []),
        `When no note given here is what they mean, remove the links and keep their words. Answer: { "kind": "retro", "action": "unlink", ${quotes}, "confidence": "high" | "medium" | "low" }`,
      ];
    ask = [
      `An earlier automatic fix ${did}. Quorum now finds that fix wrong: ${(r.reasons ?? []).join(' ') || 'its rules would not make it today.'}`,
      'Draft the improvement.',
      ...options,
      'Quote the lines that show what the links mean.',
    ];
  } else return null;
  return { system: SYSTEM, prompt: `${ask.join('\n')}\n\n${notes.map(block).join('\n\n')}` };
}

// the first JSON object in a reply, or null
export function parseReply(text) {
  const t = String(text ?? '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const j = JSON.parse(t.slice(start, end + 1)); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

// each quote checked against the line it names: the text must sit on that line, character for character
export function verifyQuotes(quotes, notes) {
  const byRel = new Map(notes.map((n) => [n.rel, String(n.text).split('\n')]));
  return (Array.isArray(quotes) ? quotes : []).map((q) => {
    const lines = byRel.get(String(q?.path ?? ''));
    const n = Number(q?.line);
    const text = typeof q?.text === 'string' ? q.text : '';
    const ok = !!lines && Number.isInteger(n) && n >= 1 && n <= lines.length && text.trim().length >= 3 && lines[n - 1].includes(text.trim());
    return { path: String(q?.path ?? ''), line: Number.isInteger(n) ? n : 0, text: text.slice(0, 400), ok };
  });
}

// a reply checked against the item and its notes. Answers { draft } or { why } when Quorum drops it
export function checkDraft(item, notes, reply) {
  const kind = draftKind(item);
  const j = parseReply(reply);
  if (!j) return { why: 'The agent did not answer with a draft' };
  const confidence = CONFIDENCE.includes(j.confidence) ? j.confidence : null;
  if (!confidence) return { why: 'The draft has no confidence' };
  const quotes = verifyQuotes(j.quotes, notes);
  if (!quotes.length) return { why: 'The draft quotes no evidence' };
  if (quotes.some((q) => !q.ok)) return { why: 'A quote in the draft does not match its note' };
  // a body only: a frontmatter block the reply opens with is dropped, so a draft never sets a note's aliases or marks
  let text = typeof j.text === 'string' ? j.text.trim() : '';
  while (FRONT.test(text)) text = text.replace(FRONT, '').trim();
  const rels = notes.map((n) => n.rel);
  const common = { quotes, confidence, verified: true };
  if (kind === 'create') {
    if (j.kind !== 'create' || !text || text.length > MAX_TEXT) return { why: 'The draft has no note text' };
    return { draft: { kind, text, ...common } };
  }
  if (kind === 'point') {
    const o = item.ops[0];
    const to = o.op === 'alias' ? o.rel : o.to;
    if (j.kind !== 'point') return { why: 'The draft answers another question' };
    if (j.to == null) return { draft: { kind, to: null, ...common } };
    if (j.to !== to) return { why: 'The draft points at a note Quorum did not offer' };
    return { draft: { kind, to, ...common } };
  }
  if (kind === 'merge') {
    if (!text || text.length > MAX_TEXT) return { why: 'The draft has no note text' };
    if (j.kind === 'merge' && rels.includes(j.keep)) return { draft: { kind: 'merge', keep: j.keep, drop: rels.find((r) => r !== j.keep), text, ...common } };
    if (j.kind === 'contradiction' && rels.includes(j.rel)) return { draft: { kind: 'contradiction', rel: j.rel, text, ...common } };
    return { why: 'The draft names a note outside the pair' };
  }
  if (kind === 'retro') {
    const r = item.retro;
    const allowed = RETRO_ACTIONS[r.action] ?? [];
    if (j.kind !== 'retro' || !allowed.includes(j.action)) return { why: 'The draft answers another question' };
    if (j.action === 'relink') {
      if (!(r.candidates ?? []).includes(j.to) || !rels.includes(j.to)) return { why: 'The draft points at a note Quorum did not offer' };
      return { draft: { kind, action: 'relink', to: j.to, ...common } };
    }
    if (j.action === 'rewrite') {
      if (!text || text.length > MAX_TEXT) return { why: 'The draft has no note text' };
      return { draft: { kind, action: 'rewrite', text, ...common } };
    }
    return { draft: { kind, action: j.action, ...common } };
  }
  return { why: 'Quorum does not draft this kind of fix' };
}

// the note text a body becomes: the note's own frontmatter, then the drafted body
const withFront = (current, body) => `${frontBlock(current)}${body.endsWith('\n') ? body : `${body}\n`}`;

// the item with its draft applied: the fix it runs, and the draft for the drawer and the plan. textOf(rel) answers a
// note's text now; aliasesOf(rel) a note's aliases, so a merge carries the dropped note's aliases onto the kept note.
// A point draft that says the match is wrong turns the item into removing the dead link, keeping its words
export function withDraft(item, draft, textOf, aliasesOf = () => []) {
  const view = { kind: draft.kind, confidence: draft.confidence, quotes: draft.quotes, verified: draft.verified, at: draft.at ?? null, ...(draft.confirmed !== undefined ? { confirmed: draft.confirmed } : {}) };
  const out = { ...item, draft: view, autoFix: false };
  if (draft.kind === 'create') return { ...out, draft: { ...view, text: draft.text }, ops: item.ops.map((o, i) => (i ? o : { ...o, text: draft.text })) };
  if (draft.kind === 'point') {
    if (draft.to) return out;
    const from = item.ops.find((o) => o.sources) ?? {};
    const unlink = { op: 'unlink', target: item.target, sources: from.sources ?? item.sources ?? [], lines: from.lines ?? {}, ...(from.links ? { links: from.links } : {}) };
    return { ...out, wrongNote: true, group: 'unlink', draft: { ...view, wrong: true }, ops: [unlink] };
  }
  if (draft.kind === 'merge') {
    const keepText = textOf(draft.keep);
    if (keepText == null || textOf(draft.drop) == null) return { ...out, ops: [], hold: 'A note in the draft is gone.' };
    const have = new Set([baseOf(draft.keep), ...aliasesOf(draft.keep)].map((a) => String(a).toLowerCase()));
    const add = [...new Set([baseOf(draft.drop), ...aliasesOf(draft.drop)].map(String))].filter((a) => a && !have.has(a.toLowerCase()) && have.add(a.toLowerCase()));
    const merged = add.reduce(aliasText, withFront(keepText, draft.text));
    return { ...out, group: 'merge', draft: { ...view, keep: draft.keep, drop: draft.drop, text: draft.text }, ops: [{ op: 'restore', rel: draft.keep, before: merged }, { op: 'trash', rel: draft.drop }] };
  }
  if (draft.kind === 'contradiction') {
    const cur = textOf(draft.rel);
    if (cur == null) return { ...out, ops: [], hold: 'The note in the draft is gone.' };
    return { ...out, group: 'rewrite', draft: { ...view, rel: draft.rel, text: draft.text }, ops: [{ op: 'restore', rel: draft.rel, before: withFront(cur, draft.text) }] };
  }
  if (draft.kind === 'retro') {
    const body = draft.action === 'rewrite' ? withFront(textOf(item.retro.made) ?? '', draft.text) : null;
    const res = retroOps(item.retro, { action: draft.action, to: draft.to ?? null, text: body }, textOf);
    const view2 = { ...view, action: draft.action, ...(draft.to ? { to: draft.to } : {}), ...(draft.text ? { text: draft.text } : {}) };
    if (!res.ops) return { ...out, draft: view2, ops: [], hold: res.why };
    return { ...out, group: 'retro', keep: false, via: 'draft', draft: view2, ops: res.ops };
  }
  return item;
}

// whether a second draft agrees with the first: the same kind of fix onto the same note. Drafted text may differ
export function agrees(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'point') return a.to === b.to;
  if (a.kind === 'merge') return a.keep === b.keep;
  if (a.kind === 'contradiction') return a.rel === b.rel;
  if (a.kind === 'retro') return a.action === b.action && (a.to ?? null) === (b.to ?? null);
  return true;
}

// a draft a bulk plan can tick on its own: high confidence and every quote checked
export const trustedDraft = (d) => !!d && d.confidence === 'high' && d.verified === true && d.quotes?.length > 0 && d.quotes.every((q) => q.ok);

const today = (t) => new Date(t).toISOString().slice(0, 10);

// The drafter: one draft per tick, while drafting is on, under the daily cap, and never while a recording runs or the
// person typed in the last two minutes. Drafts are kept in a file in Quorum's data folder by item id with the hash of
// their evidence, so a draft holds until a note it read changes.
//   model(prompt, system) -> reply text; the person's Claude Code in the app, a fake in the tests
//   items() -> the review items now; evidence(item) -> [{ rel, text }] the notes the agent may read, or null when the
//   read guard or a confidential mark keeps a note it needs away from the agent
export function createDrafter({ file, model, items, evidence, enabled = () => false, cap = () => DAILY_CAP, busy = () => false, idleMs = () => Infinity, now = () => Date.now(), log = () => {} }) {
  let state = null;
  const load = () => {
    if (state) return state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = null; }
    if (!state || typeof state !== 'object') state = {};
    state.drafts ??= {}; state.failed ??= {}; state.day ??= today(now()); state.count ??= 0;
    return state;
  };
  const save = () => { try { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(state)); renameSync(`${file}.tmp`, file); } catch {} };
  const used = () => { const s = load(); if (s.day !== today(now())) { s.day = today(now()); s.count = 0; } return s.count; };
  // why drafting waits now, or null when it can run
  const waiting = () => {
    if (!enabled()) return 'off';
    if (used() >= cap()) return 'cap';
    if (busy()) return 'busy';
    if (idleMs() < QUIET_MS) return 'typing';
    return null;
  };
  // the stored draft of an item while its evidence reads the same, quotes checked again against the notes now
  function draftFor(item, notes) {
    const d = load().drafts[item.id];
    if (!d || !notes || d.hash !== evidenceHash(notes)) return null;
    const quotes = verifyQuotes(d.draft.quotes, notes);
    if (quotes.some((q) => !q.ok)) return null;
    // confirmed: true when a second draft agreed, false when it did not or its quotes failed, absent while it waits
    return { ...d.draft, quotes, at: d.at, ...(d.confirm ? { confirmed: d.confirm.agree } : {}) };
  }
  let running = null;
  // drafts the next item that has no draft for its evidence now, else confirms the next draft that has no second draft.
  // Answers what it did, for the log and the tests
  async function tick() {
    if (running) return { skipped: 'running' };
    const why = waiting();
    if (why) return { skipped: why };
    const s = load();
    const list = items().filter((i) => draftKind(i));
    const confirmOf = (item, notes, h) => {
      const p = draftPrompt(item, notes);
      if (!p) return null;
      s.count++;
      save();
      running = (async () => {
        try {
          const res = checkDraft(item, notes, await model(p.prompt, p.system));
          const first = s.drafts[item.id];
          if (!first || first.hash !== h) return { skipped: 'changed' };
          const agree = !!res.draft && agrees(first.draft, res.draft);
          first.confirm = { agree, at: now(), ...(res.draft ? {} : { why: res.why }) };
          save();
          log('memory draft confirm', item.id, agree ? 'agrees' : res.why ?? 'disagrees');
          return { confirmed: item.id, agree };
        } catch (e) {
          return { failed: item.id, why: String(e?.message ?? e).slice(0, 200) };
        } finally { running = null; }
      })();
      return running;
    };
    for (const item of list) {
      const notes = evidence(item);
      if (!notes?.length) continue;
      const h = evidenceHash(notes);
      if (s.drafts[item.id]?.hash === h) continue;
      const f = s.failed[item.id];
      if (f?.hash === h && now() - f.at < RETRY_MS) continue;
      const p = draftPrompt(item, notes);
      if (!p) continue;
      s.count++;
      save();
      running = (async () => {
        try {
          const reply = await model(p.prompt, p.system);
          const res = checkDraft(item, notes, reply);
          if (res.draft) { s.drafts[item.id] = { hash: h, at: now(), draft: res.draft }; delete s.failed[item.id]; } else s.failed[item.id] = { hash: h, at: now(), why: res.why };
          save();
          log('memory draft', item.id, res.draft ? `${res.draft.kind} ${res.draft.confidence}` : res.why);
          return res.draft ? { drafted: item.id, draft: res.draft } : { dropped: item.id, why: res.why };
        } catch (e) {
          s.failed[item.id] = { hash: h, at: now(), why: String(e?.message ?? e).slice(0, 200) };
          save();
          return { failed: item.id, why: s.failed[item.id].why };
        } finally { running = null; }
      })();
      return running;
    }
    for (const item of list) {
      const d = s.drafts[item.id];
      if (!d || d.confirm) continue;
      const notes = evidence(item);
      if (!notes?.length || d.hash !== evidenceHash(notes)) continue;
      const run = confirmOf(item, notes, d.hash);
      if (run) return run;
    }
    return { skipped: 'nothing' };
  }
  // the drafts of items no longer in review are dropped, so the file stays small
  function prune(ids) {
    const s = load();
    const keep = new Set(ids);
    let n = 0;
    for (const k of [...Object.keys(s.drafts), ...Object.keys(s.failed)]) if (!keep.has(k)) { delete s.drafts[k]; delete s.failed[k]; n++; }
    if (n) save();
  }
  const status = () => ({ used: used(), cap: cap(), waiting: waiting() });
  return { tick, draftFor, prune, status, waiting };
}
