import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holdFailed, lastFailures } from '../fixFailures.js';
import { newLinksCheck, rollback } from '../fixJournal.js';
import { holdsLink } from '../src/fixToast';
import { createResolver } from '../linkparse.js';

// Memory health fix runs (issue 189): a failed fix ends its working state and waits, Stop puts back what the attempt
// wrote, and a fix that would leave a new dead link fails before it writes
const fix = (key, status, extra = {}) => ({ id: `fix:${key}:${extra.queuedAt ?? 1}`, key, target: key, status, queuedAt: 1, endedAt: status === 'queued' || status === 'running' ? null : 2, error: null, ...extra });
// a link the agent fixes on Approve runs as a batch of one, under the batch's own key
const batchOf = (key, status, item = {}, extra = {}) => ({ id: `batch:${extra.queuedAt ?? 1}`, key: `batch:${extra.queuedAt ?? 1}`, kind: 'batch', target: '1 memory fix', status, queuedAt: 1, endedAt: 2, error: null, items: [{ id: `r:link:${key}`, kind: 'link', key, title: key, line: key, status: item.status ?? status, error: item.error ?? null, ...item }], ...extra });

describe('the last fix of each item', () => {
  it('holds the batch item of one approved link, so its working state ends when the batch ends', () => {
    const run = batchOf('orbit', 'error', { error: 'The fix left a new broken link to “orbit-part-1” in 05-knowledge/orbit.md' }, { error: 'The fix left a new broken link' });
    expect(holdsLink(run, 'Orbit')).toBe(true);
    expect(holdsLink(run, 'other')).toBe(false);
    expect(lastFailures([run]).get('r:link:orbit')).toEqual({ run: 'batch:1', key: 'orbit', error: 'The fix left a new broken link to “orbit-part-1” in 05-knowledge/orbit.md', cancelled: false });
  });

  it('clears a failure once a later run is working or fixed it', () => {
    const failed = fix('orbit', 'error', { error: 'It broke', queuedAt: 1 });
    expect(lastFailures([failed, fix('orbit', 'running', { queuedAt: 5 })]).has('r:link:orbit')).toBe(false);
    expect(lastFailures([fix('orbit', 'success', { queuedAt: 5 }), failed]).has('r:link:orbit')).toBe(false);
    expect(lastFailures([failed, fix('orbit', 'error', { error: 'Again', queuedAt: 5 })]).get('r:link:orbit').error).toBe('Again');
  });

  it('reads an item put back by the whole batch with the batch reason, and ignores an undone run', () => {
    const run = batchOf('orbit', 'error', { status: 'error', rolledBack: true }, { error: 'Another item failed' });
    expect(lastFailures([run]).get('r:link:orbit').error).toBe('Another item failed');
    expect(lastFailures([{ ...run, undoneAt: 3 }]).size).toBe(0);
  });

  it('marks a cancelled fix as cancelled', () => {
    expect(lastFailures([fix('orbit', 'error', { error: 'You cancelled the fix', cancelled: true })]).get('r:link:orbit')).toMatchObject({ cancelled: true, error: 'You cancelled the fix' });
  });
});

describe('no automatic retry loop', () => {
  it('leaves an item whose last fix failed out of the fixes Quorum applies on its own', () => {
    const items = [{ id: 'r:link:orbit' }, { id: 'r:link:atlas' }, { id: 'r:find:rule:x' }];
    const runs = [fix('orbit', 'error', { error: 'It broke' }), fix('atlas', 'success'), batchOf('ignored', 'success')];
    expect(holdFailed(items, runs).map((i) => i.id)).toEqual(['r:link:atlas', 'r:find:rule:x']);
    // the same item failing again stays held; only the person's Approve runs it once more
    expect(holdFailed(items, [...runs, fix('orbit', 'error', { error: 'It broke', queuedAt: 9 })]).map((i) => i.id)).not.toContain('r:link:orbit');
  });
});

let vault;
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });
const put = (rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };

describe('Stop on a running fix', () => {
  it('puts back every note the attempt wrote before it stopped', async () => {
    vault = mkdtempSync('/tmp/qfix-cancel-');
    put('a.md', 'see [[orbit]]');
    // the attempt kept a.md and wrote it, made a new note, then Stop ended it before its next step
    const kept = [{ rel: 'a.md', before: 'see [[orbit]]', after: null }, { rel: 'p/orbit.md', before: null, after: null }];
    put('a.md', 'see [[p/orbit]]');
    put('p/orbit.md', 'half written');
    const res = await rollback(vault, kept, async (abs) => rmSync(abs));
    expect(res.restored.sort()).toEqual(['a.md', 'p/orbit.md']);
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('see [[orbit]]');
  });
});

describe('the link check before a fix writes a note', () => {
  const resolve = createResolver(['05-knowledge/atlas.md', 'people/ada.md'], () => []);
  it('fails a draft that links to a note that does not exist', () => {
    expect(newLinksCheck({ text: 'Orbit builds on [[atlas]] and [[orbit-part-1]].\n', rel: '05-knowledge/orbit.md', resolve }))
      .toBe('The fix would leave a new broken link to “orbit-part-1” in 05-knowledge/orbit.md, so Quorum did not write it');
    expect(newLinksCheck({ text: 'See [the plan](plans/orbit-plan.md).\n', rel: '05-knowledge/orbit.md', resolve })).toMatch('“plans/orbit-plan”');
  });
  it('passes a draft whose links open notes in the vault or the note itself', () => {
    expect(newLinksCheck({ text: '---\ntags: [x]\n---\nWith [[ada]], [[05-knowledge/atlas|Atlas]], [[orbit#Goals]] and https://example.com.\n', rel: '05-knowledge/orbit.md', resolve })).toBeNull();
  });
});
