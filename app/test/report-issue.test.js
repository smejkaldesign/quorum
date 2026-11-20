import { describe, expect, it } from 'vitest';
import { MAX_SHOTS, addShots, shotsTotal, crashReport, dataUrlBytes, generatedDescription, initialDraft, pageLabel, reportPreview, reportTitle } from '../src/issueReport';

const prep = { install: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b', version: '0.4.3', edition: 'local', os: 'macOS 26.4 arm64', view: 'settings/memory', runId: 'run_7', message: 'Fix failed: <note>.md is gone', lines: [], linesWithPaths: [], screenshot: null, account: null };

describe('pageLabel', () => {
  it('reads view ids the way people name pages', () => {
    expect(pageLabel('settings/memory')).toBe('Settings, Memory');
    expect(pageLabel('main/home')).toBe('Home');
    expect(pageLabel('settings/link-health')).toBe('Settings, Link health');
    expect(pageLabel('')).toBe('Quorum');
    expect(pageLabel('root')).toBe('Quorum');
  });
});

describe('the generated description', () => {
  it('says what the person was doing, the error, what was on screen and the steps', () => {
    const d = generatedDescription({ view: 'settings/memory', doing: 'Running the fix on a dead-link item in Memory health.', screen: [{ label: 'Item', value: 'Dead link' }, { label: 'Last fix failed', value: 'timeout' }, { label: 'Empty', value: ' ' }], steps: ['Open Memory health.', 'Press Fix.'] }, 'Fix failed');
    expect(d).toBe([
      'What I was doing: Running the fix on a dead-link item in Memory health.', '', 'Error: Fix failed', '',
      'On screen:', '- Item: Dead link', '- Last fix failed: timeout', '', 'Steps:', '1. Open Memory health.', '2. Press Fix.', '', 'What I expected: ',
    ].join('\n'));
  });
  it('falls back to the page and empty steps', () => {
    const d = generatedDescription({ view: 'main/home' }, '');
    expect(d.startsWith('What I was doing: Using the Home page.')).toBe(true);
    expect(d).not.toContain('Error:');
    expect(d).toContain('1. \n2. ');
  });
});

describe('initialDraft', () => {
  it('writes the title and description from an error context with the masked message', () => {
    const d = initialDraft({ context: { view: 'settings/memory', error: '/Volumes/Work/vault/Plan.md is gone' } }, prep);
    expect(d.title).toBe('Settings, Memory: Fix failed: <note>.md is gone');
    expect(d.description).toContain('Error: Fix failed: <note>.md is gone');
    expect(d.description).not.toContain('/Volumes/Work');
  });
  it('keeps a caller title and description, and starts blank from the menu', () => {
    expect(initialDraft({ title: 'T', description: 'D', context: { error: 'x' } }, prep)).toEqual({ title: 'T', description: 'D' });
    expect(initialDraft({ context: { view: 'main/home' } }, { ...prep, message: '' })).toEqual({ title: '', description: '' });
  });
  it('cuts a long title', () => {
    expect(reportTitle({ view: 'main/home' }, 'x'.repeat(400)).length).toBe(200);
  });
});

describe('screenshots', () => {
  it('drops duplicates and keeps at most five', () => {
    const r = addShots(['a', 'b'], ['b', 'c', 'd', 'e', 'f', 'g']);
    expect(r.shots).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.shots.length).toBe(MAX_SHOTS);
    expect(r.dropped).toBe(2);
  });
  it('adds the screenshots up in bytes', () => {
    expect(shotsTotal([`data:image/png;base64,${Buffer.alloc(10).toString('base64')}`, `data:image/png;base64,${Buffer.alloc(5).toString('base64')}`])).toBe(15);
  });
  it('measures a data URL in bytes', () => {
    expect(dataUrlBytes(`data:image/png;base64,${Buffer.alloc(10).toString('base64')}`)).toBe(10);
    expect(dataUrlBytes(`data:image/png;base64,${Buffer.alloc(11).toString('base64')}`)).toBe(11);
  });
});

describe('reportPreview', () => {
  const draft = { at: '2026-11-19T12:00:00.000Z', view: 'settings/memory', title: 'T', description: 'D', logLines: ['l1', 'l2'], runId: 'run_7', screenshots: ['s'], attachAccount: true };
  it('shows every field that goes out', () => {
    const p = reportPreview(draft, { ...prep, account: { email: 'sam@example.com' } });
    expect(p).toContain('App: Quorum 0.4.3 (local edition)');
    expect(p).toContain('Page: settings/memory');
    expect(p).toContain('Run: run_7');
    expect(p).toContain('Account: sam@example.com');
    expect(p).toContain('Screenshots: 1');
    expect(p).toContain('Install: 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b (an anonymous id for this Mac; the server keeps only a hash of it)');
    expect(p).toContain('Time: 2026-11-19T12:00:00.000Z');
    expect(p.endsWith('Log lines (2):\nl1\nl2')).toBe(true);
  });
  it('says the account is not attached when the person turned it off or is signed out', () => {
    expect(reportPreview({ ...draft, attachAccount: false }, { ...prep, account: { email: 'sam@example.com' } })).toContain('Account: not attached');
    expect(reportPreview(draft, prep)).toContain('Account: not attached');
  });
});

describe('crashReport', () => {
  it('captures the window and adds the reload step for a page that fails every time', () => {
    const c = crashReport('settings/memory', { message: 'boom' }, 'repeat');
    expect(c).toMatchObject({ view: 'settings/memory', error: 'boom', capture: true, action: 'render crash' });
    expect(c.steps).toEqual(['Open Settings, Memory.', 'Press Reload view; the page fails again.']);
    expect(crashReport('main/home', { message: 'x' }, 'once').steps).toEqual(['Open Home.']);
  });
});
