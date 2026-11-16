// The Notifications view's list: every event Quorum's agents and the person left on notes and memories, and every
// guardrail block, in one feed.
//
// The main process gathers the raw records (each note's activity log and upkeep runs, the meeting notes imported from
// connected apps, each memory's versions and updates, the guardrail denials, and the read marks); this module turns
// them into rows with their summary (notificationSummary.js), the review items and the unread state, then filters,
// sorts and pages them. It reads no files, so the rules are tested on their own (test/activity-feed.test.js).
//
// History: the rows that come from records kept before Notifications started (older versions, upkeep runs and
// imports) are marked backfill and start out read, so the first opening lists the past without lighting the bell.
import { detailsOf, summaryOf, titleOf } from './notificationSummary.js';

// the event types the Type filter offers, in the order it shows them
export const FEED_KINDS = [
  ['note-written', 'Wrote a note'],
  ['note-updated', 'Updated a note'],
  ['filed', 'Filed and linked'],
  ['referenced', 'Referenced'],
  ['memory-created', 'Created a memory'],
  ['memory-updated', 'Updated a memory'],
  ['imported', 'Imported'],
  ['guardrail', 'Guardrail blocked'],
  ['you', 'Your changes'],
];
export const FEED_TABS = ['all', 'unread'];
// Urgency is a future sort: it needs a score per row (how old a waiting review is, how large a change, how sensitive
// the file a guard protected) before it can order the list
export const FEED_SORTS = ['unread', 'recent', 'az'];

// a file's name as the person reads it, for the places that only have a path
export const labelOf = (rel) => titleOf({ rel });

const time = (v) => (typeof v === 'number' ? v : new Date(v ?? 0).getTime() || 0);
const youText = (t) => String(t ?? '').startsWith('You');
const noteKind = (e) => {
  if (youText(e.text)) return 'you';
  if (e.kind === 'filed') return 'filed';
  if (e.kind === 'referenced') return 'referenced';
  return 'note-updated';
};
const memoryKind = (v) => {
  if (v.who === 'you' || v.who === 'human') return 'you';
  if (v.who === 'import') return 'imported';
  return v.created ? 'memory-created' : 'memory-updated';
};
// which Settings > Notifications switch covers a row
const prefOf = (row) => (row.review ? 'reviews' : row.kind === 'guardrail' ? 'guardrails' : row.target.kind === 'memory' ? 'memoryChanges' : 'noteUpdates');
const prefOn = (prefs, key) => prefs?.[key] !== false;

// every row from the raw records, newest first.
//   notes:    { abs, rel, title?, events, runs, seenAt, reviewedAt, rejectedAt, agentWritten, writtenAt, writtenFrom,
//               imported?: { at, source, sourceName, date } }
//   memories: { abs, rel, title?, note?, gone?, versions, updates, seenAt }
//   denials:  { id, t, path, tool, surface, reason, guard, guardLabel }[]
//   state:    { since, read: { [id]: at }, unread: { [id]: at } }; since is when Notifications started keeping its
//             own marks, read and unread are the person's marks on single rows
export function feedRows({ notes = [], memories = [], denials = [], state = {}, guardFile = null }) {
  const rows = [];
  const since = time(state.since);
  const read = state.read ?? {};
  const unreadMark = state.unread ?? {};
  // a row is unread when the agent made it after the file was last seen, it is not from before Notifications began,
  // and the person has not marked it; a mark on the row wins either way
  const push = (row, seen) => {
    row.backfill = !!since && row.at < since && !row.review;
    const fresh = row.who !== 'you' && row.at > time(seen) && !row.backfill;
    row.unread = unreadMark[row.id] ? true : read[row.id] ? false : fresh;
    rows.push(row);
  };
  for (const n of notes) {
    const target = { kind: 'note', abs: n.abs, rel: n.rel, title: n.title ?? titleOf({ rel: n.rel }) };
    const events = n.events ?? [];
    events.forEach((e) => {
      const kind = noteKind(e);
      const at = time(e.at);
      push({ id: `n:${n.abs}:${at}:${e.kind}`, at, kind, event: e.kind, who: kind === 'you' ? 'you' : 'agent', target, files: [], detail: { text: e.text } }, n.seenAt);
    });
    for (const r of n.runs ?? []) {
      const at = time(r.at);
      push({ id: `t:${n.rel}:${at}`, at, kind: 'filed', event: 'filed', who: 'agent', target, files: r.files ?? [], detail: { who: 'keeper', skipped: r.skipped ?? null } }, n.seenAt);
    }
    if (n.imported) {
      const at = time(n.imported.at);
      push({ id: `i:${n.abs}`, at, kind: 'imported', event: 'imported-note', who: 'agent', target, files: [], detail: { who: 'import', source: n.imported.source, sourceName: n.imported.sourceName, date: n.imported.date ?? null } }, n.seenAt);
    }
    if (n.agentWritten && !n.reviewedAt && !n.rejectedAt) {
      const at = time(n.writtenAt);
      const editedAfter = events.some((e) => e.kind === 'edited' && time(e.at) > at);
      push({ id: `r:note:${n.abs}`, at, kind: 'note-written', event: 'review', who: 'agent', target, files: [], detail: { writtenFrom: n.writtenFrom ?? null, editedAfter }, review: { kind: 'note' } }, n.seenAt);
    }
  }
  for (const m of memories) {
    const target = { kind: m.note ? 'note' : 'memory', abs: m.abs, rel: m.rel, title: m.title ?? titleOf({ rel: m.rel }), gone: !!m.gone };
    const updates = new Map((m.updates ?? []).map((u) => [u.id, u]));
    for (const v of m.versions ?? []) {
      const kind = memoryKind(v);
      const u = updates.get(v.id);
      push({
        id: `m:${m.rel}:${v.id}`, at: time(v.at), kind, event: 'version', who: kind === 'you' ? 'you' : 'agent', target, files: [],
        detail: { who: v.who, reason: v.reason || null, created: !!v.created, removed: !!v.removed, changes: u?.changes ?? null, approved: u ? !!u.approved : null, auto: !!u?.auto },
      }, m.seenAt);
    }
    // the updates waiting for approval make one review item per file: approving or rejecting acts on all of them
    const waiting = (m.updates ?? []).filter((u) => !u.approved);
    if (waiting.length && !m.gone) {
      const at = Math.max(...waiting.map((u) => time(u.at)));
      const last = waiting.reduce((a, u) => (time(u.at) > time(a.at) ? u : a), waiting[0]);
      push({
        id: `r:memory:${m.rel}`, at, kind: 'memory-updated', event: 'review', who: 'agent', target, files: [],
        detail: { changes: waiting.reduce((s, u) => s + (u.changes ?? 0), 0), reason: last.reason || null }, review: { kind: 'memory', count: waiting.length },
      }, m.seenAt);
    }
  }
  const guardTarget = { kind: 'guardrail', abs: guardFile ?? '', rel: 'Guardrails', title: 'Guardrails' };
  for (const g of denials) {
    const at = time(g.t);
    push({ id: `g:${g.id ?? at}`, at, kind: 'guardrail', event: 'denial', who: 'agent', target: guardTarget, files: [], detail: { path: g.path ?? '', tool: g.tool ?? '', surface: g.surface ?? null, reason: g.reason ?? '', guard: g.guard ?? null, guardLabel: g.guardLabel ?? null } }, null);
  }
  for (const r of rows) r.summary = summaryOf(r);
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

const matches = (row, words) => {
  if (!words.length) return true;
  const hay = `${row.summary.line} ${row.summary.sub ?? ''} ${row.target.title} ${row.target.rel} ${row.files.map((f) => f.title ?? f.label).join(' ')} ${row.detail?.path ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};
const SORTS = {
  // what is new first, then the rest, each newest first
  unread: (a, b) => Number(b.unread) - Number(a.unread) || b.at - a.at,
  recent: (a, b) => b.at - a.at,
  az: (a, b) => a.target.title.localeCompare(b.target.title, undefined, { sensitivity: 'base' }) || b.at - a.at,
};

// one page of a tab. All and Unread leave out the rows whose switch is off; the Needs review filter keeps only the
// items waiting for a decision, and lists them all whatever the switches say. kinds narrows to event types, q to rows
// whose words match. counts and dot are for the bell and the labels, and use the switches the same way
export function feedPage(rows, { tab = 'all', review = false, kinds = [], q = '', sort = 'unread', offset = 0, limit = 50, prefs = {}, locale } = {}) {
  const shown = (r) => prefOn(prefs, prefOf(r));
  const unread = rows.filter((r) => r.unread && shown(r));
  const reviews = rows.filter((r) => r.review);
  const all = rows.filter(shown);
  let list = tab === 'unread' ? unread : all;
  if (review) list = (tab === 'unread' ? reviews.filter((r) => r.unread) : reviews);
  const kindSet = new Set(kinds);
  const words = String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  list = list.filter((r) => (!kindSet.size || kindSet.has(r.kind)) && matches(r, words));
  list = [...list].sort(SORTS[sort] ?? SORTS.unread);
  const start = Math.max(0, offset | 0);
  const end = start + Math.max(0, limit | 0);
  return {
    items: list.slice(start, end).map((r) => ({ ...r, details: detailsOf(r, { locale }) })),
    total: list.length,
    more: end < list.length,
    counts: { all: all.length, unread: unread.length, review: reviews.length },
    dot: unread.length > 0 || reviews.some(shown),
  };
}
