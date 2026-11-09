// Smoke tests for the hosted edition's push-only sync filters (ee/sync.js) against a real vault on disk. The Supabase
// client is a recorder that keeps every upsert. HOME points at a temp folder before the module loads, so the
// sync-ids.json it keeps stays out of the real Application Support folder.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-sync-home-'));
process.env.HOME = home;
const { createSync } = await import('../ee/sync.js');

const NOTE = '---\ntitle: Hello\n---\n# Hello\n\nBody line.\n';
// sha256 of NOTE, computed with shasum outside the module under test
const NOTE_SHA256 = 'dab41e660297bad8e9eeb601f50a1f825f39ec7075cf81821450cbc682d83816';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const vaults = [];

// a vault with the given files, a sync wired to a recording client, and a workspace id unique to this harness so the
// persisted id/hash table never carries state between tests
function harness({ files, isExcluded, isExcludedText }) {
  const vault = mkdtempSync(path.join(tmpdir(), 'quorum-vault-'));
  vaults.push(vault);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
  }
  const calls = [];
  const client = { from: (table) => ({ upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return { error: null }; } }) };
  const marks = [];
  const state = { sync: true, signedIn: true, workspace: { id: `ws-${path.basename(vault)}` }, userId: 'user-1', lastSyncAt: null, syncError: null };
  const account = { state: () => state, client: () => client, markSync: (patch) => { marks.push(patch); Object.assign(state, patch); } };
  const sync = createSync({ account, store: { meetings: { root: path.join(vault, '.sessions') } }, brain: () => ({ vault }), isExcluded, isExcludedText });
  return { vault, state, calls, marks, sync, abs: (rel) => path.join(vault, rel) };
}

afterAll(() => {
  for (const v of vaults) rmSync(v, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('sync filters', () => {
  it('skips a note whose path isExcluded flags', async () => {
    const h = harness({ files: { 'private/secret.md': NOTE, 'notes/open.md': NOTE }, isExcluded: (rel) => rel.startsWith('private/') });
    expect(await h.sync.pushNote(h.abs('private/secret.md'))).toBe(false);
    expect(h.calls).toHaveLength(0);
    const result = await h.sync.syncNow();
    expect(result).toEqual({ pushed: 1, skipped: 0, meetings: 0 });
    expect(h.calls.map((c) => c.table)).toEqual(['notes']);
    expect(h.calls[0].rows.map((r) => r.path)).toEqual(['notes/open.md']);
  });

  it('skips a note whose text isExcludedText flags', async () => {
    const h = harness({ files: { 'notes/client.md': '# Acme Corp call\n\nNotes.\n' }, isExcludedText: (text) => text.includes('Acme Corp') });
    expect(await h.sync.pushNote(h.abs('notes/client.md'))).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(await h.sync.syncNow()).toEqual({ pushed: 0, skipped: 1, meetings: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it('skips an unchanged note on the second syncNow and pushes it again once edited', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    expect(await h.sync.syncNow()).toEqual({ pushed: 1, skipped: 0, meetings: 0 });
    expect(h.calls).toHaveLength(1);
    expect(await h.sync.syncNow()).toEqual({ pushed: 0, skipped: 1, meetings: 0 });
    expect(h.calls).toHaveLength(1);
    writeFileSync(h.abs('notes/hello.md'), `${NOTE}\nMore.\n`);
    expect(await h.sync.syncNow()).toEqual({ pushed: 1, skipped: 0, meetings: 0 });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].rows[0].id).toBe(h.calls[0].rows[0].id);
    expect(h.calls[1].rows[0].hash).not.toBe(h.calls[0].rows[0].hash);
  });

  it('skips a note with confidential: in its frontmatter when isExcludedText flags it', async () => {
    const confidential = '---\ntitle: Payroll\nconfidential: personal\n---\n# Payroll\n';
    const h = harness({
      files: { 'notes/payroll.md': confidential, 'notes/hello.md': NOTE },
      isExcludedText: (text) => /^---\n[\s\S]*?^confidential:/m.test(text),
    });
    expect(await h.sync.pushNote(h.abs('notes/payroll.md'))).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(await h.sync.syncNow()).toEqual({ pushed: 1, skipped: 1, meetings: 0 });
    expect(h.calls[0].rows.map((r) => r.path)).toEqual(['notes/hello.md']);
  });

  it('pushes a normal note once with the expected fields', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    expect(await h.sync.pushNote(h.abs('notes/hello.md'))).toBe(true);
    expect(h.calls).toHaveLength(1);
    const { table, rows, opts } = h.calls[0];
    expect(table).toBe('notes');
    expect(opts).toEqual({ onConflict: 'id' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.path).toBe('notes/hello.md');
    expect(row.body).toBe(NOTE);
    expect(row.hash).toBe(NOTE_SHA256);
    expect(row.frontmatter).toEqual({ title: 'Hello' });
    expect(row.workspace_id).toBe(h.state.workspace.id);
    expect(row.user_id).toBe('user-1');
    expect(row.id).toMatch(ULID);
    expect(Number.isNaN(Date.parse(row.mtime))).toBe(false);
    expect(Number.isNaN(Date.parse(row.updated_at))).toBe(false);
    expect(h.marks.at(-1)).toMatchObject({ syncError: null });
    expect(typeof h.marks.at(-1).lastSyncAt).toBe('string');
    // a second explicit push keeps the same id, so the remote row is upserted in place
    expect(await h.sync.pushNote(h.abs('notes/hello.md'))).toBe(true);
    expect(h.calls[1].rows[0].id).toBe(row.id);
  });

  it('pushes a private meeting note as a note and a meetings row, with no transcript segments', async () => {
    const meeting = '---\ntitle: Standup\ndate: 2026-11-08T15:00:00Z\nparticipants:\n  - Ana\n  - Ben\nvisibility: private\nquorum_id: abc123\n---\n# Standup\n';
    const h = harness({ files: { 'meetings/standup.md': meeting } });
    expect(await h.sync.pushMeetingNote(h.abs('meetings/standup.md'))).toBe(true);
    expect(h.calls.map((c) => c.table)).toEqual(['notes', 'meetings']);
    const m = h.calls[1].rows[0];
    expect(m).toMatchObject({ title: 'Standup', visibility: 'private', participants: ['Ana', 'Ben'], ended_at: null });
    expect(m.started_at).toBe('2026-11-08T15:00:00.000Z');
    expect(m.note_id).toBe(h.calls[0].rows[0].id);
    expect(m.id).toMatch(ULID);
  });

  it('does nothing while sync is off', async () => {
    const h = harness({ files: { 'notes/hello.md': NOTE } });
    h.state.sync = false;
    expect(await h.sync.pushNote(h.abs('notes/hello.md'))).toBe(false);
    expect(await h.sync.syncNow()).toEqual({ error: 'Sync is off or no workspace is chosen.' });
    expect(h.calls).toHaveLength(0);
  });
});
