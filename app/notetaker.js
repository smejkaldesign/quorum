// The notetaker features behind the admin app's feature flags (flags.js, migration 0021). Quorum leaves meeting notes
// to the apps that already take them (Granola, Zoom's own recordings) and keeps manual listening for the notes you
// take yourself. Nothing here is deleted: each group sits behind one flag so it can be brought back without a release.
//
//   meeting-capture  call detection for Zoom, Meet and Teams, the "meeting detected" popup, auto-listen, the notice
//                    posted into the call's chat, STOP and GO, the never-listen list, calendar matching for a call
//   live-assist      suggestions during a session and speaker naming
//   manual-listen    Start listening, dictation, the live transcript, the review and the note it writes, the running
//                    summary
//   screen-context   words read off the front window as spelling hints for a listening session; needs manual-listen
//
// Pure functions over a flag reader, so the main process and the tests share the same rules.

export const FLAG = Object.freeze({
  meetingCapture: 'meeting-capture',
  liveAssist: 'live-assist',
  manualListen: 'manual-listen',
  screenContext: 'screen-context',
});

// what each flag holds before the relay answers; flags.js carries the same values
export const NOTETAKER_DEFAULTS = Object.freeze({
  [FLAG.meetingCapture]: false,
  [FLAG.liveAssist]: false,
  [FLAG.manualListen]: true,
  [FLAG.screenContext]: true,
});

// the four switches as booleans; get(key) is flags.get from flags.js, or any function with the same answer
export function notetakerGates(get) {
  const on = (key) => (typeof get === 'function' ? get(key) === true : NOTETAKER_DEFAULTS[key] === true);
  const manualListen = on(FLAG.manualListen);
  return {
    meetingCapture: on(FLAG.meetingCapture),
    liveAssist: on(FLAG.liveAssist),
    manualListen,
    // screen context only ever runs inside a listening session or dictation
    screenContext: manualListen && on(FLAG.screenContext),
  };
}

export const LISTEN_OFF = 'Listening is turned off in this build of Quorum.';

// Start listening: refused when manual-listen is off. With meeting-capture off a call is never noticed, so every
// session is a solo note on this Mac: no chat notice, no STOP or GO, no never-listen check.
export function startDecision(g, { meetingActive = false } = {}) {
  if (!g.manualListen) return { ok: false, error: LISTEN_OFF };
  return { ok: true, solo: !(g.meetingCapture && meetingActive) };
}

// dictation into the composer belongs to manual listening
export const dictationAllowed = (g) => g.manualListen;

// what keep() does with each final line: the STOP-intent check and the opted-out name match only make sense on a
// noticed call; suggestions are live assistance
export const keepActions = (g, { solo = true } = {}) => ({
  optOut: g.meetingCapture && !solo,
  softStop: g.meetingCapture && !solo,
  suggest: g.liveAssist,
});

// the helper's meeting events (meeting, meetingInfo, chat) and everything that reacts to them
export const meetingEventsAllowed = (g) => g.meetingCapture;

// sessionTerms: the calendar's invitees are matched only for a noticed call; the screen read needs its own flag
export const termsPlan = (g, { calendar = true } = {}) => ({ invitees: g.meetingCapture && calendar, screen: g.screenContext });

// the running summary rides on a listening session
export const summaryAllowed = (g) => g.manualListen;

// which flags a change can apply at once in the main process; the rest apply at next launch (the Settings card says so)
export const LIVE_FLAGS = Object.freeze([FLAG.meetingCapture, FLAG.liveAssist, FLAG.manualListen, FLAG.screenContext]);
