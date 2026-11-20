// What Quorum says before you join a call from it, when Zoom AI notes are your notetaker (ee/platforms.js imports
// them). Zoom keeps My Notes behind two settings in two places, and Zoom's API can read neither of them, so Quorum
// can only tell they are on from notes it has already imported. For Google Meet, Microsoft Teams and in-person
// meetings, My Notes has to be started by hand, and everyone should agree to notes first.
//
// When the invite names someone on the never-listen list or an opted-out company, Quorum never prompts capture. For a
// Zoom call it warns instead: Auto-start My Notes would take notes anyway, so it says how to stop them (and the
// importer never files notes for that meeting, ee/platforms.js).

// the exact menu paths, from Zoom's "Enabling or disabling the My Notes feature" support article
export const ZOOM_MY_NOTES_STEPS = [
  'Zoom web portal (zoom.us): click your profile picture, then Settings. In the side menu click Notes, and under My Notes turn on Enable My Notes. If it is gray, your Zoom admin has locked it.',
  'Zoom desktop app: click your profile picture, then Settings. Open the Meetings & webinars tab, and under When joining meetings and webinars turn on Auto-start My Notes.',
];
export const ZOOM_WEB_SETTINGS = 'https://zoom.us/profile/setting';
// from Zoom's "Using My Notes" article: a participant stops My Notes in the My Notes panel; Auto-start is a desktop app setting
export const STOP_MY_NOTES = 'Once you are in the call, click the My Notes icon at the top of the meeting window and stop transcription in the My Notes panel. To keep Zoom from starting it at all, turn off Auto-start My Notes before you join: Zoom desktop app, profile picture, Settings, Meetings & webinars, When joining meetings and webinars.';
export const MANUAL_STEPS = 'When the call starts, open the Zoom desktop app and start a note in My Notes. Before you start, ask everyone in the meeting whether they agree to notes, and stop if anyone says no.';
// a note imported this recently shows My Notes is on
const RECENT_MS = 14 * 86400000;

// zoom: the platform state from ee/platforms.js ({ connected, myNotes: { seenAt, confirmedAt } }) or null in the local
// edition; blocked: the invite matches the never-listen or opt-out lists; dismissed: { zoom, manual } from settings
export function joinAdvice({ platform, zoom = null, blocked = false, dismissed = {}, now = Date.now() }) {
  if (!zoom?.connected) return null;
  if (blocked) return platform === 'zoom' ? { kind: 'blocked', message: 'This meeting is on your never-listen or opt-out list', detail: `Quorum will not file notes from this meeting. If Auto-start My Notes is on, Zoom takes notes anyway. ${STOP_MY_NOTES}`, settingsUrl: null } : null;
  if (platform === 'zoom') {
    if (dismissed.zoom || zoom.myNotes?.confirmedAt) return null;
    const seen = zoom.myNotes?.seenAt && now - new Date(zoom.myNotes.seenAt).getTime() < RECENT_MS;
    return {
      kind: 'zoom',
      message: seen ? 'Check that Auto-start My Notes is on in Zoom' : 'Turn on My Notes in Zoom before you join',
      detail: [
        seen
          ? 'Quorum imported My Notes recently, so My Notes is on. Zoom does not tell Quorum whether Auto-start My Notes is on, so check it once:'
          : 'Quorum files your Zoom AI notes after each meeting, but only if Zoom took them. Zoom does not tell Quorum whether these two settings are on, so check both once:',
        ...ZOOM_MY_NOTES_STEPS.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n\n'),
      settingsUrl: ZOOM_WEB_SETTINGS,
    };
  }
  if (dismissed.manual) return null;
  const app = platform === 'meet' ? 'Google Meet' : platform === 'teams' ? 'Microsoft Teams' : 'an in-person meeting';
  return { kind: 'manual', message: `Start My Notes by hand in ${app}`, detail: `Auto-start My Notes works only in Zoom calls. ${MANUAL_STEPS}`, settingsUrl: null };
}
