import { describe, expect, it } from 'vitest';
import { LIMITS, createIssueReports, createLogTail, encodeCapture, maskLine, maskNotes, pickLines, reportBody } from '../issueReports.js';

const HOME = '/Users/sam';
const APP = '/Applications/Quorum.app/Contents/Resources/app.asar';
const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
// fake token shapes, built at run time so no token-looking literal sits in the file
const SK = `sk-${'x'.repeat(20)}`;
const GH = `${'gh'}p_${'y'.repeat(20)}`;
const at = () => new Date('2026-11-19T12:00:00Z');

describe('the log tail', () => {
  it('keeps the newest lines with their time and turns objects into text', () => {
    const t = createLogTail(3, at);
    t.push(['a']); t.push(['b', { run: 'r1' }]); t.push(['c', new Error('boom')]); t.push(['d']);
    expect(t.lines()).toEqual(['12:00:00 b {"run":"r1"}', '12:00:00 c boom', '12:00:00 d']);
  });
});

describe('masking', () => {
  it('masks note names in wiki links and .md file names', () => {
    expect(maskNotes('fix [[Quarterly plan]] in People/Sam Lee.md and notes.md')).toBe('fix [[<note>]] in <note>.md and <note>.md');
    expect(maskNotes('could not open "Sam Lee.md" (gone)')).toBe('could not open "<note>.md" (gone)');
  });
  it('masks paths, emails, tokens and note names by default', () => {
    const out = maskLine(`moved ${HOME}/vault/Projects/Plan.md for sam@example.com with ${SK}`, { home: HOME, appRoot: APP });
    expect(out).not.toContain('Plan');
    expect(out).not.toContain('sam@example.com');
    expect(out).not.toContain(SK);
    expect(out).toContain('<email>');
  });
  it('keeps paths and note names when asked and still masks emails and tokens', () => {
    const out = maskLine(`moved Projects/Plan.md for sam@example.com with ${GH}`, { keepPaths: true });
    expect(out).toContain('Projects/Plan.md');
    expect(out).toContain('<email>');
    expect(out).toContain('<token>');
  });
});

describe('pickLines', () => {
  const all = ['boot', 'memory: run r_42 started', 'sync ok', 'memory: run r_42 failed: timeout', 'tray'];
  it('picks the lines naming the run id or the action', () => {
    expect(pickLines(all, { runId: 'r_42' })).toEqual(['memory: run r_42 started', 'memory: run r_42 failed: timeout']);
    expect(pickLines(all, { action: 'sync' })).toEqual(['sync ok']);
  });
  it('falls back to the newest lines when nothing matches or no key is given', () => {
    expect(pickLines(all, { runId: 'zzz_9', max: 2 })).toEqual(['memory: run r_42 failed: timeout', 'tray']);
    expect(pickLines(all, { max: 1 })).toEqual(['tray']);
  });
});

describe('encodeCapture', () => {
  const img = ({ width = 1000, png = 100, jpg = 50, empty = false } = {}) => {
    const calls = [];
    const self = {
      isEmpty: () => empty, getSize: () => ({ width, height: 600 }),
      resize: (o) => { calls.push(o); return self; },
      toPNG: () => Buffer.alloc(png, 1), toJPEG: (q) => { calls.push({ q }); return Buffer.alloc(jpg, 2); },
    };
    return { self, calls };
  };
  it('returns a PNG data URL for a small window', () => {
    expect(encodeCapture(img().self)).toMatch(/^data:image\/png;base64,/);
  });
  it('scales a wide window down and falls back to JPEG over the limit', () => {
    const { self, calls } = img({ width: 3000, png: 200 });
    expect(encodeCapture(self, { maxBytes: 100 })).toMatch(/^data:image\/jpeg;base64,/);
    expect(calls[0]).toMatchObject({ width: 1600 });
  });
  it('gives null for an empty capture or one that never fits', () => {
    expect(encodeCapture(img({ empty: true }).self)).toBe(null);
    expect(encodeCapture(img({ png: 200, jpg: 200 }).self, { maxBytes: 100 })).toBe(null);
  });
});

describe('reportBody', () => {
  it('keeps the contract fields only and drops screenshots that are not PNG or JPEG data URLs', () => {
    const b = reportBody({ view: 'settings/memory<x>', title: ' T ', description: 'D', logLines: ['a', 5, 'b'], runId: 'r_1', screenshots: [PNG, 'data:image/gif;base64,R0lG', 'https://example.com/x.png'], attachAccount: true, extra: 'x' }, { install: INSTALL, edition: 'local', version: '0.4.3', os: 'macOS', now: at });
    expect(Object.keys(b).sort()).toEqual(['at', 'description', 'edition', 'install', 'logLines', 'os', 'runId', 'screenshots', 'title', 'version', 'view']);
    expect(b.view).toBe('settings/memoryx');
    expect(b.title).toBe('T');
    expect(b.logLines).toEqual(['a', 'b']);
    expect(b.screenshots).toEqual([{ data: PNG }]);
    expect(b.at).toBe('2026-11-19T12:00:00.000Z');
  });
  it('caps screenshots, lines and text at the relay limits', () => {
    const b = reportBody({ title: 't'.repeat(500), logLines: Array.from({ length: 90 }, (_, i) => `${i}`), screenshots: Array.from({ length: 8 }, (_, i) => `${PNG}${'A'.repeat(i)}`), runId: '../x' }, { install: INSTALL, edition: 'local', version: '', os: '', now: at });
    expect(b.title.length).toBe(LIMITS.title);
    expect(b.logLines.length).toBe(LIMITS.lines);
    expect(b.screenshots.length).toBe(LIMITS.shots);
    expect(b.runId).toBe(null);
  });
});

describe('createIssueReports', () => {
  const setup = ({ session = async () => null, answer = { status: 202, ok: true } } = {}) => {
    const tail = createLogTail(50, at);
    tail.push([`opened ${HOME}/vault/Plan.md`]); tail.push(['fix run_7 failed for sam@example.com']);
    const sent = [];
    const reports = createIssueReports({ installId: () => INSTALL, version: '0.4.3', edition: 'cloud', os: 'macOS 26.4 arm64', home: HOME, appRoot: APP, tail, session, now: at, send: async (body, headers) => { sent.push({ body: JSON.parse(body), headers }); return typeof answer === 'function' ? answer() : answer; } });
    return { reports, sent };
  };
  it('prepares masked lines, an unmasked copy, the masked message and no capture unless asked', async () => {
    let captured = 0;
    const { reports } = setup();
    const p = await reports.prepare({ view: 'settings/memory', runId: 'run_7', message: `ENOENT ${HOME}/vault/Plan.md` }, { capture: async () => { captured += 1; return PNG; } });
    expect(p.lines).toEqual(['12:00:00 fix run_7 failed for <email>']);
    expect(p.linesWithPaths).toEqual(['12:00:00 fix run_7 failed for <email>']);
    expect(p.message).not.toContain('Plan');
    expect(p.screenshot).toBe(null);
    expect(captured).toBe(0);
    const q = await reports.prepare({ capture: true }, { capture: async () => PNG });
    expect(q.screenshot).toBe(PNG);
    expect(q.lines.join('\n')).not.toContain('Plan');
    expect(q.linesWithPaths.join('\n')).toContain('Plan.md');
  });
  it('offers the account only when signed in, and sends the token only when the person keeps it attached', async () => {
    const { reports, sent } = setup({ session: async () => ({ token: 'tok', email: 'sam@example.com' }) });
    expect((await reports.prepare({})).account).toEqual({ email: 'sam@example.com' });
    expect(await reports.send({ title: 'T', attachAccount: false })).toEqual({ ok: true });
    expect(await reports.send({ title: 'T', attachAccount: true })).toEqual({ ok: true });
    expect(sent[0].headers.authorization).toBeUndefined();
    expect(sent[1].headers.authorization).toBe('Bearer tok');
    expect(sent[1].body.install).toBe(INSTALL);
  });
  it('refuses an empty report and passes the relay refusal on in plain words', async () => {
    const { reports, sent } = setup({ answer: { status: 400, ok: false, json: async () => ({ error: 'Screenshot 1 is not a PNG or JPEG image.' }) } });
    expect((await reports.send({ title: ' ', description: '' })).ok).toBe(false);
    expect(sent.length).toBe(0);
    expect(await reports.send({ title: 'T' })).toEqual({ ok: false, error: 'Screenshot 1 is not a PNG or JPEG image.' });
  });
  it('says the server could not be reached when the send throws', async () => {
    const { reports } = setup({ answer: () => { throw new Error('fetch failed'); } });
    expect((await reports.send({ title: 'T' })).error).toMatch(/could not reach/);
  });
});
