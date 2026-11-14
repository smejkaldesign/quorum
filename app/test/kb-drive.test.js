// Google Drive files in a knowledge base folder (sources/drive.js, ee/kbDrive.js). Google's APIs and the database are
// fakes; the only sockets are the picker page's loopback server and the test's own requests to it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'quorum-kbdrive-home-'));
process.env.HOME = home;
const { awaitPicker, driveFile, driveText, pickerConfig, pickerPage, GOOGLE_DOC } = await import('../sources/drive.js');
const { createKbDrive, driveNoteText, noteFileName } = await import('../ee/kbDrive.js');
const { oauthClients } = await import('../sources/accounts.js');
const { parseFrontmatter } = await import('../ee/sync.js');

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
    if (status[id]) return new Response(JSON.stringify(status[id].body ?? {}), { status: status[id].code });
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
    const docs = [{ id: DOC_ID, name: 'Onboarding', mimeType: GOOGLE_DOC, url: 'https://docs.google.com/document/d/x' }, { id: '../etc', name: 'bad' }];
    expect((await fetch(`${opened}/done`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'picked', docs }) })).status).toBe(204);
    await expect(waiting).resolves.toEqual({ files: [{ id: DOC_ID, name: 'Onboarding', mimeType: GOOGLE_DOC, url: 'https://docs.google.com/document/d/x' }] });
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
    await expect(driveFile('tok', 'missing', d.fetch)).rejects.toMatchObject({ code: 'gone' });
    const big = fakeDrive(FILES, { status: { [DOC_ID]: { code: 403, body: { error: { errors: [{ reason: 'exportSizeLimitExceeded' }] } } } } });
    await expect(driveText('tok', { id: DOC_ID, mimeType: GOOGLE_DOC, name: 'x' }, big.fetch)).rejects.toThrow(/too large/);
    const expired = fakeDrive(FILES, { status: { [DOC_ID]: { code: 401 } } });
    await expect(driveFile('tok', DOC_ID, expired.fetch)).rejects.toMatchObject({ code: 'reauth' });
    await expect(driveFile('tok', DOC_ID, async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'network' });
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

// a Supabase client fake: one KB with folders, kb_list, and a notes table that takes upserts, soft deletes and reads
function fakeServer({ role = 'admin', notes = [], folders = [] } = {}) {
  const state = { kbs: [{ id: 'KB1', name: 'Team', role, folders, source: null }], notes: notes.map((n) => ({ ...n })) };
  const answer = (data, error = null) => ({ data, error });
  const rpc = async (name) => (name === 'kb_list' ? answer(structuredClone(state.kbs)) : answer(null, { message: `unknown rpc ${name}` }));
  const from = () => {
    const ops = [];
    const b = {};
    for (const op of ['select', 'eq', 'is', 'order', 'range', 'in']) b[op] = (...a) => { ops.push([op, ...a]); return b; };
    b.upsert = (rows) => { ops.push(['upsert', rows]); return b; };
    b.update = (patch) => { ops.push(['update', patch]); return b; };
    b.then = (res, rej) => {
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
          if (state.notes.some((n) => n.path === r.path && n.id !== r.id && !n.deleted_at)) return Promise.resolve(answer(null, { message: 'duplicate key value violates unique constraint "notes_workspace_path"' })).then(res, rej);
          const i = state.notes.findIndex((n) => n.id === r.id);
          if (i >= 0) state.notes[i] = { ...state.notes[i], ...r }; else state.notes.push({ ...r });
        }
        return Promise.resolve(answer([])).then(res, rej);
      }
      const kbId = ops.find((o) => o[0] === 'eq' && o[1] === 'kb_id')?.[2];
      return Promise.resolve(answer(state.notes.filter((n) => n.kb_id === kbId && !n.deleted_at))).then(res, rej);
    };
    return b;
  };
  const account = { client: () => ({ rpc, from }), state: () => ({ signedIn: true, userId: 'me', workspace: { id: 'W', role: 'admin' } }) };
  return { state, account };
}

function drive(server, { picks = [], connected = true, apiKey = 'k', files = FILES } = {}) {
  const d = fakeDrive(files);
  const asked = [];
  const accounts = {
    list: () => [{ id: 'google-drive', connected, account: 'person@example.com' }],
    accessToken: async (id) => { asked.push(id); return connected ? 'tok' : null; },
  };
  let clock = Date.parse('2026-11-13T09:00:00Z');
  const k = createKbDrive({
    account: server.account, accounts, picker: { apiKey, appId: '1' }, fetch: d.fetch, now: () => new Date(clock += 1000),
    pick: async (opts) => { asked.push(['pick', opts.accessToken]); return picks === 'cancel' ? { canceled: true } : { files: picks }; },
  });
  return { ...k, d, asked };
}

describe('kb-drive', () => {
  it('writes picked files as shared notes in the chosen folder and lists them', async () => {
    const server = fakeServer({ folders: [{ id: 'F1', parent_id: null, name: 'Guides', position: 0 }] });
    const k = drive(server, { picks: [{ id: DOC_ID, name: 'Onboarding: week one' }, { id: MD_ID, name: 'runbook.md' }, { id: TXT_ID, name: 'notes.txt' }] });
    const r = await k.handlers['kb-drive-add']({ kbId: 'KB1', folderId: 'F1' });
    expect(r.error).toBeUndefined();
    expect(r.synced).toBe(3);
    expect(k.asked).toContainEqual(['pick', 'tok']);
    const byPath = Object.fromEntries(server.state.notes.map((n) => [n.path, n]));
    expect(Object.keys(byPath).sort()).toEqual(['Knowledge bases/Team/Guides/Onboarding week one.md', 'Knowledge bases/Team/Guides/notes.md', 'Knowledge bases/Team/Guides/runbook.md']);
    const doc = byPath['Knowledge bases/Team/Guides/Onboarding week one.md'];
    expect(doc).toMatchObject({ kb_id: 'KB1', folder_id: 'F1', user_id: 'me', frontmatter: { visibility: 'public', kb_source: `google-drive:${DOC_ID}`, title: 'Onboarding: week one' } });
    expect(doc.body).toContain('> Source: [Onboarding: week one](https://docs.google.com/document/d/');
    expect(doc.body).toContain('# Week one');
    expect(r.files.map((f) => [f.name, f.folderId, f.mine])).toEqual([['notes.txt', 'F1', true], ['Onboarding: week one', 'F1', true], ['Runbook', 'F1', true]]);
    expect((await k.handlers['kb-drive-files']('KB1')).files).toHaveLength(3);
  });

  it('syncs an attached file in place: same note, same path, new text, nothing duplicated', async () => {
    const server = fakeServer();
    const files = structuredClone(FILES);
    const k = drive(server, { picks: [{ id: DOC_ID, name: 'Onboarding' }], files });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    const [before] = server.state.notes;
    files[DOC_ID].markdown = '# Week one\n\nMeet the team. Then lunch.';
    files[DOC_ID].name = 'Renamed in Drive';
    const s = await k.handlers['kb-drive-sync']({ kbId: 'KB1', fileId: DOC_ID });
    expect(s.synced).toBe(1);
    expect(server.state.notes).toHaveLength(1);
    const [after] = server.state.notes;
    expect(after.id).toBe(before.id);
    expect(after.path).toBe(before.path);
    expect(after.body).toContain('Then lunch.');
    expect(after.frontmatter.kb_synced_at > before.frontmatter.kb_synced_at).toBe(true);
    // picking it again, into a folder, syncs it where it already is
    const again = await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    expect(again.synced).toBe(1);
    expect(server.state.notes).toHaveLength(1);
    // the whole KB at once
    expect((await k.handlers['kb-drive-sync']({ kbId: 'KB1' })).synced).toBe(1);
  });

  it('gives a new file a name no note in the folder has, and leaves another admin\'s file to them', async () => {
    const server = fakeServer({ notes: [
      { id: 'N1', path: 'Knowledge bases/Team/runbook.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { title: 'runbook' } },
      { id: 'N2', path: 'Knowledge bases/Team/Onboarding week one.md', kb_id: 'KB1', folder_id: null, user_id: 'u2', frontmatter: { kb_source: `google-drive:${DOC_ID}`, title: 'Onboarding: week one' } },
    ] });
    const k = drive(server, { picks: [{ id: MD_ID, name: 'runbook.md' }, { id: DOC_ID, name: 'Onboarding: week one' }] });
    const r = await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    expect(r.synced).toBe(1);
    expect(r.skipped).toEqual([{ path: 'Onboarding: week one', reason: 'Another admin attached this file. They sync it.' }]);
    expect(server.state.notes.find((n) => n.user_id === 'me').path).toBe('Knowledge bases/Team/runbook (2).md');
    expect(r.files.find((f) => f.fileId === DOC_ID).mine).toBe(false);
    expect(await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: DOC_ID })).toEqual({ error: 'Only the admin who attached this file can remove it.' });
    expect(await k.handlers['kb-drive-sync']({ kbId: 'KB1', fileId: DOC_ID })).toEqual({ error: 'That file is not one you attached to this knowledge base.' });
  });

  it('removes an attached file by taking its note out', async () => {
    const server = fakeServer();
    const k = drive(server, { picks: [{ id: DOC_ID }] });
    await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    const r = await k.handlers['kb-drive-remove']({ kbId: 'KB1', fileId: DOC_ID });
    expect(r).toEqual({ files: [] });
    expect(server.state.notes[0].deleted_at).toBeTruthy();
  });

  it('skips a file Drive no longer lets Quorum read and says so', async () => {
    const server = fakeServer();
    const k = drive(server, { picks: [{ id: '1GoneFileIdForTests0000000', name: 'Gone doc' }, { id: TXT_ID, name: 'notes.txt' }] });
    const r = await k.handlers['kb-drive-add']({ kbId: 'KB1' });
    expect(r.synced).toBe(1);
    expect(r.skipped).toEqual([{ path: 'Gone doc', reason: 'Quorum can no longer open this file. Add it again from Google Drive.' }]);
  });

  it('refuses without the account, without the picker key, for a reader, and stops on a cancel', async () => {
    expect(await drive(fakeServer(), { connected: false }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Connect Google Drive in Settings, Connections first.' });
    expect(await drive(fakeServer(), { apiKey: null }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Adding files from Google Drive is not available in this build yet.' });
    expect(await drive(fakeServer({ role: 'reader' })).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ error: 'Only the knowledge base\'s admins can add files from Google Drive.' });
    expect(await drive(fakeServer()).handlers['kb-drive-add']({ kbId: 'KB1', folderId: 'nope' })).toEqual({ error: 'That folder is not in this knowledge base.' });
    const server = fakeServer();
    expect(await drive(server, { picks: 'cancel' }).handlers['kb-drive-add']({ kbId: 'KB1' })).toEqual({ canceled: true });
    expect(server.state.notes).toHaveLength(0);
    expect(await drive(fakeServer(), { connected: false }).handlers['kb-drive-status']()).toEqual({ connected: false, available: true, account: 'person@example.com' });
  });
});
