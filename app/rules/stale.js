// Stale notes: a note that says work is open but has not moved. Three signals, each from the note itself:
//   open status  status: draft, planned, in progress and the like, and no update in 90 days (the newest of its
//                updated, last_updated, modified and date keys, else the file time). "active" is left out: it marks
//                evergreen notes as often as open work
//   past due     due: or deadline: in the past, or a date in the title in the past, while the status is open
//   unverified   last_verified older than the folder's interval: the verify_every (days) most notes in the folder
//                carry, else 90 days
// A last_verified inside the folder's interval means a person checked the note is current (Approve, Mark it current),
// so the open status, past due and dated title signals wait until the interval passes
import { DAY, dateIn, dirOf, finding, quote, skipped } from './common.js';

export const rule = { id: 'note.stale', version: 2, label: 'Notes that look out of date' };
export const OPEN = /^(draft|planned|planning|proposed|todo|to do|in[ -]?progress|wip|doing|building|blocked|pending|scoping|ready|in[ -]?review|review|next)$/i;
export const STALE_DAYS = 90;
const DATE_KEYS = ['updated', 'last_updated', 'modified', 'last_modified', 'date', 'created'];
const days = (ms) => Math.floor(ms / DAY);
const day = (t) => new Date(t).toISOString().slice(0, 10);

export function run({ notes, now = Date.now() }) {
  const live = notes.filter((n) => !skipped(n));
  const every = new Map();
  for (const n of live) {
    const v = Number.parseInt(String(n.note?.props?.verify_every ?? ''), 10);
    if (!Number.isFinite(v) || v <= 0) continue;
    const m = every.get(dirOf(n.rel)) ?? every.set(dirOf(n.rel), new Map()).get(dirOf(n.rel));
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  const intervalOf = (d) => { const m = every.get(d); return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : STALE_DAYS; };
  const out = [];
  for (const n of live) {
    const p = n.note?.props ?? {};
    const status = String(Array.isArray(p.status) ? p.status[0] ?? '' : p.status ?? '').trim();
    const open = OPEN.test(status);
    const stamps = DATE_KEYS.map((k) => dateIn(p[k])).filter((t) => t != null);
    const touched = stamps.length ? Math.max(...stamps) : n.mtime;
    const verified = dateIn(p.last_verified);
    const iv = intervalOf(dirOf(n.rel));
    const current = verified != null && now - verified <= iv * DAY;
    const signals = [];
    if (current) { /* checked within the interval: nothing to flag */ } else if (open && touched && now - touched > STALE_DAYS * DAY) signals.push({ id: 'open', line: `Status ${quote(status)}, last updated ${day(touched)} (${days(now - touched)} days ago)` });
    const due = dateIn(p.due ?? p.deadline);
    if (!current && open && due != null && due < now - DAY) signals.push({ id: 'due', line: `Due ${day(due)}, and the status is still ${quote(status)}` });
    const titled = dateIn(n.note?.title);
    if (!current && open && due == null && titled != null && titled < now - STALE_DAYS * DAY && !signals.length) signals.push({ id: 'title', line: `The title names ${day(titled)}, and the status is still ${quote(status)}` });
    if (verified != null && !current) signals.push({ id: 'verify', line: `Last verified ${day(verified)}; notes in ${dirOf(n.rel) || 'the vault root'} are checked every ${iv} days` });
    if (!signals.length) continue;
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} looks out of date`,
      problem: 'The note reads as current work, so the agent may act on plans or facts that have moved on.',
      proposal: signals.some((s) => s.id === 'verify') ? 'Check the note is still right and update last_verified, or mark it archived.' : 'Update its status (done, archived or the real state) and the date, or note what changed.',
      evidence: signals.map((s) => s.line), facts: signals.map((s) => s.id),
      meta: [['Note', n.rel], ...(status ? [['Status', status]] : [])],
    }));
  }
  return out;
}
