import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_EVERY, betaState, createBeta, gateOn, nextHeartbeatIn, normalizeCode, relayHttp } from '../beta.js';

const okFetch = (plan = 'free') => vi.fn(async (url) => ({ ok: true, json: async () => (url.endsWith('/v1/beta/check') ? { ok: true, plan } : { ok: true }) }));
const noFetch = (reason = 'That code was revoked.') => vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ ok: false, reason }) }));
const make = (over = {}) => {
  const settings = over.settings ?? {};
  const saveSettings = vi.fn();
  const fetchImpl = over.fetchImpl ?? okFetch();
  const beta = createBeta({ settings, saveSettings, on: over.on ?? true, edition: over.edition ?? 'local', version: '0.2.9', relay: 'https://relay.example.com', fetchImpl, email: () => over.email ?? null, timers: { set: setTimeout, clear: clearTimeout }, ...over.opts });
  return { beta, settings, saveSettings, fetchImpl };
};

describe('the build switch', () => {
  it('is on unless the package or the environment turns it off', () => {
    expect(gateOn({ env: {}, pkg: {} })).toBe(true);
    expect(gateOn({ env: {}, pkg: { quorumBetaGate: true } })).toBe(true);
    expect(gateOn({ env: {}, pkg: { quorumBetaGate: false } })).toBe(false);
    for (const v of ['0', 'false', 'off', 'no']) expect(gateOn({ env: { QUORUM_BETA_GATE: v }, pkg: {} })).toBe(false);
    expect(gateOn({ env: { QUORUM_BETA_GATE: '1' }, pkg: { quorumBetaGate: false } })).toBe(true);
  });

  it('reaches the relay over http: the public one, a local one on the local stack, or QUORUM_RELAY_URL', () => {
    expect(relayHttp({ env: {} })).toBe('https://relay.quorum.watch');
    expect(relayHttp({ env: {}, source: 'local' })).toBe('http://127.0.0.1:8787');
    expect(relayHttp({ env: { QUORUM_RELAY_URL: 'wss://relay.example.com/' } })).toBe('https://relay.example.com');
    expect(relayHttp({ env: { QUORUM_RELAY_URL: 'http://127.0.0.1:9999' }, source: 'production' })).toBe('http://127.0.0.1:9999');
  });
});

describe('the gate', () => {
  it('stands whenever the build has the gate and no code was accepted, onboarded or not', () => {
    expect(betaState({}, true).gate).toBe(true);
    expect(betaState({ onboarded: '2026-11-01T00:00:00.000Z' }, true).gate).toBe(true);
    expect(betaState({ beta: { code: 'ABCD-EFGH' } }, true).gate).toBe(false);
    expect(betaState({}, false).gate).toBe(false);
    expect(betaState({}, false).on).toBe(false);
  });

  it('normalizes what people type into XXXX-XXXX', () => {
    expect(normalizeCode(' abcd efgh ')).toBe('ABCD-EFGH');
    expect(normalizeCode('abcd-efgh')).toBe('ABCD-EFGH');
    expect(normalizeCode('abc')).toBe('ABC');
  });

  it('refuses a malformed code before asking the relay', async () => {
    const { beta, fetchImpl } = make();
    const r = await beta.check('abc');
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps an accepted code with its plan, a machine id and the edition and version it was checked with', async () => {
    const { beta, settings, saveSettings, fetchImpl } = make({ fetchImpl: okFetch('cloud'), edition: 'cloud', email: 'pat@example.com' });
    const r = await beta.check('abcd-efgh');
    expect(r).toMatchObject({ ok: true, plan: 'cloud' });
    expect(settings.beta.code).toBe('ABCD-EFGH');
    expect(settings.beta.plan).toBe('cloud');
    expect(settings.machineId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saveSettings).toHaveBeenCalled();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({ code: 'ABCD-EFGH', email: 'pat@example.com', machineId: settings.machineId, edition: 'cloud', version: '0.2.9' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://relay.example.com/v1/beta/check');
    expect(beta.status().gate).toBe(false);
    beta.stop();
  });

  it('passes the relay\'s reason through and stores nothing when the code is refused', async () => {
    const { beta, settings } = make({ fetchImpl: noFetch('That code was revoked.') });
    const r = await beta.check('ABCD-EFGH');
    expect(r).toEqual({ ok: false, reason: 'That code was revoked.' });
    expect(settings.beta).toBeUndefined();
    expect(beta.status().gate).toBe(true);
  });

  it('says the server could not be reached when fetch fails', async () => {
    const { beta } = make({ fetchImpl: vi.fn(async () => { throw new Error('fetch failed'); }) });
    const r = await beta.check('ABCD-EFGH');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not reach/);
  });

  it('keeps the same machine id across checks', async () => {
    const { beta, settings } = make();
    const first = beta.machineId();
    await beta.check('ABCD-EFGH');
    expect(settings.machineId).toBe(first);
    beta.stop();
  });
});

describe('the heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T08:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('is due at once with no record, and a day after the last one otherwise', () => {
    const now = Date.now();
    expect(nextHeartbeatIn(null, now)).toBe(0);
    expect(nextHeartbeatIn(now - 1000, now)).toBe(HEARTBEAT_EVERY - 1000);
    expect(nextHeartbeatIn(now - 2 * HEARTBEAT_EVERY, now)).toBe(0);
  });

  it('sends nothing before a code was accepted', async () => {
    const { beta, fetchImpl } = make();
    beta.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY + 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    beta.stop();
  });

  it('beats once on start and then once a day, recording the time of each', async () => {
    const { beta, settings, fetchImpl } = make({ settings: { beta: { code: 'ABCD-EFGH', plan: 'free' } } });
    beta.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://relay.example.com/v1/beta/heartbeat');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ code: 'ABCD-EFGH', version: '0.2.9', edition: 'local' });
    expect(settings.beta.lastHeartbeatAt).toBeGreaterThanOrEqual(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY - 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    beta.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits out the rest of the day when the last beat was recent, so a relaunch sends nothing extra', async () => {
    const { beta, fetchImpl } = make({ settings: { beta: { code: 'ABCD-EFGH', plan: 'free', lastHeartbeatAt: Date.now() - 60 * 60 * 1000 } } });
    beta.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    beta.stop();
  });

  it('starts the schedule once a code is accepted through the handler', async () => {
    const { beta, fetchImpl } = make();
    const r = await beta.handlers['beta-check']('ABCD-EFGH');
    expect(r.ok).toBe(true);
    expect(r.status.gate).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl.mock.calls.map((c) => c[0].split('/').pop())).toEqual(['check', 'heartbeat']);
    beta.stop();
  });

  it('stays quiet when the build has no gate', async () => {
    const { beta, fetchImpl } = make({ on: false, settings: { beta: { code: 'ABCD-EFGH' } } });
    beta.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_EVERY + 1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
