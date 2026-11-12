// The notetaker features behind the admin app's feature flags (flags.js, migrations 0021 and 0022). Quorum leaves
// meeting notes to the apps that already take them (Granola, Zoom's own recordings) and keeps manual listening for the
// notes you take yourself. Nothing here is deleted: each group sits behind one flag so it can be brought back without
// a release.
//
//   meeting-capture  call detection for Zoom, Meet and Teams, the "meeting detected" popup, auto-listen, the notice
//                    posted into the call's chat, STOP and GO, the never-listen list, calendar matching for a call
//   live-assist      suggestions during a session and speaker naming
//   manual-listen    Start listening, dictation, the live transcript, the review and the note it writes, the running
//                    summary
//   screen-context   words read off the front window as spelling hints for a listening session
//
// meeting-capture, live-assist and screen-context each require manual-listen; flags.js applies that, so the resolved
// flags this file reads already have them off whenever listening is off.
//
// One rule outranks the flags: a change never takes controls away from a session that is running. A session on a
// noticed call keeps call handling (the watch, STOP and GO, the call-end event) until it ends, and the switch takes
// hold then.
import { DEFAULTS, resolveFlags } from './flags.js';

export const FLAG = Object.freeze({
  meetingCapture: 'meeting-capture',
  liveAssist: 'live-assist',
  manualListen: 'manual-listen',
  screenContext: 'screen-context',
});

// the four switches as booleans, from flags.js's resolved flags ({ key: { enabled } }); none given means the defaults
export function notetakerGates(resolved = resolveFlags({ defaults: DEFAULTS, env: {} })) {
  const on = (key) => resolved?.[key]?.enabled === true;
  return {
    meetingCapture: on(FLAG.meetingCapture),
    liveAssist: on(FLAG.liveAssist),
    manualListen: on(FLAG.manualListen),
    screenContext: on(FLAG.screenContext),
  };
}

// the gates a running session sees: a session on a noticed call keeps meeting capture until it ends, whatever the
// flag says now
export const sessionGates = (g, { callSession = false } = {}) => (callSession && !g.meetingCapture ? { ...g, meetingCapture: true } : g);

export const LISTEN_OFF = 'Listening is turned off in this build of Quorum.';
export const DICTATION_OFF = 'Dictation is turned off in this build of Quorum.';

// Start listening: refused when manual-listen is off. With meeting-capture off a call is never noticed, so every
// session is a solo note on this Mac: no chat notice, no STOP or GO, no never-listen check.
export function startDecision(g, { meetingActive = false } = {}) {
  if (!g.manualListen) return { ok: false, error: LISTEN_OFF };
  return { ok: true, solo: !(g.meetingCapture && meetingActive) };
}

// what keep() does with each final line: the STOP-intent check and the opted-out name match only make sense on a
// noticed call; suggestions are live assistance
export const keepActions = (g, { solo = true } = {}) => ({
  optOut: g.meetingCapture && !solo,
  softStop: g.meetingCapture && !solo,
  suggest: g.liveAssist,
});

// sessionTerms: the calendar's invitees are matched only for a noticed call; the screen read follows its own flag
export const termsPlan = (g, { calendar = true } = {}) => ({ invitees: g.meetingCapture && calendar, screen: g.screenContext });
