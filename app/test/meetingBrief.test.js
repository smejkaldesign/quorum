import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { briefPrompt, createBriefCache, parseBrief, relatedOf, seriesKey, seriesOf } from '../meetingBrief.js';

const m = (title, date, kind = 'meeting') => ({ title, date, kind });

describe('meeting brief', () => {
  it('collects past meetings with a similar title, newest first, leaving out notes and future ones', () => {
    const list = [m('Eric / MK recurring', '2026-11-05'), m('eric mk recurring', '2026-11-10'), m('Eric / MK recurring', '2026-11-19'),
      m('Budget', '2026-11-06'), m('Eric MK recurring', '2026-11-07', 'note')];
    const s = seriesOf(list, { title: 'Eric / MK recurring', before: new Date('2026-11-14').getTime() });
    expect(s.map((x) => x.date)).toEqual(['2026-11-10', '2026-11-05']);
  });
  it('parses the JSON reply, with or without text around it', () => {
    expect(parseBrief('Here: {"prep":"- a","what":"w","who":"","how":"h"} done')).toEqual({ prep: '- a', what: 'w', who: '', how: 'h' });
    expect(parseBrief('no json')).toBeNull();
    expect(parseBrief('{"prep":"","what":""}')).toBeNull();
  });
  it('builds a prompt with each note dated', () => {
    expect(briefPrompt({ title: 'Sync', notes: [{ title: 'Sync', date: '2026-11-10T14:00:00Z', text: 'body' }] })).toContain('## Sync (2026-11-10)\nbody');
  });
  it('keeps a brief until the series gains a note', () => {
    const c = createBriefCache(path.join(mkdtempSync(path.join(tmpdir(), 'qmb-')), 'b.json'));
    c.set(seriesKey('Sync!'), 'n1', { prep: 'p', what: '', who: '', how: '' });
    expect(c.get('sync', 'n1')?.prep).toBe('p');
    expect(c.get('sync', 'n2')).toBeNull();
  });
});

describe('relatedOf', () => {
  const day = (d) => `2026-${d}T10:00:00Z`;
  const meetings = [
    { file: 'a', title: 'Acme weekly', date: day('10-01'), people: ['Ana Ruiz', 'Ben Cho'] },
    { file: 'b', title: 'Acme pricing review', date: day('09-20'), people: ['ana ruiz', 'Ben Cho', 'Cy Diaz'] },
    { file: 'c', title: 'Globex intro', date: day('09-25'), people: ['Ana Ruiz'] },
    { file: 'd', title: 'Budget sync', date: day('09-28'), people: ['Ben Cho', 'Ana Ruiz'] },
    { file: 'e', title: 'Hand note', date: day('09-29'), people: ['Ana Ruiz', 'Ben Cho'], kind: 'note' },
  ];
  it('lists other meetings that share two of the series people, newest first among equals, without the series', () => {
    const r = relatedOf(meetings, { title: 'Acme weekly', people: ['Ana Ruiz', 'Ben Cho'], before: Date.parse(day('11-01')) });
    expect(r.map((x) => x.file)).toEqual(['d', 'b']);
    expect(r[1].shared).toEqual(['Ana Ruiz', 'Ben Cho']);
  });
  it('needs one shared person when the series has one', () => {
    const r = relatedOf(meetings, { title: 'Acme weekly', people: ['Ana Ruiz'], before: Date.parse(day('11-01')) });
    expect(r.map((x) => x.file)).toEqual(['d', 'c', 'b']);
  });
  it('returns nothing without people', () => {
    expect(relatedOf(meetings, { title: 'Acme weekly', people: [] })).toEqual([]);
  });
});
