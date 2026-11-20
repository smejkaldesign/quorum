export type WhoAttendee = { name?: string; email?: string; self?: boolean; resource?: boolean };
export function isCalendarAddress(a: unknown): boolean;
export function meetingWho(
  e: { organizer?: string; organizerName?: string; organizerResource?: boolean; attendees?: WhoAttendee[] } | null | undefined,
  isMe?: (a: WhoAttendee) => boolean,
): { name: string; others: number };
export function whoText(name: string, others?: number): string;
