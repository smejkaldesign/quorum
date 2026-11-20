import { describe, expect, it } from 'vitest';
import { isCalendarAddress, meetingWho, whoText } from '../meetingWho.js';
import { eventRef } from '../meetingPlatforms.js';
import { mapEvent } from '../sources/gcal.js';
import { peopleText } from '../src/AppChip.tsx';

// Google's group and resource calendar addresses, built from their suffixes
const GROUP_SUFFIX = '@group.calendar.google.com', RESOURCE_SUFFIX = '@resource.calendar.google.com';
const GROUP = `c_${'ab12'.repeat(16)}${GROUP_SUFFIX}`;
const ROOM = `room-4${RESOURCE_SUFFIX}`;
const me = { name: 'Pat Example', email: 'pat@example.com', self: true };
const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' };
const sam = { name: 'Sam Lee', email: 'sam.lee@example.com' };
const kim = { name: '', email: 'kim@example.com' };

describe('meeting subtitle', () => {
  it('knows group and resource calendar addresses', () => {
    expect(isCalendarAddress(GROUP)).toBe(true);
    expect(isCalendarAddress(ROOM)).toBe(true);
    expect(isCalendarAddress('jane.doe@example.com')).toBe(false);
  });
  it('names the organizer when the organizer is a person', () => {
    expect(meetingWho({ organizer: 'jane.doe@example.com', organizerName: 'Jane Doe', attendees: [me, jane] })).toEqual({ name: 'Jane Doe', others: 0 });
    // a person organizer with no display name of their own takes the name the invite lists for them
    expect(meetingWho({ organizer: 'jane.doe@example.com', attendees: [me, jane] })).toEqual({ name: 'Jane Doe', others: 0 });
  });
  it('names the first invitee for a group calendar organizer, never the calendar ID', () => {
    const r = meetingWho({ organizer: GROUP, organizerName: 'Design team', attendees: [me, jane] });
    expect(r).toEqual({ name: 'Jane Doe', others: 0 });
    expect(r.name).not.toContain('calendar.google.com');
  });
  it('treats a resource calendar, or one the calendar marks as a resource, the same way', () => {
    expect(meetingWho({ organizer: ROOM, attendees: [me, jane] }).name).toBe('Jane Doe');
    expect(meetingWho({ organizer: 'shared@example.com', organizerResource: true, attendees: [me, sam] }).name).toBe('Sam Lee');
  });
  it('skips rooms, resources and you when it picks the invitee', () => {
    const room = { name: 'Room 4', email: ROOM };
    const projector = { name: 'Projector', email: 'projector@example.com', resource: true };
    expect(meetingWho({ organizer: GROUP, attendees: [room, projector, me, sam] })).toEqual({ name: 'Sam Lee', others: 0 });
    expect(meetingWho({ organizer: GROUP, attendees: [me, jane] }, (a) => a.email === 'pat@example.com').name).toBe('Jane Doe');
  });
  it('falls back to the invitee email when no one has a name, then to the organizer email', () => {
    expect(meetingWho({ organizer: GROUP, attendees: [me, kim] })).toEqual({ name: 'kim@example.com', others: 0 });
    expect(meetingWho({ organizer: 'kim@example.com', attendees: [me] })).toEqual({ name: 'kim@example.com', others: 0 });
    // a group calendar with nobody else invited reads as its own name, else nothing
    expect(meetingWho({ organizer: GROUP, organizerName: 'Design team', attendees: [me] }).name).toBe('Design team');
    expect(meetingWho({ organizer: GROUP, attendees: [me] }).name).toBe('');
  });
  it('counts the others besides the one named and you, as "Name and 3 others"', () => {
    const who = meetingWho({ organizer: GROUP, attendees: [me, jane, sam, kim, { name: 'Lee Ray', email: 'lee@example.com' }] });
    expect(who).toEqual({ name: 'Jane Doe', others: 3 });
    expect(whoText(who.name, who.others)).toBe('Jane Doe and 3 others');
    expect(whoText('Jane Doe', 1)).toBe('Jane Doe and 1 other');
    expect(whoText('Jane Doe', 0)).toBe('Jane Doe');
    expect(meetingWho({ organizer: 'jane.doe@example.com', organizerName: 'Jane Doe', attendees: [me, jane, sam] }).others).toBe(1);
  });
  it('carries the Google organizer name and resource mark through to the row', () => {
    const g = mapEvent({
      id: 'x', summary: 'Design review', start: { dateTime: '2026-11-20T15:00:00Z' }, end: { dateTime: '2026-11-20T16:00:00Z' },
      organizer: { email: GROUP, displayName: 'Design team' },
      attendees: [{ email: 'pat@example.com', displayName: 'Pat Example', self: true }, { email: ROOM, displayName: 'Room 4', resource: true }, { email: 'jane.doe@example.com', displayName: 'Jane Doe' }, { email: 'sam.lee@example.com', displayName: 'Sam Lee' }],
    }, 'primary');
    const ref = eventRef(g);
    expect(ref).toMatchObject({ organizer: 'Jane Doe', others: 1, count: 3 });
    expect(peopleText(ref)).toBe('Jane Doe and 1 other');
  });
  it('never shows a calendar ID kept from before, in Up next or on Home', () => {
    expect(peopleText({ organizer: GROUP, count: 4 })).toBe('4 people');
    expect(peopleText({ organizer: GROUP, count: 4 }, ['Jane Doe', 'Sam Lee'])).toBe('Jane Doe and 1 other');
    expect(peopleText({ organizer: 'jane.doe@example.com', count: 3 })).toBe('jane.doe@example.com and 2 others');
    expect(peopleText(null, [])).toBe('Self');
  });
});
