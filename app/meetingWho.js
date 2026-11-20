// Who a meeting is with, in a row's few words (Up next, Home, the meeting history): a person's name, never a group or
// resource calendar's address. Pure, so main.js (meetingPlatforms.js eventRef) and the renderer (AppChip peopleText)
// share it.
const CALENDAR_ADDRESS = /@(group|resource)\.calendar\.google\.com$/i;
export const isCalendarAddress = (a) => CALENDAR_ADDRESS.test(String(a ?? '').trim());
const clean = (s) => String(s ?? '').trim();
const lower = (s) => clean(s).toLowerCase();

// e: { organizer, organizerName?, organizerResource?, attendees: [{ name, email, self?, resource? }] }; isMe(attendee).
// The name, in order: the organizer's display name when the organizer is a person other than you; when the organizer
// is you, or a group or resource calendar, the first invitee who is not you, a room or a resource, by name and then by
// email; last, a person organizer's own address. A calendar's address is never the name: a calendar organizer with
// nobody else invited reads as the calendar's display name, or ''.
// others counts the invitees besides the one named and you.
export function meetingWho(e, isMe = (a) => a?.self === true) {
  const org = clean(e?.organizer);
  const people = (e?.attendees ?? []).filter((a) => a && !a.resource && !isCalendarAddress(a.email) && (clean(a.name) || clean(a.email)));
  const notMe = people.filter((a) => !isMe(a));
  const calendarOrg = !!e?.organizerResource || isCalendarAddress(org);
  let lead, name;
  if (calendarOrg) {
    lead = notMe[0] ?? null;
    name = clean(lead?.name) || clean(lead?.email) || clean(e?.organizerName);
  } else if (org) {
    const row = people.find((a) => lower(a.email) === lower(org)) ?? null;
    // a meeting you organized names the first other person invited; you only when nobody else is
    if ((row ? isMe(row) : isMe({ email: org, name: clean(e?.organizerName) })) && notMe.length) {
      lead = notMe[0];
      name = clean(lead.name) || clean(lead.email);
    } else {
      lead = row;
      name = clean(e?.organizerName) || clean(lead?.name) || org;
    }
  } else {
    lead = notMe[0] ?? people[0] ?? null;
    name = clean(lead?.name) || clean(lead?.email);
  }
  const named = calendarOrg ? null : lower(org);
  const others = notMe.filter((a) => a !== lead && !(named && lower(a.email) === named)).length;
  return { name, others };
}

// "Jane Doe", "Jane Doe and 1 other", "Jane Doe and 3 others"
export function whoText(name, others = 0) {
  return others > 0 ? `${name} and ${others} ${others === 1 ? 'other' : 'others'}` : name;
}
