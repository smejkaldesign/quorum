// What the meeting page's prep section says and offers below the threshold (MeetingPage.tsx). Pure, so the tests can
// drive it. Generate anyways shows only for a meeting with fewer past meetings than the threshold, before any brief is
// written for it, and only when the person asks does anything get written.
import type { MeetingBrief } from './quorum';

export const ANYWAY_LABEL = 'Generate anyways';

// the button shows for a meeting under the threshold (status few, or a failed try) that has no brief yet
export function anywayOffered(data: Pick<MeetingBrief, 'status' | 'anyway' | 'brief'> | null | undefined) {
  return !!data?.anyway && !data.brief && (data.status === 'few' || data.status === 'failed');
}

export function prepEmptyText(data: Pick<MeetingBrief, 'status' | 'anyway' | 'min'> | null | undefined) {
  const min = data?.min ?? 3;
  switch (data?.status) {
    case 'few': return `Not recurring yet. After ${min} or more meetings, Quorum starts showing a summary and prep notes for this meeting, specific to you.${data.anyway ? ` ${ANYWAY_LABEL} writes them now from what Quorum has: the invite, earlier meetings with these people and related notes.` : ''}`;
    case 'no-model': return "Choose a model in Settings and Quorum writes prep notes from this meeting's past notes.";
    case 'opted-out': return 'No prep for this meeting. Someone invited is on your never-listen list.';
    case 'empty': return 'There is nothing to build prep notes from yet. This meeting has no earlier meetings, no other invitees, no description and no related notes.';
    default: return data?.anyway ? 'Quorum could not write prep notes this time. Try again.' : 'Quorum could not write prep notes this time. They are tried again the next time you open this meeting.';
  }
}
