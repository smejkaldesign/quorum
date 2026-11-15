import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { briefPrompt, createBriefCache, parseBrief, seriesKey, seriesOf } from '../meetingBrief.js';

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
