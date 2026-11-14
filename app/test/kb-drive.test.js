// Google Drive files in a knowledge base folder (sources/drive.js, ee/kbDrive.js). Google's APIs and the database are
// fakes; the only sockets are the picker page's loopback server and the test's own requests to it.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-kbdrive-home-'));
process.env.HOME = home;
const { awaitPicker, cancelPicker, driveFile, driveText, pickerConfig, pickerPage, GOOGLE_DOC, LIMITED } = await import('../sources/drive.js');
const { createKbDrive, driveNoteText, noteFileName } = await import('../ee/kbDrive.js');
const { oauthClients } = await import('../sources/accounts.js');
const { parseFrontmatter } = await import('../ee/sync.js');
const { dropFalseConfidential, isConfidential } = await import('../ee/kbImport.js');

afterAll(() => rmSync(home, { recursive: true, force: true }));

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const MD_ID = '1MdFileIdForTestsOnly0123456789';
const TXT_ID = '1TxtFileIdForTestsOnly012345678';

// Drive's files.get, export and alt=media for a few files; every request is recorded
function fakeDrive(files = {}, { markdown = true, status = {} } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    expect(init.headers.authorization).toBe('Bearer tok');
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.split('/')[4] ?? '');
    const st = Array.isArray(status[id]) ? status[id].shift() : status[id];
    if (st) return new Response(JSON.stringify(st.body ?? {}), { status: st.code, headers: st.headers ?? {} });
    const f = files[id];
    if (!f) return new Response('{}', { status: 404 });
    if (u.pathname.endsWith('/export')) {
      const type = u.searchParams.get('mimeType');
      if (type === 'text/markdown' && !markdown) return new Response('{"error":{"errors":[{"reason":"badRequest"}]}}', { status: 400 });
      return new Response(type === 'text/markdown' ? f.markdown : f.plain);
    }
    if (u.searchParams.get('alt') === 'media') return new Response(f.content);
    return new Response(JSON.stringify({ id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime ?? '2026-11-01T10:00:00Z', webViewLink: f.url ?? null, trashed: !!f.trashed, size: f.size }));
  };
  return { fetch, calls };
}

const FILES = {
  [DOC_ID]: { name: 'Onboarding: week one', mimeType: GOOGLE_DOC, markdown: '# Week one\n\nMeet the team.', plain: 'Week one\n\nMeet the team.', url: `https://docs.google.com/document/d/${DOC_ID}/edit` },
  [MD_ID]: { name: 'runbook.md', mimeType: 'text/markdown', content: '---\ntitle: Runbook\n---\n# Runbook\n\nRestart the relay.', url: `https://drive.google.com/file/d/${MD_ID}/view` },
  [TXT_ID]: { name: 'notes.txt', mimeType: 'text/plain', content: 'plain words' },
};

describe('picker config', () => {
  it('reads the API key and takes the app id from the Google client id unless one is set', () => {
    expect(pickerConfig({ clientId: '247537775138-abc.apps.googleusercontent.com' })).toEqual({ apiKey: null, appId: '247537775138' });
    const lookup = (k) => ({ QUORUM_GOOGLE_PICKER_API_KEY: 'key-from-env', QUORUM_GOOGLE_PICKER_APP_ID: '42' })[k] ?? null;
    expect(pickerConfig({ lookup, clientId: '1-x' })).toEqual({ apiKey: 'key-from-env', appId: '42' });
    expect(pickerConfig({ packaged: { quorumOAuth: { googlePicker: { apiKey: 'packaged-key' } } }, clientId: '7-x' })).toEqual({ apiKey: 'packaged-key', appId: '7' });
    const clients = oauthClients({ env: { QUORUM_GOOGLE_CLIENT_ID: '99-y.apps.googleusercontent.com', QUORUM_GOOGLE_PICKER_API_KEY: 'k' } });
    expect(clients.googlePicker).toEqual({ apiKey: 'k', appId: '99' });
  });

  it('puts the values into the page so none can end the script', () => {
    const html = pickerPage({ apiKey: 'k', appId: '1', accessToken: 'a</script><b>', nonce: 'n' });
    expect(html).not.toContain('a</script><b>');
    expect(html).toContain('a\\u003c/script\\u003e\\u003cb\\u003e');
    expect(html).toContain('"done":"/picker/n/done"');
    expect(html).toContain('https://apis.google.com/js/api.js');
  });
});

describe('picker loopback', () => {
  const PORT = 47911;
  const origin = `http://127.0.0.1:${PORT}`;

  it('serves the page and resolves with the picked files the page posts back', async () => {
    let opened = null;
    const waiting = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async (u) => { opened = u; } });
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toMatch(new RegExp(`^${origin}/picker/[\\w-]+$`));
    const page = await fetch(opened);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('"token":"tok"');
    // another origin, or the wrong nonce, is not heard
    expect((await fetch(`${opened}/done`, { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${origin}/picker/wrong/done`, { method: 'POST', headers: { origin }, body: '{}' })).status).toBe(404);
    const docs = [{ id: DOC_ID, name: 'Onboarding', mimeType: GOOGLE_DOC }, { id: '../etc', name: 'bad' }];
    expect((await fetch(`${opened}/done`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'picked', docs }) })).status).toBe(204);
    await expect(waiting).resolves.toEqual({ files: [{ id: DOC_ID, name: 'Onboarding', mimeType: GOOGLE_DOC }] });
  });

  it('resolves as canceled when the person closes the picker or a new pick starts', async () => {
    let opened = null;
    const first = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async (u) => { opened = u; } });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${opened}/done`, { method: 'POST', headers: { origin }, body: '{"action":"cancel"}' });
    await expect(first).resolves.toEqual({ canceled: true });
    const a = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async () => {} });
    await new Promise((r) => setTimeout(r, 50));
    const b = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async (u) => { opened = u; } });
    await expect(a).resolves.toEqual({ canceled: true });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${opened}/done`, { method: 'POST', headers: { origin }, body: '{"action":"cancel"}' });
    await expect(b).resolves.toEqual({ canceled: true });
  });
});

describe('picker wait', () => {
  const PORT = 47912;
  it('ends when cancelPicker is called and frees the port at once', async () => {
    const waiting = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async () => {} });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelPicker()).toBe(true);
    await expect(waiting).resolves.toEqual({ canceled: true });
    expect(cancelPicker()).toBe(false);
    // the port is free again for the next pick
    const again = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, open: async () => {} });
    await new Promise((r) => setTimeout(r, 50));
    cancelPicker();
    await expect(again).resolves.toEqual({ canceled: true });
  });

  it('gives up on a tab that stops saying it is alive, and keeps waiting while it does', async () => {
    let opened = null;
    const waiting = awaitPicker({ apiKey: 'k', appId: '1', accessToken: 'tok', port: PORT, idleMs: 300, open: async (u) => { opened = u; } });
    await new Promise((r) => setTimeout(r, 50));
    const origin = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 200)); expect((await fetch(`${opened}/alive`, { method: 'POST', headers: { origin } })).status).toBe(204); }
    let settled = false;
    waiting.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    await expect(waiting).resolves.toEqual({ canceled: true });
  });
});

describe('Drive reads', () => {
  it('exports a Google Doc as markdown, and as plain text when markdown is refused', async () => {
    const d = fakeDrive(FILES);
    const meta = await driveFile('tok', DOC_ID, d.fetch);
    expect(meta).toMatchObject({ id: DOC_ID, name: 'Onboarding: week one', mimeType: GOOGLE_DOC });
    expect(await driveText('tok', meta, d.fetch)).toEqual({ text: '# Week one\n\nMeet the team.', format: 'markdown' });
    const plain = fakeDrive(FILES, { markdown: false });
    expect(await driveText('tok', meta, plain.fetch)).toEqual({ text: 'Week one\n\nMeet the team.', format: 'text' });
    expect(plain.calls.at(-1)).toContain('mimeType=text%2Fplain');
  });

  it('downloads markdown and text files as they are', async () => {
    const d = fakeDrive(FILES);
    expect((await driveText('tok', await driveFile('tok', MD_ID, d.fetch), d.fetch)).text).toMatch(/^---\ntitle: Runbook/);
    expect(await driveText('tok', await driveFile('tok', TXT_ID, d.fetch), d.fetch)).toEqual({ text: 'plain words', format: 'text' });
    expect(d.calls.at(-1)).toContain('alt=media');
  });

  it('refuses the trash, other types, a lost file, a large export and an expired token with a sentence', async () => {
    const files = { ...FILES, t: { name: 'old', mimeType: GOOGLE_DOC, trashed: true }, s: { name: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet' } };
    const d = fakeDrive(files);
    await expect(driveFile('tok', 't', d.fetch)).rejects.toThrow(/trash/);
    await expect(driveFile('tok', 's', d.fetch)).rejects.toThrow(/Only Google Docs, markdown and text files/);
    await expect(driveFile('tok', 'missing', d.fetch)).rejects.toMatchObject({ code: 'gone', message: 'Your Google account cannot open this file. Add it again from Google Drive, or remove it.' });
    const denied = fakeDrive(FILES, { status: { [DOC_ID]: { code: 403, body: { error: { errors: [{ reason: 'insufficientFilePermissions' }] } } } } });
    await expect(driveFile('tok', DOC_ID, denied.fetch)).rejects.toMatchObject({ code: 'gone' });
    const big = fakeDrive(FILES, { status: { [DOC_ID]: { code: 403, body: { error: { errors: [{ reason: 'exportSizeLimitExceeded' }] } } } } });
    await expect(driveText('tok', { id: DOC_ID, mimeType: GOOGLE_DOC, name: 'x' }, big.fetch)).rejects.toThrow(/too large/);
    const expired = fakeDrive(FILES, { status: { [DOC_ID]: { code: 401 } } });
    await expect(driveFile('tok', DOC_ID, expired.fetch)).rejects.toMatchObject({ code: 'reauth' });
    await expect(driveFile('tok', DOC_ID, async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'network' });
  });
});

describe('Drive rate limits', () => {
  it('waits as Retry-After says, retries, and reads the file once Drive answers', async () => {
    const limit = (reason, headers) => ({ code: 403, body: { error: { errors: [{ reason }] } }, headers });
    const d = fakeDrive(FILES, { status: { [DOC_ID]: [limit('userRateLimitExceeded', { 'retry-after': '3' }), { code: 429 }] } });
    const waits = [];
    const meta = await driveFile('tok', DOC_ID, d.fetch, { sleep: async (ms) => { waits.push(ms); } });
    expect(meta.id).toBe(DOC_ID);
    expect(waits).toEqual([3000, 2000]);
  });

  it('stops after a few tries with a sentence that says to wait', async () => {
    const limit = { code: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
    const d = fakeDrive(FILES, { status: { [DOC_ID]: [limit, limit, limit, limit, limit] } });
    const waits = [];
    await expect(driveFile('tok', DOC_ID, d.fetch, { sleep: async (ms) => { waits.push(ms); } })).rejects.toMatchObject({ code: 'limited', message: LIMITED });
    expect(waits).toEqual([1000, 2000, 4000]);
    const daily = fakeDrive(FILES, { status: { [DOC_ID]: [{ code: 403, body: { error: { errors: [{ reason: 'dailyLimitExceeded' }] } } }] } });
    expect((await driveFile('tok', DOC_ID, daily.fetch, { sleep: async () => {} })).id).toBe(DOC_ID);
  });
});

describe('confidential', () => {
  it('reads true, yes, 1 and labels as confidential, and false, no, 0 as not', () => {
    for (const v of ['true', 'yes', '1', 'YES', 'team-only', true]) expect(isConfidential({ confidential: v })).toBe(true);
    for (const v of ['false', 'no', '0', 'off', '', undefined, false]) expect(isConfidential({ confidential: v })).toBe(false);
    expect(dropFalseConfidential('---\ntitle: A\nconfidential: false\n---\nBody')).toBe('---\ntitle: A\n---\nBody');
    expect(dropFalseConfidential('---\nconfidential: yes\n---\nBody')).toBe('---\nconfidential: yes\n---\nBody');
  });
});

describe('note text', () => {
  it('shares the note, names its Drive file and keeps the file\'s own frontmatter', () => {
    const t = driveNoteText({ text: '# Week one', meta: { id: DOC_ID, name: 'Onboarding: week one', url: 'https://docs.google.com/document/d/x/edit', modifiedTime: '2026-11-01T10:00:00Z' }, syncedAt: '2026-11-13T09:00:00.000Z' });
    const fm = parseFrontmatter(t);
    expect(fm).toMatchObject({ visibility: 'public', kb_source: `google-drive:${DOC_ID}`, kb_source_url: 'https://docs.google.com/document/d/x/edit', kb_synced_at: '2026-11-13T09:00:00.000Z', title: 'Onboarding: week one' });
    expect(t).toMatch(/\n---\n> Source: \[Onboarding: week one\]\(https:\/\/docs\.google\.com\/document\/d\/x\/edit\) in Google Drive\.\n\n# Week one$/);
    const own = driveNoteText({ text: '---\ntitle: Runbook\n---\n# Runbook', meta: { id: MD_ID, name: 'runbook.md', url: null }, syncedAt: 's' });
    expect(parseFrontmatter(own).title).toBe('Runbook');
    expect(noteFileName('runbook.md')).toBe('runbook.md');
    expect(noteFileName('Plan: Q3 / Q4')).toBe('Plan Q3 Q4.md');
  });
});

// a Supabase client fake: one KB with folders, kb_list, the 0028 functions (or none, as an older database answers), and
// a notes table that takes upserts, soft deletes and reads
function fakeServer({ role = 'admin', notes = [], folders = [], fns = true, userId = 'me' } = {}) {
  const state = { kbs: [{ id: 'KB1', name: 'Team', role, folders, source: null }], notes: notes.map((n) => ({ ...n })), rpcs: [], upstream: new Map() };
  const answer = (data, error = null) => ({ data, error });
  const live = (id) => state.notes.find((n) => n.id === id && !n.deleted_at);
  const rpc = async (name, args) => {
    if (name === 'kb_list') return answer(structuredClone(state.kbs));
    if (name === 'kb_upstream_save') {
      if (!fns) return answer(null, { message: `Could not find the function public.${name}`, code: 'PGRST202' });
      for (const r of args.rows) state.upstream.set(r.note_id, { ...r, kb_id: args.kb_id });
      return answer(args.rows.length);
    }
    if (!name.startsWith('kb_drive_note_')) return answer(null, { message: `unknown rpc ${name}` });
    if (!fns) return answer(null, { message: `Could not find the function public.${name}`, code: 'PGRST202' });
    state.rpcs.push([name, args]);
    const n = live(args.note_id);
    if (!n || !String(n.frontmatter?.kb_source ?? '').startsWith('google-drive:')) return answer(null, { message: 'That file is no longer attached to this knowledge base', code: 'P0001' });
    if (role !== 'admin') return answer(null, { message: 'Only the knowledge base\'s admins can manage its Google Drive files', code: 'P0001' });
    if (name === 'kb_drive_note_write') Object.assign(n, { body: args.body, frontmatter: args.frontmatter, hash: args.hash, mtime: args.mtime, updated_at: 'now' });
    if (name === 'kb_drive_note_checked') n.frontmatter = { ...n.frontmatter, kb_checked_at: args.checked_at };
    if (name === 'kb_drive_note_remove') n.deleted_at = 'now';
    return answer(null);
  };
  const from = (table) => {
    const ops = [];
    const b = {};
    for (const op of ['select', 'eq', 'is', 'order', 'range', 'in']) b[op] = (...a) => { ops.push([op, ...a]); return b; };
    b.upsert = (rows) => { ops.push(['upsert', rows]); return b; };
    b.update = (patch) => { ops.push(['update', patch]); return b; };
    b.then = (res, rej) => {
      if (table === 'kb_note_upstream') {
        if (!fns) return Promise.resolve(answer(null, { message: 'relation "public.kb_note_upstream" does not exist', code: '42P01' })).then(res, rej);
        return Promise.resolve(answer([...state.upstream.values()].map((u) => ({ ...u })))).then(res, rej);
      }
      const upd = ops.find((o) => o[0] === 'update');
      if (upd) {
        const ids = ops.find((o) => o[0] === 'in')?.[2] ?? [];
        const user = ops.find((o) => o[0] === 'eq' && o[1] === 'user_id')?.[2];
        for (const n of state.notes) if (ids.includes(n.id) && n.user_id === user) Object.assign(n, upd[1]);
        return Promise.resolve(answer([])).then(res, rej);
      }
      const up = ops.find((o) => o[0] === 'upsert');
      if (up) {
        for (const r of up[1]) {
          const had = state.notes.find((n) => n.id === r.id);
          if (had && had.user_id !== r.user_id) return Promise.resolve(answer(null, { message: 'new row violates row-level security policy for table "notes"' })).then(res, rej);
          if (state.notes.some((n) => n.path === r.path && n.id !== r.id && !n.deleted_at)) return Promise.resolve(answer(null, { message: 'duplicate key value violates unique constraint "notes_workspace_path"' })).then(res, rej);
          const i = state.notes.findIndex((n) => n.id === r.id);
          if (i >= 0) state.notes[i] = { ...state.notes[i], ...r }; else state.notes.push({ ...r });
        }
        return Promise.resolve(answer([])).then(res, rej);
      }
      const byId = ops.find((o) => o[0] === 'in' && o[1] === 'id');
      if (byId) return Promise.resolve(answer(state.notes.filter((n) => byId[2].includes(n.id)).map((n) => ({ ...n })))).then(res, rej);
      const kbId = ops.find((o) => o[0] === 'eq' && o[1] === 'kb_id')?.[2];
      return Promise.resolve(answer(state.notes.filter((n) => n.kb_id === kbId && !n.deleted_at))).then(res, rej);
    };
    return b;
  };
  const account = { client: () => ({ rpc, from }), state: () => ({ signedIn: true, userId, workspace: { id: 'W', role: 'admin' } }) };
  return { state, account };
}

function drive(server, { picks = [], connected = true, apiKey = 'k', files = FILES, status = {} } = {}) {
  const d = fakeDrive(files, { status });
  const asked = [];
  const cancels = [];
  const accounts = {
    list: () => [{ id: 'google-drive', connected, account: 'person@example.com' }],
    accessToken: async (id) => { asked.push(id); return connected ? 'tok' : null; },
  };
  let clock = Date.parse('2026-11-13T09:00:00Z');
  const k = createKbDrive({
    account: server.account, accounts, picker: { apiKey, appId: '1' }, fetch: d.fetch, now: () => new Date(clock += 1000), sleep: async () => {},
    pick: async (opts) => { asked.push(['pick', opts.accessToken]); return picks === 'cancel' ? { canceled: true } : typeof picks === 'function' ? picks() : { files: picks }; },
    cancelPick: () => { cancels.push(1); return true; },
  });
  return { ...k, d, asked, cancels };
}

describe('kb-drive', () => {
  it('writes picked files as shared notes in the chosen folder and lists them', async () => {
    const server = fakeServer({ folders: [{ id: 'F1', parent_id: null, name: 'Guides', position: 0 }] });
    const k = drive(server, { picks: [{ id: DOC_ID, name: 'Onboarding: week one' }, { id: MD_ID, name: 'runbook.md' }, { id: TXT_ID, name: 'notes.txt' }] });
    const r = await k.handlers['kb-drive-add']({ kbId: 'KB1', folderId: 'F1' });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ synced: 3, unchanged: 0, skipped: [] });
    expect(k.asked).toContainEqual(['pick', 'tok']);
    const byPath = Object.fromEntries(server.state.notes.map((n) => [n.path, n]));
    expect(Object.keys(byPath).sort()).toEqual(['Knowledge bases/Team/Guides/Onboarding week one.md', 'Knowledge bases/Team/Guides/notes.md', 'Knowledge bases/Team/Guides/runbook.md']);
    const doc = byPath['Knowledge bases/Team/Guides/Onboarding week one.md'];
    expect(doc).toMatchObject({ kb_id: 'KB1', folder_id: 'F1', user_id: 'me', frontmatter: { visibility: 'public', kb_source: `google-drive:${DOC_ID}`, title: 'Onboarding: week one', kb_source_modified: '2026-11-01T10:00:00Z' } });
    expect(doc.body).toContain('> Source: [Onboarding: week one](https://docs.google.com/document/d/');
    expect(doc.body).toContain('# Week one');
    expect(r.files.map((f) => [f.name, f.folderId])).toEqual([['notes.txt', 'F1'], ['Onboarding: week one', 'F1'], ['Runbook', 'F1']]);
    expect((await k.handlers['kb-drive-files']('KB1')).files).toHaveLength(3);
  });

  it('syncs a changed file in place: same note, same path, new text, nothing duplicated', async () => {
    const server = fakeServer();
    const files = structuredClone(FILES);
    const k = drive(server, { picks: [{ id: DOC_ID, name: 'Onboarding' }], files });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    const [before] = server.state.notes.map((n) => ({ ...n }));
    files[DOC_ID].markdown = '# Week one\n\nMeet the team. Then lunch.';
    files[DOC_ID].name = 'Renamed in Drive';
    files[DOC_ID].modifiedTime = '2026-11-12T10:00:00Z';
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1', fileId: DOC_ID });
    expect(s).toMatchObject({ synced: 1, unchanged: 0 });
    expect(server.state.notes).toHaveLength(1);
    const [after] = server.state.notes;
    expect(after.id).toBe(before.id);
    expect(after.path).toBe(before.path);
    expect(after.body).toContain('Then lunch.');
    expect(after.frontmatter.kb_synced_at > before.frontmatter.kb_synced_at).toBe(true);
    // picking it again syncs it where it already is
    files[DOC_ID].modifiedTime = '2026-11-12T11:00:00Z';
    expect((await k.handlers['kb-drive-add']({ kbId: 'KB1' })).synced).toBe(1);
    expect(server.state.notes).toHaveLength(1);
  });

  it('skips an unchanged file: no export, no write, the hash stays, only the check time moves', async () => {
    const server = fakeServer();
    const k = drive(server, { picks: [{ id: DOC_ID }] });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    const before = { ...server.state.notes[0] };
    const calls = k.d.calls.length;
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s).toMatchObject({ synced: 0, unchanged: 1, skipped: [] });
    expect(k.d.calls.slice(calls).every((u) => !u.includes('/export'))).toBe(true);
    const after = server.state.notes[0];
    expect(after.hash).toBe(before.hash);
    expect(after.body).toBe(before.body);
    expect(after.frontmatter.kb_checked_at).toBeTruthy();
    expect(s.files[0].syncedAt).toBe(after.frontmatter.kb_checked_at);
  });

  it('lets any KB admin sync and remove a file another admin added, with their own Drive token', async () => {
    const server = fakeServer({ notes: [{ id: 'N2', path: 'Knowledge bases/Team/Plan.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { kb_source: `google-drive:${DOC_ID}`, title: 'Plan', kb_source_modified: 'old' } }] });
    const k = drive(server);
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1', fileId: DOC_ID });
    expect(s).toMatchObject({ synced: 1, skipped: [] });
    expect(server.state.rpcs.map((r) => r[0])).toEqual(['kb_drive_note_write']);
    expect(server.state.notes[0]).toMatchObject({ id: 'N2', user_id: 'u2', path: 'Knowledge bases/Team/Plan.md' });
    expect(server.state.notes[0].body).toContain('# Week one');
    expect(await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: DOC_ID })).toEqual({ files: [] });
    expect(server.state.notes[0].deleted_at).toBeTruthy();
  });

  it('says when the caller\'s Google account cannot open another admin\'s file, and Remove still works', async () => {
    const server = fakeServer({ notes: [{ id: 'N2', path: 'Knowledge bases/Team/Plan.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { kb_source: 'google-drive:1NotSharedWithCaller00000', title: 'Plan' } }] });
    const k = drive(server);
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s.skipped).toEqual([{ path: 'Plan', reason: 'Your Google account cannot open this file. Add it again from Google Drive, or remove it.' }]);
    expect((await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: '1NotSharedWithCaller00000' })).files).toEqual([]);
  });

  it('on an older database, keeps the caller\'s own files working and says what another admin\'s file needs', async () => {
    const server = fakeServer({ fns: false, notes: [{ id: 'N2', path: 'Knowledge bases/Team/Plan.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { kb_source: `google-drive:${DOC_ID}`, title: 'Plan' } }] });
    const k = drive(server, { picks: [{ id: MD_ID }] });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s.synced).toBe(0);
    expect(s.unchanged).toBe(1);
    expect(s.skipped).toEqual([{ path: 'Onboarding: week one', reason: expect.stringMatching(/latest database update/) }]);
    expect((await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: MD_ID })).files.map((f) => f.fileId)).toEqual([DOC_ID]);
    expect((await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: DOC_ID })).error).toMatch(/latest database update/);
  });

  it('takes a file that became confidential out of the knowledge base and reports it', async () => {
    const server = fakeServer();
    const files = structuredClone(FILES);
    const k = drive(server, { picks: [{ id: MD_ID }], files });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    files[MD_ID].content = '---\nconfidential: yes\n---\n# Runbook';
    files[MD_ID].modifiedTime = '2026-11-12T10:00:00Z';
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s.skipped).toEqual([{ path: 'runbook.md', reason: 'The file is now marked confidential, so its note left the knowledge base.' }]);
    expect(server.state.notes[0].deleted_at).toBeTruthy();
    expect(s.files).toEqual([]);
    // confidential: false is shared, and the key is dropped so the database agrees
    files[MD_ID].content = '---\nconfidential: false\n---\n# Runbook';
    const again = await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    expect(again.synced).toBe(1);
    expect(server.state.notes.at(-1).frontmatter.confidential).toBeUndefined();
  });

  it('writes the files it read when a later file fails, and reports each failure', async () => {
    const server = fakeServer();
    const limited = { code: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } };
    const k = drive(server, {
      picks: [{ id: TXT_ID, name: 'notes.txt' }, { id: '1GoneFileIdForTests0000000', name: 'Gone doc' }, { id: DOC_ID, name: 'Onboarding' }, { id: MD_ID, name: 'runbook.md' }],
      status: { [DOC_ID]: [limited, limited, limited, limited] },
    });
    const r = await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    expect(r.synced).toBe(1);
    expect(r.skipped).toEqual([
      { path: 'Gone doc', reason: 'Your Google account cannot open this file. Add it again from Google Drive, or remove it.' },
      { path: 'Onboarding', reason: LIMITED },
      { path: 'runbook.md', reason: LIMITED },
    ]);
    expect(server.state.notes.map((n) => n.path)).toEqual(['Knowledge bases/Team/notes.md']);
  });

  it('gives a new file a name no note in the folder has', async () => {
    const server = fakeServer({ notes: [{ id: 'N1', path: 'Knowledge bases/Team/runbook.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { title: 'runbook' } }] });
    const k = drive(server, { picks: [{ id: MD_ID, name: 'runbook.md' }] });
    expect((await k.handlers['kb-drive-add']({ kbId: 'KB1' })).synced).toBe(1);
    expect(server.state.notes.find((n) => n.user_id === 'me').path).toBe('Knowledge bases/Team/runbook (2).md');
  });

  it('waits for the picker outside the sync lock, and cancel ends it', async () => {
    const server = fakeServer();
    let release;
    const k = drive(server, { picks: () => new Promise((r) => { release = r; }) });
    const adding = k.handlers['kb-drive-add']({ kbId: 'KB1' });
    await new Promise((r) => setTimeout(r, 10));
    // a sync while the picker is open runs at once
    expect(await k.handlers['kb-drive-sync']({ kbId: 'KB1' })).toMatchObject({ synced: 0, files: [] });
    expect(await k.handlers['kb-drive-cancel']()).toEqual({ canceled: true });
    expect(k.cancels).toHaveLength(1);
    release({ canceled: true });
    expect(await adding).toEqual({ canceled: true });
  });

  it('refuses without the account, without the picker key, for a reader, and stops on a cancel', async () => {
    expect(await drive(fakeServer(), { connected: false }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Connect Google Drive in Settings, Connections first.' });
    expect(await drive(fakeServer(), { apiKey: null }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Adding files from Google Drive is not available in this build yet.' });
    expect(await drive(fakeServer({ role: 'reader' })).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Only the knowledge base\'s admins can manage its Google Drive files.' });
    expect(await drive(fakeServer({ role: 'reader' })).handlers['kb-drive-remove']({ kbId: 'KB1', fileId: DOC_ID })).toEqual({ error: 'Only the knowledge base\'s admins can manage its Google Drive files.' });
    expect(await drive(fakeServer()).handlers['kb-drive-add']({ kbId: 'KB1', folderId: 'nope' })).toEqual({ error: 'That folder is not in this knowledge base.' });
    const server = fakeServer();
    expect(await drive(server, { picks: 'cancel' }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ canceled: true });
    expect(server.state.notes).toHaveLength(0);
    expect(await drive(fakeServer(), { connected: false }).handlers['kb-drive-status']()).toEqual({ connected: false, available: true, account: 'person@example.com' });
  });
});

describe('kb-drive with Quorum\'s edits', () => {
  const edit = (server, change) => {
    const n = server.state.notes[0];
    n.body = change(n.body);
    n.hash = createHash('sha256').update(n.body).digest('hex');
    return n;
  };
  const setUp = async () => {
    const server = fakeServer();
    const files = structuredClone(FILES);
    const k = drive(server, { picks: [{ id: DOC_ID }], files });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    return { server, files, k };
  };

  it('records the base, keeps Quorum\'s edit when the file\'s text is unchanged, and never writes to Drive', async () => {
    const { server, files, k } = await setUp();
    expect(server.state.upstream.get(server.state.notes[0].id)).toMatchObject({ base_body: server.state.notes[0].body, suggestion_state: null });
    const edited = edit(server, (b) => `${b}\n\n## Meetings\n\n- [[Ana]]\n`).body;
    files[DOC_ID].modifiedTime = '2026-11-12T10:00:00Z';
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s).toMatchObject({ synced: 0, unchanged: 1, suggested: 0 });
    expect(server.state.notes[0].body).toBe(edited);
    expect(server.state.rpcs.map((r) => r[0])).toEqual(['kb_drive_note_checked']);
    expect(k.d.calls.every((u) => !/method=|upload|PATCH/i.test(u))).toBe(true);
  });

  it('writes the changed file and keeps a clean edit as a ready suggestion', async () => {
    const { server, files, k } = await setUp();
    edit(server, (b) => `${b}\n\n## Meetings\n\n- [[Ana]]\n`);
    files[DOC_ID].markdown = '# Week one\n\nBring a laptop.\n\nMeet the team.';
    files[DOC_ID].modifiedTime = '2026-11-12T10:00:00Z';
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1' });
    expect(s).toMatchObject({ synced: 1, suggested: 1 });
    const n = server.state.notes[0];
    expect(n.body).toContain('Bring a laptop.');
    expect(n.body).not.toContain('[[Ana]]');
    const u = server.state.upstream.get(n.id);
    expect(u).toMatchObject({ base_body: n.body, suggestion_state: 'ready' });
    expect(u.suggestion_body).toContain('Bring a laptop.');
    expect(u.suggestion_body).toContain('- [[Ana]]');
    expect(u.suggestion_body).toContain('kb_source_modified: 2026-11-12T10:00:00Z');
  });

  it('keeps a clashing edit as a stale suggestion, and the change Drive made alone writes no suggestion', async () => {
    const { server, files, k } = await setUp();
    const base = server.state.notes[0].body;
    edit(server, (b) => b.replace('Meet the team.', 'Meet the team and Ana.'));
    files[DOC_ID].markdown = '# Week one\n\nMeet the whole team.';
    files[DOC_ID].modifiedTime = '2026-11-12T10:00:00Z';
    expect(await k.handlers['kb-drive-sync']({ kbId: 'KB1' })).toMatchObject({ synced: 1, suggested: 1 });
    const u = server.state.upstream.get(server.state.notes[0].id);
    expect(u).toMatchObject({ suggestion_state: 'stale', suggestion_base: base });
    expect(u.suggestion_body).toContain('Meet the team and Ana.');
    // a later change in Drive, with no new edit in Quorum, merges the kept suggestion onto the newer text
    files[DOC_ID].markdown = '# Week one\n\nMeet the team.\n\nLunch at noon.';
    files[DOC_ID].modifiedTime = '2026-11-12T11:00:00Z';
    expect(await k.handlers['kb-drive-sync']({ kbId: 'KB1' })).toMatchObject({ synced: 1, suggested: 1 });
    const again = server.state.upstream.get(server.state.notes[0].id);
    expect(again.suggestion_state).toBe('ready');
    expect(again.suggestion_body).toContain('Meet the team and Ana.');
    expect(again.suggestion_body).toContain('Lunch at noon.');
  });
});
