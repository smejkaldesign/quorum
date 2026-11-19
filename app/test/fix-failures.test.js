import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchCancelled, cancelError, cancelRuns, endFailed, holdFailed, lastFailures } from '../fixFailures.js';
import { newLinksCheck, rollback, writeCheckedNote } from '../fixJournal.js';
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
    expect(lastFailures([run]).get('r:link:orbit')).toEqual({ run: 'batch:1', key: 'orbit', error: 'The fix left a new broken link to “orbit-part-1” in 05-knowledge/orbit.md', cancelled: false, own: true });
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
  it('lets an item run again that was only put back because another item in its batch failed', () => {
    const run = { ...batchOf('orbit', 'error', { status: 'error', error: 'It broke' }, { error: 'It broke' }), items: [
      { id: 'r:link:orbit', kind: 'link', key: 'orbit', title: 'orbit', line: 'orbit', status: 'error', error: 'It broke' },
      { id: 'r:link:atlas', kind: 'link', key: 'atlas', title: 'atlas', line: 'atlas', status: 'error', rolledBack: true },
    ] };
    expect(holdFailed([{ id: 'r:link:orbit' }, { id: 'r:link:atlas' }], [run]).map((i) => i.id)).toEqual(['r:link:atlas']);
    // the row still says why it was put back
    expect(lastFailures([run]).get('r:link:atlas')).toMatchObject({ error: 'It broke', own: false });
  });
});

let vault;
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });
const put = (rel, t) => { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), t); };

describe('Stop and Cancel', () => {
  // a bulk Approve of two plain link fixes: both share the b: batch id and have no kind
  const bulkRuns = () => [fix('orbit', 'running', { batch: 'b:7', queuedAt: 1 }), fix('atlas', 'queued', { batch: 'b:7', queuedAt: 2 }), fix('other', 'queued', { queuedAt: 3 })];

  it('cancels a bulk Approve as a batch, so its banner reads Cancelled', () => {
    const runs = bulkRuns();
    const queue = [runs[1], runs[2]];
    const ended = [];
    expect(cancelRuns(runs, 'b:7', { queue, ended: (r) => ended.push(r.id), now: () => 9 })).toBe(2);
    expect(runs[1]).toMatchObject({ status: 'error', error: 'You cancelled the batch', cancelled: true, endedAt: 9 });
    expect(queue).toEqual([runs[2]]);
    expect(ended).toEqual([runs[1].id]);
    // the running one stops at its next step; its catch marks it cancelled
    expect(runs[0].cancel).toBe(true);
    endFailed(runs[0], cancelError(runs[0]));
    expect(runs[0]).toMatchObject({ status: 'error', error: 'You cancelled the batch', cancelled: true });
    expect(batchCancelled(runs.slice(0, 2))).toBe(true);
    expect(runs[2].status).toBe('queued');
  });

  it('stops one fix by its run id and leaves the rest of its batch', () => {
    const runs = bulkRuns();
    expect(cancelRuns(runs, runs[1].id, { queue: [runs[1]], by: 'Claude Code' })).toBe(1);
    expect(runs[1]).toMatchObject({ cancelled: true, cancelBy: 'Claude Code' });
    expect(runs[0].cancel).toBeUndefined();
    const one = fix('solo', 'queued');
    cancelRuns([one], one.id, { queue: [one] });
    expect(one.error).toBe('You cancelled the fix');
  });

  it('marks an agent stopped mid-draft as cancelled, and a plain failure as failed', () => {
    expect(endFailed(fix('orbit', 'running'), cancelError(fix('orbit', 'running'))).cancelled).toBe(true);
    expect(endFailed(fix('orbit', 'running'), new Error('It broke'))).toMatchObject({ status: 'error', error: 'It broke' });
    expect(endFailed(fix('orbit', 'running'), new Error('It broke')).cancelled).toBeUndefined();
  });

  it('puts back every note the attempt wrote before it stopped', async () => {
    vault = mkdtempSync('/tmp/qfix-cancel-');
    put('a.md', 'see [[orbit]]');
    const kept = [{ rel: 'a.md', before: 'see [[orbit]]', after: null }, { rel: 'p/orbit.md', before: null, after: null }];
    put('a.md', 'see [[p/orbit]]');
    put('p/orbit.md', 'half written');
    const run = fix('orbit', 'running');
    cancelRuns([run], run.id);
    endFailed(run, cancelError(run));
    const res = await rollback(vault, kept, async (abs) => rmSync(abs));
    expect(run.cancelled).toBe(true);
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

describe('writing a missing note from a draft', () => {
  const resolve = createResolver(['05-knowledge/atlas.md'], () => []);
  it('writes nothing when the draft links to a note that does not exist', async () => {
    vault = mkdtempSync('/tmp/qfix-draft-');
    mkdirSync(path.join(vault, '05-knowledge'));
    const keep = [];
    const before = [];
    await expect(writeCheckedNote({ vault, folder: '05-knowledge', name: 'orbit', text: 'See [[atlas]] and [[orbit-part-1]].\n', resolve, keep: (rel) => keep.push(rel), before: async () => before.push(1) }))
      .rejects.toThrow('The fix would leave a new broken link to “orbit-part-1” in 05-knowledge/orbit.md, so Quorum did not write it');
    expect(existsSync(path.join(vault, '05-knowledge/orbit.md'))).toBe(false);
    expect(keep).toEqual([]);
    expect(before).toEqual([]);
  });
  it('writes the note when every link opens a note', async () => {
    vault = mkdtempSync('/tmp/qfix-draft-');
    mkdirSync(path.join(vault, '05-knowledge'));
    const keep = [];
    const rel = await writeCheckedNote({ vault, folder: '05-knowledge', name: 'orbit', text: 'See [[atlas]].\n', resolve, keep: (r, made) => keep.push([r, made]) });
    expect(rel).toBe('05-knowledge/orbit.md');
    expect(keep).toEqual([['05-knowledge/orbit.md', true]]);
    expect(readFileSync(path.join(vault, rel), 'utf8')).toBe('See [[atlas]].\n');
  });
});
