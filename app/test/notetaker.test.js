import { describe, expect, it } from 'vitest';
import { FLAG, LISTEN_OFF, keepActions, notetakerGates, sessionGates, startDecision, termsPlan } from '../notetaker.js';
import { DEFAULTS, createFlags, resolveFlags } from '../flags.js';
import { RENDERER_DEFAULTS } from '../src/flags';
import { aboutFor, connectorsFor, featuresFor, CONNECTORS } from '../connectors/library.js';

// the gates for the defaults with some flags switched, resolved the way flags.js resolves them (requires applied)
const gates = (over = {}) => notetakerGates(resolveFlags({ defaults: { ...DEFAULTS, ...over }, env: {} }));

describe('notetaker gates', () => {
  it('reads the defaults when nothing is given: no call detection, no live assistance, manual listening and screen context on', () => {
    expect(notetakerGates()).toEqual({ meetingCapture: false, liveAssist: false, manualListen: true, screenContext: true });
  });

  it('turns every notetaker surface off when manual listening is off, whatever their own switches say', () => {
    expect(gates({ [FLAG.manualListen]: false, [FLAG.meetingCapture]: true, [FLAG.liveAssist]: true, [FLAG.screenContext]: true }))
      .toEqual({ meetingCapture: false, liveAssist: false, manualListen: false, screenContext: false });
  });

  it('keeps the renderer defaults equal to the main process defaults', () => {
    expect(RENDERER_DEFAULTS).toEqual(DEFAULTS);
  });
});

describe('starting a session', () => {
  it('starts a solo note with meeting capture off, even while a call app reports a call', () => {
    expect(startDecision(gates(), { meetingActive: false })).toEqual({ ok: true, solo: true });
    expect(startDecision(gates(), { meetingActive: true })).toEqual({ ok: true, solo: true });
  });

  it('starts on the noticed call when meeting capture is on and a call is active', () => {
    const g = gates({ [FLAG.meetingCapture]: true });
    expect(startDecision(g, { meetingActive: true })).toEqual({ ok: true, solo: false });
    expect(startDecision(g, { meetingActive: false })).toEqual({ ok: true, solo: true });
  });

  it('refuses the start with manual listening off, call or no call', () => {
    const g = gates({ [FLAG.manualListen]: false, [FLAG.meetingCapture]: true });
    expect(startDecision(g, { meetingActive: true })).toEqual({ ok: false, error: LISTEN_OFF });
  });
});

describe('a session that is already running', () => {
  it('keeps meeting capture for a call session after the flag turns off, and drops it once the session is over', () => {
    const off = gates({ [FLAG.meetingCapture]: false });
    expect(sessionGates(off, { callSession: true }).meetingCapture).toBe(true);
    expect(keepActions(sessionGates(off, { callSession: true }), { solo: false })).toMatchObject({ softStop: true, optOut: true });
    expect(sessionGates(off, { callSession: false }).meetingCapture).toBe(false);
  });

  it('leaves the other flags as they are for a running session', () => {
    const g = sessionGates(gates({ [FLAG.liveAssist]: false }), { callSession: true });
    expect(g.liveAssist).toBe(false);
    expect(g.manualListen).toBe(true);
  });
});

describe('what a final line does', () => {
  it('skips the STOP check, the opt-out match and suggestions in a solo note with the notetaker flags off', () => {
    expect(keepActions(gates(), { solo: true })).toEqual({ optOut: false, softStop: false, suggest: false });
  });

  it('runs the STOP check and the opt-out match only on a noticed call with meeting capture on', () => {
    const g = gates({ [FLAG.meetingCapture]: true });
    expect(keepActions(g, { solo: false })).toMatchObject({ optOut: true, softStop: true });
    expect(keepActions(g, { solo: true })).toMatchObject({ optOut: false, softStop: false });
  });

  it('offers suggestions only with live assistance on', () => {
    expect(keepActions(gates({ [FLAG.liveAssist]: true }), { solo: true }).suggest).toBe(true);
  });
});

describe('vocabulary and flag changes', () => {
  it('matches calendar invitees only for a noticed call and reads the screen with its own flag', () => {
    expect(termsPlan(gates(), { calendar: true })).toEqual({ invitees: false, screen: true });
    expect(termsPlan(gates({ [FLAG.meetingCapture]: true }), { calendar: true })).toEqual({ invitees: true, screen: true });
    expect(termsPlan(gates({ [FLAG.meetingCapture]: true }), { calendar: false })).toEqual({ invitees: false, screen: true });
    expect(termsPlan(gates({ [FLAG.screenContext]: false }), { calendar: false }).screen).toBe(false);
  });

  it('follows a flag change from the relay on the next read, with no restart', async () => {
    const settings = {};
    let answer = { 'meeting-capture': false, 'live-assist': false, 'manual-listen': true, 'screen-context': true };
    const fetchImpl = async () => ({ ok: true, json: async () => ({ flags: answer }) });
    const flags = createFlags({ settings, env: { QUORUM_RELAY_URL: 'https://relay.example.com' }, fetchImpl, timers: { set: () => null, clear: () => {} } });
    await flags.refresh();
    expect(notetakerGates(flags.all()).meetingCapture).toBe(false);
    answer = { ...answer, 'meeting-capture': true };
    await flags.refresh();
    expect(notetakerGates(flags.all()).meetingCapture).toBe(true);
    answer = { ...answer, 'manual-listen': false };
    await flags.refresh();
    const g = notetakerGates(flags.all());
    expect(g.meetingCapture).toBe(false);
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
