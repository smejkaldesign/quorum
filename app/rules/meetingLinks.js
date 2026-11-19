// Meeting notes whose attendees are plain text: the people, attendees or participants field, or an Attendees line in
// the body, names someone with a note, and the meeting does not link to that note. The person's note then misses the
// meeting, and the graph has no attended edge for it. Approve links the first mention of each name to its note.
import { finding, plural, quote } from './common.js';
import { PEOPLE_KEYS, cleanName, confidentialSet, isName, kindOf, linkedIn, live } from './entities.js';

export const rule = { id: 'note.meeting-links', version: 1, label: 'Meeting attendees with no links' };
const ATTENDEE_LINE = /^\s*(?:[-*]\s*)?\**(attendees|participants|people|present|with)\**\s*:\**\s*(.+)$/i;
const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

// the attendee names a note gives in its frontmatter and its Attendees lines, with whether each is a link already
export function attendees(n) {
  const out = new Map();
  const props = n.note?.props ?? {};
  for (const key of PEOPLE_KEYS) for (const raw of list(props[key])) {
    const name = cleanName(raw);
    if (isName(name) && !out.has(name)) out.set(name, linkedIn(raw, name));
  }
  const body = String(n.text ?? '').slice(n.note?.bodyStart ?? 0);
  for (const line of body.split('\n').slice(0, 60)) {
    const m = line.match(ATTENDEE_LINE);
    if (!m) continue;
    for (const raw of m[2].split(/,|;|\band\b/)) {
      const t = raw.trim();
      const name = cleanName(t);
      if (isName(name) && !out.has(name)) out.set(name, /^\[\[/.test(t));
    }
  }
  return [...out].map(([name, linked]) => ({ name, linked }));
}

export function run(ctx) {
  const { notes, resolve } = ctx;
  const secret = confidentialSet(ctx);
  const out = [];
  for (const n of live(notes)) {
    if (kindOf(n) !== 'meeting' || secret(n)) continue;
    const links = new Set((n.note?.links ?? []).map((l) => resolve(l.target, n.rel)).filter(Boolean));
    const todo = [];
    for (const a of attendees(n)) {
      if (a.linked) continue;
      const to = resolve(a.name, n.rel);
      if (!to || to === n.rel || links.has(to)) continue;
      todo.push({ name: a.name, to });
    }
    if (!todo.length) continue;
    const target = (rel) => rel.replace(/\.md$/i, '').split('/').pop();
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel, ...todo.map((t) => t.to)],
      title: `${quote(n.note?.title ?? n.rel)} names ${plural(todo.length, 'attendee')} without linking to them`,
      problem: 'The meeting names people who have notes, with no link to those notes, so their notes miss this meeting and the agent cannot tell who attended.',
      proposal: `Link ${todo.map((t) => quote(t.name)).join(', ')} to ${todo.length === 1 ? 'its note' : 'their notes'}.`,
      evidence: todo.map((t) => `${t.name}: ${t.to}`),
      meta: [['Meeting', n.rel]],
      fix: { kind: 'ops', group: 'mention', ops: todo.map((t) => ({ op: 'mention', rel: n.rel, name: t.name, to: t.to, target: target(t.to), edge: 'attended' })) },
    }));
  }
  return out;
}
