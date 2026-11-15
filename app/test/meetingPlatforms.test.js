import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatformCache, matchPlatforms, similarTitle } from '../meetingPlatforms.js';

const link = (e) => (e.url ? { platform: 'teams', join: e.url } : { platform: null, join: null });
const ev = (title, start, url = 'https://teams.microsoft.com/l/meetup-join/x') => ({ title, start, url });

describe('meeting platform matching', () => {
  it('matches a similar title within 15 minutes', () => {
    const r = matchPlatforms([{ key: 'a', title: 'acme / globex weekly check-in', date: '2026-11-09T14:04:00-08:00' }],
      [ev('Acme / Globex weekly check-in', '2026-11-09T14:00:00-08:00')], link);
    expect(r.a).toMatchObject({ platform: 'teams', url: 'https://teams.microsoft.com/l/meetup-join/x', calendar: 'apple-calendar', event: { start: '2026-11-09T14:00:00-08:00', count: 0 } });
  });
  it('matches any title only within 3 minutes', () => {
    const notes = [{ key: 'a', title: 'Call', date: '2026-11-09T14:02:00Z' }, { key: 'b', title: 'Call', date: '2026-11-09T14:10:00Z' }];
    const r = matchPlatforms(notes, [ev('Design sync', '2026-11-09T14:00:00Z')], link);
    expect(r.a?.platform).toBe('teams');
    expect(r.b).toBeNull();
  });
  it('prefers the event with the matching title', () => {
    const r = matchPlatforms([{ key: 'a', title: 'Budget review', date: '2026-11-09T14:01:00Z' }],
      [ev('Standup', '2026-11-09T14:01:00Z', 'https://x/standup'), ev('Budget review', '2026-11-09T14:00:00Z', 'https://x/budget')], link);
    expect(r.a?.url).toBe('https://x/budget');
  });
  it('keeps the event without a call, records null without an event, and skips undated notes', () => {
    const notes = [{ key: 'a', title: 'Lunch', date: '2026-11-09T12:00:00Z' }, { key: 'b', title: 'x', date: null }, { key: 'c', title: 'Walk', date: '2026-11-10T08:00:00Z' }];
    const r = matchPlatforms(notes, [{ ...ev('Lunch', '2026-11-09T12:00:00Z', ''), organizer: 'a@acme.com', attendees: [{ email: 'a@acme.com' }, { email: 'b@acme.com' }] }], link);
    expect(r.a).toMatchObject({ platform: null, url: null, event: { organizer: 'a@acme.com', count: 2 } });
    expect(r.c).toBeNull();
    expect('b' in r).toBe(false);
  });
  it('compares titles by shared words', () => {
    expect(similarTitle('Eric <> MK recurring', 'eric / mk (recurring)')).toBe(true);
    expect(similarTitle('Budget review', 'Design sync')).toBe(false);
  });
  it('keeps results across loads and counts new apps', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qmp-')), 'p.json');
    const c = createPlatformCache(file);
    expect(c.merge({ a: { platform: 'zoom', url: 'https://zoom.us/j/1' }, b: null })).toBe(1);
    const again = createPlatformCache(file);
    expect(again.get('a')?.platform).toBe('zoom');
    expect(again.has('b')).toBe(true);
  });
});
