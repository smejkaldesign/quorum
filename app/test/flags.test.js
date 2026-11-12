import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, REFRESH_EVERY, cleanFlags, createFlags, describeFlags, parseEnvFlags, resolveFlags } from '../flags.js';

const okFetch = (flags) => vi.fn(async () => ({ ok: true, json: async () => ({ flags }) }));
const downFetch = () => vi.fn(async () => { throw new Error('fetch failed'); });
const make = (over = {}) => {
  const settings = over.settings ?? {};
  const saveSettings = vi.fn();
  const emitted = [];
  const fetchImpl = over.fetchImpl ?? okFetch({ 'meeting-capture': true, 'live-assist': false, 'manual-listen': true });
  const flags = createFlags({ settings, saveSettings, source: 'production', env: over.env ?? { QUORUM_RELAY_URL: 'https://relay.example.com' }, fetchImpl, emit: (s) => emitted.push(s), timers: { set: setTimeout, clear: clearTimeout } });
  return { flags, settings, saveSettings, fetchImpl, emitted };
};

describe('reading the environment', () => {
  it('parses QUORUM_FLAGS assignments and ignores what it cannot read', () => {
    expect(parseEnvFlags('meeting-capture=1,live-assist=0')).toEqual({ 'meeting-capture': true, 'live-assist': false });
    expect(parseEnvFlags(' Manual-Listen , dark-mode=maybe,=1')).toEqual({ 'manual-listen': true });
    expect(parseEnvFlags(undefined)).toEqual({});
  });

  it('keeps booleans only from a relay answer or a cache', () => {
    expect(cleanFlags({ a: true, b: 'true', c: 1, d: false })).toEqual({ a: true, d: false });
    expect(cleanFlags(null)).toEqual({});
  });
});

describe('precedence', () => {
  it('is env over relay over cache over defaults, per key', () => {
    const r = resolveFlags({ defaults: { a: false, b: false, c: false, d: true }, cache: { a: true, b: true, c: true }, relay: { a: true, b: false }, env: { QUORUM_FLAGS: 'a=0' } });
    expect(r).toEqual({ a: { enabled: false, source: 'env' }, b: { enabled: false, source: 'relay' }, c: { enabled: true, source: 'cache' }, d: { enabled: true, source: 'defaults' } });
  });

  it('lists a key the relay knows and this build does not, so a new flag is readable before the next release', () => {
    expect(resolveFlags({ defaults: {}, relay: { 'dark-mode': true } })['dark-mode']).toEqual({ enabled: true, source: 'relay' });
  });

  it('starts from the built-in defaults: capture and live assist off, manual listening on', () => {
    expect(DEFAULTS).toEqual({ 'meeting-capture': false, 'live-assist': false, 'manual-listen': true });
    const { flags } = make();
    expect(flags.get('manual-listen')).toBe(true);
    expect(flags.get('meeting-capture')).toBe(false);
    expect(flags.get('unknown')).toBe(false);
  });
});

describe('the relay', () => {
  it('refresh stores the answer, emits it, and the next read comes from the relay', async () => {
    const { flags, settings, saveSettings, emitted } = make();
    const r = await flags.refresh();
    expect(r.ok).toBe(true);
    expect(flags.get('meeting-capture')).toBe(true);
    expect(flags.all()['meeting-capture']).toEqual({ enabled: true, source: 'relay' });
    expect(settings.flags.cache).toEqual({ 'meeting-capture': true, 'live-assist': false, 'manual-listen': true });
    expect(saveSettings).toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it('a failed refresh keeps the cached copy from the last run', async () => {
    const { flags } = make({ fetchImpl: downFetch(), settings: { flags: { cache: { 'meeting-capture': true }, fetchedAt: 1 } } });
    const r = await flags.refresh();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Quorum could not reach the server.');
    expect(flags.all()['meeting-capture']).toEqual({ enabled: true, source: 'cache' });
    expect(flags.all()['manual-listen']).toEqual({ enabled: true, source: 'defaults' });
  });

  it('the env override wins over the relay answer', async () => {
    const { flags } = make({ env: { QUORUM_RELAY_URL: 'https://relay.example.com', QUORUM_FLAGS: 'meeting-capture=0' } });
    await flags.refresh();
    expect(flags.all()['meeting-capture']).toEqual({ enabled: false, source: 'env' });
  });

  it('the handlers answer the renderer with the state', async () => {
    const { flags } = make();
    const before = flags.handlers.flags();
    expect(before.flags['meeting-capture'].source).toBe('defaults');
    const after = await flags.handlers['flags-refresh']();
    expect(after.flags['meeting-capture']).toEqual({ enabled: true, source: 'relay' });
    expect(typeof after.fetchedAt).toBe('number');
  });

  it('reads one line at startup', () => {
    expect(describeFlags({ a: { enabled: true, source: 'defaults' }, b: { enabled: false, source: 'env' } })).toBe('a=on (defaults), b=off (env)');
  });
});

describe('the schedule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads at once on start and again every hour, and stop ends it', async () => {
    const { flags, fetchImpl } = make();
    flags.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    flags.stop();
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY * 2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('start twice runs one cycle', async () => {
    const { flags, fetchImpl } = make();
    flags.start(); flags.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(REFRESH_EVERY);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
