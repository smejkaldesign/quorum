import { describe, expect, it } from 'vitest';
import { FLAG, LISTEN_OFF, NOTETAKER_DEFAULTS, dictationAllowed, keepActions, meetingEventsAllowed, notetakerGates, startDecision, summaryAllowed, termsPlan } from '../notetaker.js';
import { createFlags, resolveFlags } from '../flags.js';
import { aboutFor, connectorsFor, featuresFor, CONNECTORS } from '../connectors/library.js';

// a flag reader with the given switches and the defaults for the rest, the shape flags.get has
const reader = (over = {}) => (key) => ({ ...NOTETAKER_DEFAULTS, ...over })[key] === true;

describe('notetaker gates', () => {
  it('reads the defaults when no reader is given: no call detection, no live assistance, manual listening and screen context on', () => {
    expect(notetakerGates()).toEqual({ meetingCapture: false, liveAssist: false, manualListen: true, screenContext: true });
  });

  it('turns screen context off whenever manual listening is off, whatever its own switch says', () => {
    expect(notetakerGates(reader({ [FLAG.manualListen]: false, [FLAG.screenContext]: true })).screenContext).toBe(false);
    expect(notetakerGates(reader({ [FLAG.screenContext]: false })).screenContext).toBe(false);
  });

  it('agrees with flags.js on the default of every notetaker flag', () => {
    const resolved = resolveFlags({ env: {} });
    for (const [key, on] of Object.entries(NOTETAKER_DEFAULTS)) expect(resolved[key]?.enabled).toBe(on);
  });
});

describe('starting a session', () => {
  it('starts a solo note with meeting capture off, even while a call app reports a call', () => {
    const g = notetakerGates(reader());
    expect(startDecision(g, { meetingActive: false })).toEqual({ ok: true, solo: true });
    expect(startDecision(g, { meetingActive: true })).toEqual({ ok: true, solo: true });
  });

  it('starts on the noticed call when meeting capture is on and a call is active', () => {
    const g = notetakerGates(reader({ [FLAG.meetingCapture]: true }));
    expect(startDecision(g, { meetingActive: true })).toEqual({ ok: true, solo: false });
    expect(startDecision(g, { meetingActive: false })).toEqual({ ok: true, solo: true });
  });

  it('refuses the start with manual listening off, call or no call', () => {
    for (const meetingCapture of [false, true]) {
      const g = notetakerGates(reader({ [FLAG.manualListen]: false, [FLAG.meetingCapture]: meetingCapture }));
      expect(startDecision(g, { meetingActive: true })).toEqual({ ok: false, error: LISTEN_OFF });
    }
  });

  it('allows dictation and the running summary only with manual listening on', () => {
    expect(dictationAllowed(notetakerGates(reader()))).toBe(true);
    expect(summaryAllowed(notetakerGates(reader()))).toBe(true);
    const off = notetakerGates(reader({ [FLAG.manualListen]: false }));
    expect(dictationAllowed(off)).toBe(false);
    expect(summaryAllowed(off)).toBe(false);
  });
});

describe('what a final line does', () => {
  it('skips the STOP check, the opt-out match and suggestions in a solo note with the notetaker flags off', () => {
    expect(keepActions(notetakerGates(reader()), { solo: true })).toEqual({ optOut: false, softStop: false, suggest: false });
  });

  it('runs the STOP check and the opt-out match only on a noticed call with meeting capture on', () => {
    const g = notetakerGates(reader({ [FLAG.meetingCapture]: true }));
    expect(keepActions(g, { solo: false })).toMatchObject({ optOut: true, softStop: true });
    expect(keepActions(g, { solo: true })).toMatchObject({ optOut: false, softStop: false });
  });

  it('offers suggestions only with live assistance on', () => {
    expect(keepActions(notetakerGates(reader({ [FLAG.liveAssist]: true })), { solo: true }).suggest).toBe(true);
  });
});

describe('call events and vocabulary', () => {
  it('drops the helper call events with meeting capture off', () => {
    expect(meetingEventsAllowed(notetakerGates(reader()))).toBe(false);
    expect(meetingEventsAllowed(notetakerGates(reader({ [FLAG.meetingCapture]: true })))).toBe(true);
  });

  it('matches calendar invitees only for a noticed call and reads the screen with its own flag', () => {
    expect(termsPlan(notetakerGates(reader()), { calendar: true })).toEqual({ invitees: false, screen: true });
    expect(termsPlan(notetakerGates(reader({ [FLAG.meetingCapture]: true })), { calendar: true })).toEqual({ invitees: true, screen: true });
    expect(termsPlan(notetakerGates(reader({ [FLAG.meetingCapture]: true })), { calendar: false })).toEqual({ invitees: false, screen: true });
    expect(termsPlan(notetakerGates(reader({ [FLAG.screenContext]: false })), { calendar: false }).screen).toBe(false);
  });

  it('follows a flag change from the relay on the next read, with no restart', async () => {
    const settings = {};
    let answer = { 'meeting-capture': false, 'live-assist': false, 'manual-listen': true, 'screen-context': true };
    const fetchImpl = async () => ({ ok: true, json: async () => ({ flags: answer }) });
    const flags = createFlags({ settings, env: { QUORUM_RELAY_URL: 'https://relay.example.com' }, fetchImpl, timers: { set: () => null, clear: () => {} } });
    await flags.refresh();
    expect(notetakerGates((k) => flags.get(k)).meetingCapture).toBe(false);
    answer = { ...answer, 'meeting-capture': true, 'manual-listen': false };
    await flags.refresh();
    const g = notetakerGates((k) => flags.get(k));
    expect(g.meetingCapture).toBe(true);
    expect(startDecision(g, { meetingActive: true }).ok).toBe(false);
  });
});

describe('meeting apps in the connector library', () => {
  it('keeps the listening copy with meeting capture on', () => {
    expect(connectorsFor({ meetingCapture: true })).toBe(CONNECTORS);
  });

  it('offers only Zoom cloud recordings with meeting capture off, and marks Meet and Teams as soon', () => {
    const byId = Object.fromEntries(connectorsFor({ meetingCapture: false }).map((x) => [x.id, x]));
    expect(byId.zoom).toMatchObject({ status: 'available', listen: false, kind: 'meeting-app' });
    expect(byId.zoom.description).not.toMatch(/listens/i);
    expect(byId['google-meet']).toMatchObject({ status: 'soon', listen: false });
    expect(byId.teams).toMatchObject({ status: 'soon', listen: false });
    expect(byId.granola).toBe(CONNECTORS.find((x) => x.id === 'granola'));
    expect(aboutFor(byId.zoom, { meetingCapture: false })).not.toMatch(/listens/i);
    expect(featuresFor(byId.zoom, { meetingCapture: false }).join(' ')).not.toMatch(/Listens|notice/);
  });
});
