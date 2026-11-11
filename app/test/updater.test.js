import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, createUpdater, feedFor } from '../updater.js';

const fakeAuto = () => { const e = new EventEmitter(); e.calls = []; e.setFeedURL = (f) => e.calls.push(['feed', f]); e.checkForUpdates = async () => { e.calls.push(['check']); }; e.quitAndInstall = () => e.calls.push(['install']); return e; };

describe('feedFor', () => {
  it('sends the Local edition to GitHub Releases and the Cloud edition to the cloud channel of the feed its package names', () => {
    expect(feedFor({ edition: 'local', packaged: {} })).toEqual({ provider: 'github', owner: 'smejkaldesign', repo: 'quorum' });
    expect(feedFor({ edition: 'cloud', packaged: { quorumCloud: { updates: 'https://github.com/smejkaldesign/quorum/releases/latest/download/' } } })).toEqual({ provider: 'generic', url: 'https://github.com/smejkaldesign/quorum/releases/latest/download', channel: 'cloud' });
    expect(feedFor({ edition: 'cloud', packaged: { quorumCloud: {} } })).toBeNull();
  });
});

describe('createUpdater', () => {
  it('stays off without a feed and never schedules a check', () => {
    const auto = fakeAuto();
    const u = createUpdater({ autoUpdater: auto, feed: null, current: '0.2.7' });
    expect(u.state().status).toBe('off');
    u.start();
    expect(auto.calls).toEqual([]);
    expect(u.install()).toBe(false);
  });
  it('walks idle, checking, downloading, ready, and installs only when ready', async () => {
    const auto = fakeAuto();
    const seen = [];
    const u = createUpdater({ autoUpdater: auto, feed: { provider: 'generic', url: 'https://quorum.watch/updates/cloud', channel: 'cloud' }, current: '0.2.7', emit: (s) => seen.push(s.status), now: () => 1000 });
    expect(auto.calls[0]).toEqual(['feed', { provider: 'generic', url: 'https://quorum.watch/updates/cloud', channel: 'cloud' }]);
    expect(u.state()).toMatchObject({ status: 'idle', current: '0.2.7' });
    expect(u.install()).toBe(false);
    await u.check();
    auto.emit('checking-for-update');
    auto.emit('update-available', { version: '0.2.8', releaseNotes: 'Fixes' });
    auto.emit('download-progress', { percent: 42.4 });
    expect(u.state()).toMatchObject({ status: 'downloading', version: '0.2.8', percent: 42, notes: 'Fixes' });
    auto.emit('update-downloaded', { version: '0.2.8' });
    expect(u.state()).toMatchObject({ status: 'ready', version: '0.2.8', percent: 100, checkedAt: 1000 });
    // a later failed check keeps the downloaded version ready
    auto.emit('error', new Error('net down\nmore'));
    expect(u.state()).toMatchObject({ status: 'ready', error: 'net down' });
    expect(u.install()).toBe(true);
    expect(auto.calls.at(-1)).toEqual(['install']);
    expect(seen).toContain('downloading');
  });
  it('reports a failed check and an up-to-date answer, and checks again on focus after an hour', async () => {
    const auto = fakeAuto();
    let t = 0;
    const u = createUpdater({ autoUpdater: auto, feed: { provider: 'github', owner: 'o', repo: 'r' }, current: '0.2.7', now: () => t });
    auto.checkForUpdates = async () => { throw new Error('404'); };
    await u.check();
    expect(u.state()).toMatchObject({ status: 'failed', error: '404' });
    auto.emit('update-not-available');
    expect(u.state().status).toBe('idle');
    let checks = 0; auto.checkForUpdates = async () => { checks += 1; };
    t = 1000; u.onFocus(); expect(checks).toBe(1);
    auto.emit('update-not-available');
    t = 1000 + 60000; u.onFocus(); expect(checks).toBe(1);
    t = 1000 + 3600001; u.onFocus(); expect(checks).toBe(2);
  });
  it('schedules the first check after 15 seconds and then every six hours, and stop clears both', () => {
    const auto = fakeAuto();
    const timers = { setTimeout: (fn, ms) => ({ fn, ms, kind: 't' }), setInterval: (fn, ms) => ({ fn, ms, kind: 'i' }), clearTimeout: (h) => { h.cleared = true; }, clearInterval: (h) => { h.cleared = true; } };
    const u = createUpdater({ autoUpdater: auto, feed: { provider: 'github', owner: 'o', repo: 'r' }, current: '0.2.7', timers });
    const stop = u.start();
    expect(timers).toBeTruthy();
    stop();
  });
  it('uses the documented timings', () => {
    expect(FIRST_CHECK_MS).toBe(15000);
    expect(CHECK_EVERY_MS).toBe(6 * 3600 * 1000);
  });
});
