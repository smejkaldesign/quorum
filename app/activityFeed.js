// The Notifications view's list: every event Quorum's agents and the person left on notes and memories, in one feed.
//
// The main process gathers the raw records (each note's activity log and upkeep runs, each memory's versions and
// updates, and when each file was last seen or reviewed); this module turns them into rows, the review items, the
// unread state and the counts for the bell, then filters and pages them for the three tabs. It reads no files, so
// the rules are tested on their own (test/activity-feed.test.js).

// the event types the filter offers, in the order it shows them
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
export const FEED_TABS = ['review', 'unread', 'all'];

// a file's name as the person reads it: the index, a daily note, or its words in title case
export function labelOf(rel) {
  const base = String(rel).split('/').pop().replace(/\.md$/, '');
  if (base === 'index') return 'Index';
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) return `Daily note ${base}`;
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const time = (v) => (typeof v === 'number' ? v : new Date(v ?? 0).getTime() || 0);
// a note's log says who did each step in its first word; the person's own steps start with You
const noteKind = (e) => {
  if (String(e.text ?? '').startsWith('You')) return 'you';
  if (e.kind === 'filed') return 'filed';
  if (e.kind === 'referenced') return 'referenced';
  return 'note-updated';
};
const memoryKind = (v) => {
  if (v.who === 'you' || v.who === 'human') return 'you';
  if (v.who === 'import') return 'imported';
  return v.created ? 'memory-created' : 'memory-updated';
};
const memoryText = (v, kind) => {
  const why = v.reason ? `: ${v.reason}` : '';
  if (kind === 'you') return `You ${v.created ? 'created it' : v.removed ? 'deleted it' : 'edited it'}${why}`;
  if (kind === 'imported') return `Imported${why}`;
  return `Agent ${v.created ? 'created it' : v.removed ? 'removed it' : 'updated it'}${why}`;
};
// which Settings > Notifications switch covers a row: reviews for the review items, guardrails for what a guard
// blocked, memory changes for memory pages, note updates for everything on notes
const prefOf = (row) => (row.review ? 'reviews' : row.kind === 'guardrail' ? 'guardrails' : row.target.kind === 'memory' ? 'memoryChanges' : 'noteUpdates');
const prefOn = (prefs, key) => prefs?.[key] !== false;

// every row from the raw records, newest first. notes: { abs, rel, label?, events, seenAt, reviewedAt, rejectedAt,
// agentWritten, writtenAt }. memories: { abs, rel, label?, note?, gone?, versions, updates, seenAt }; note marks a
// memory that is also a saved note, so it opens on the note page. guard: { file, seenAt, denials: { t, tool, path,
// reason }[] } from the guardrail denial log; its rows open the Guardrails page and are read together
export function feedRows({ notes = [], memories = [], guard = null }) {
  const rows = [];
  for (const n of notes) {
    const target = { kind: 'note', abs: n.abs, rel: n.rel, label: n.label ?? labelOf(n.rel) };
    const seen = time(n.seenAt);
    (n.events ?? []).forEach((e, i) => {
      const kind = noteKind(e);
      const at = time(e.at);
      rows.push({ id: `n:${n.abs}:${at}:${i}`, at, kind, who: kind === 'you' ? 'you' : 'agent', text: e.text, target, files: e.files ?? [], unread: kind !== 'you' && at > seen });
    });
    if (n.agentWritten && !n.reviewedAt && !n.rejectedAt) {
      const at = time(n.writtenAt);
      rows.push({ id: `r:note:${n.abs}`, at, kind: 'note-written', who: 'agent', text: 'Quorum wrote this note. Review it before you rely on it or share it.', target, files: [], unread: at > seen, review: { kind: 'note' } });
    }
  }
  for (const m of memories) {
    const target = { kind: m.note ? 'note' : 'memory', abs: m.abs, rel: m.rel, label: m.label ?? labelOf(m.rel), gone: !!m.gone };
    const seen = time(m.seenAt);
    for (const v of m.versions ?? []) {
      const kind = memoryKind(v);
      const at = time(v.at);
      rows.push({ id: `m:${m.rel}:${v.id}`, at, kind, who: kind === 'you' ? 'you' : 'agent', text: memoryText(v, kind), target, files: [], unread: kind !== 'you' && at > seen });
    }
    // the updates waiting for approval make one review item per file: approving or rejecting acts on all of them
    const waiting = (m.updates ?? []).filter((u) => !u.approved);
    if (waiting.length && !m.gone) {
      const at = Math.max(...waiting.map((u) => time(u.at)));
      const blocks = waiting.reduce((s, u) => s + (u.changes ?? 0), 0);
      const n = waiting.length;
      rows.push({
        id: `r:memory:${m.rel}`, at, kind: 'memory-updated', who: 'agent', target, files: [], unread: at > seen,
        text: `Agent made ${n} ${n === 1 ? 'update' : 'updates'} to this memory (${blocks} changed ${blocks === 1 ? 'block' : 'blocks'}). They wait for your approval.`,
        review: { kind: 'memory', count: n },
      });
    }
  }
  if (guard) {
    const target = { kind: 'guardrail', abs: guard.file, rel: 'Guardrails', label: 'Guardrails' };
    const seen = time(guard.seenAt);
    (guard.denials ?? []).forEach((d, i) => {
      const at = time(d.t);
      const what = String(d.path ?? '').replace(/^\/Users\/[^/]+/, '~') || d.tool || 'a request';
      const why = String(d.reason ?? '').replace(/^Quorum read guard: /, '');
      rows.push({ id: `g:${at}:${i}`, at, kind: 'guardrail', who: 'agent', text: `Guardrail blocked ${what}${why ? `: ${why}` : ''}`, target, files: [], unread: at > seen });
    });
  }
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

const matches = (row, q) => {
  if (!q) return true;
  const hay = `${row.text} ${row.target.label} ${row.target.rel} ${row.files.map((f) => f.label).join(' ')}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

// one page of a tab. Needs review lists every review item, whatever the switches say; Unread and All leave out the
// rows whose switch is off. kinds narrows to event types, q to rows whose words match. counts and dot are for the bell
// and the tab labels, and use the switches the same way
export function feedPage(rows, { tab = 'review', kinds = [], q = '', offset = 0, limit = 50, prefs = {} } = {}) {
  const shown = (r) => prefOn(prefs, prefOf(r));
  const review = rows.filter((r) => r.review);
  const unread = rows.filter((r) => r.unread && shown(r));
  const all = rows.filter(shown);
  const base = tab === 'review' ? review : tab === 'unread' ? unread : all;
  const kindSet = new Set(kinds);
  const list = base.filter((r) => (!kindSet.size || kindSet.has(r.kind)) && matches(r, String(q ?? '').trim()));
  const start = Math.max(0, offset | 0);
  const end = start + Math.max(0, limit | 0);
  return {
    items: list.slice(start, end),
    total: list.length,
    more: end < list.length,
    counts: { review: review.length, unread: unread.length, all: all.length },
    dot: unread.length > 0 || review.some(shown),
  };
}
