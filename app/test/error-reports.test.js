import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SourceMapGenerator } from 'source-map-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, createErrorReports, fingerprint, scrub, symbolicate } from '../errorReports.js';

const APP = '/Applications/Quorum.app/Contents/Resources/app.asar';
let dir;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-errors-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// a bundle line 1 column 101 that maps back to src/ConnectorsPage.tsx line 120 column 14
function map() {
  const g = new SourceMapGenerator({ file: 'index-abc.js' });
  g.addMapping({ generated: { line: 1, column: 100 }, original: { line: 120, column: 13 }, source: '../../src/ConnectorsPage.tsx', name: 'ConnectorsPage' });
  return g.toString();
}
const STACK = `TypeError: (0 , rn.fileURLToPath) is not a function\n    at Ab (file://${APP}/dist/assets/index-abc.js:1:101)\n    at file://${APP}/dist/assets/vendor.js:3:9`;

describe('scrub', () => {
  it('removes home paths, other paths, emails, tokens and long quoted text', () => {
    const s = scrub(`ENOENT /tmp/home-pat/notes/plan.md and /Volumes/Drive/x.md; mail pat@example.com; key sk-abcdefghijklmnopqrstu; said "the quarterly plan for the new launch is delayed again"`, { home: '/tmp/home-pat' });
    expect(s).not.toContain('/tmp/home-pat');
    expect(s).toContain('<path>');
    expect(s).toContain('~/notes/plan.md');
    expect(s).toContain('<email>');
    expect(s).toContain('<token>');
    expect(s).not.toContain('delayed again');
  });
  it('turns paths inside the app into app-relative paths', () => {
    expect(scrub(`at x (file://${APP}/dist/assets/a.js:1:2)`, { appRoot: APP })).toBe('at x (dist/assets/a.js:1:2)');
  });
});

describe('symbolicate', () => {
  it('maps a bundle frame back to its source file and line, and leaves frames without a map alone', () => {
    const out = symbolicate(STACK, { readMap: (file) => { if (file.endsWith('index-abc.js')) return map(); throw new Error('no map'); } });
    expect(out).toContain('at ConnectorsPage (src/ConnectorsPage.tsx:120:14)');
    expect(out).toContain('vendor.js:3:9');
  });
});

describe('fingerprint', () => {
  it('is the same for the same cause with different numbers, and differs by page', () => {
    const stack = '    at A (src/ConnectorsPage.tsx:120:14)';
    const a = fingerprint({ message: 'Cannot read 12 of undefined', stack, view: 'settings/connectors' });
    expect(fingerprint({ message: 'Cannot read 7 of undefined', stack, view: 'settings/connectors' })).toBe(a);
    expect(fingerprint({ message: 'Cannot read 7 of undefined', stack, view: 'main/home' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createErrorReports', () => {
  const make = (over = {}) => {
    const sent = [];
    const r = createErrorReports({ dataDir: dir, version: '0.4.2', edition: 'local', os: 'macOS 26.4 arm64', appRoot: APP, home: '/tmp/home-pat', send: async (b) => { sent.push(b); return { ok: true, status: 202 }; }, readMap: () => map(), now: () => new Date('2026-11-19T10:00:00Z'), ...over });
    return { r, sent };
  };
  it('sends a scrubbed, mapped report with a stable install id', async () => {
    const { r, sent } = make();
    await r.report({ view: 'settings/connectors', message: 'boom at /tmp/home-pat/x.md', stack: STACK, componentStack: '\n    at ConnectorsPage', repeat: false });
    expect(sent).toHaveLength(1);
    const b = sent[0];
    expect(b).toMatchObject({ edition: 'local', version: '0.4.2', os: 'macOS 26.4 arm64', view: 'settings/connectors', kind: 'render', repeat: false, at: '2026-11-19T10:00:00.000Z' });
    expect(b.message).toBe('boom at ~/x.md');
    expect(b.stack).toContain('src/ConnectorsPage.tsx:120:14');
    expect(b.install).toBe(readFileSync(path.join(dir, 'install-id'), 'utf8'));
    expect(make().r.build({ view: 'root', message: 'other' }).install).toBe(b.install);
  });
  it('sends a crash once per session, and its repeat once more', async () => {
    const { r, sent } = make();
    const crash = { view: 'main/home', message: 'x', stack: STACK };
    await r.report(crash);
    await r.report(crash);
    await r.report({ ...crash, repeat: true });
    await r.report({ ...crash, repeat: true });
    expect(sent.map((b) => b.repeat)).toEqual([false, true]);
  });
  it('sends nothing when reports are off, and survives a failed send', async () => {
    const off = make({ enabled: () => false });
    expect(await off.r.report({ view: 'root', message: 'x' })).toBe(false);
    expect(off.sent).toHaveLength(0);
    const down = make({ send: async () => { throw new Error('fetch failed'); } });
    expect(await down.r.report({ view: 'root', message: 'x' })).toBe(false);
  });
  it('caps every field', () => {
    const b = make().r.build({ view: 'v'.repeat(200), message: 'm'.repeat(5000), stack: 's'.repeat(20000), componentStack: 'c '.repeat(5000) });
    expect(b.message.length).toBeLessThanOrEqual(LIMITS.message);
    expect(b.stack.length).toBeLessThanOrEqual(LIMITS.stack);
    expect(b.componentStack.length).toBeLessThanOrEqual(LIMITS.componentStack);
    expect(b.view.length).toBeLessThanOrEqual(LIMITS.view);
  });
});
