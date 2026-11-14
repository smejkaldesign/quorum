import { describe, expect, it } from 'vitest';
import { ago, checkRepoUrl, grantLabel, grantLine, lastSynced, noteCount, remoteLine, syncActions, syncStatus } from '../ee/src/kbSyncUi.ts';
const { createKbSync, githubTarget, mayHaveArrived, DRIVE_FOLDER } = await import('../ee/kbSync.js');
const { pickerPage } = await import('../sources/drive.js');

const NOW = Date.parse('2026-11-13T12:00:00Z');
const row = (over = {}) => ({ status: 'active', connected: true, last_synced_at: '2026-11-13T11:55:00Z', provider: 'google-drive', remote_kind: 'folder', remote_id: 'f1', options: {}, account: null, ...over });

describe('synced folder sentences', () => {
  it('names one status per row', () => {
    expect(syncStatus(row())).toEqual({ label: 'In sync', tone: 'ok' });
    expect(syncStatus(row({ status: 'paused' })).label).toBe('Paused');
    expect(syncStatus(row({ status: 'paused', paused_by: 'plan' })).label).toBe('Paused, plan ended');
    expect(syncStatus(row({ status: 'error' }))).toEqual({ label: 'Needs attention', tone: 'warn' });
    expect(syncStatus(row({ status: 'needs_auth' })).tone).toBe('warn');
    expect(syncStatus(row({ status: 'active', connected: false })).tone).toBe('warn');
    expect(syncStatus(row({ status: 'pending', last_synced_at: null })).label).toBe('Waiting for the first sync');
    expect(syncStatus(row({ status: 'pending' })).label).toBe('Sync queued');
  });

  it('says when it last synced', () => {
    expect(ago('2026-11-13T11:59:40Z', NOW)).toBe('just now');
    expect(ago('2026-11-13T11:59:00Z', NOW)).toBe('1 minute ago');
    expect(ago('2026-11-13T11:15:00Z', NOW)).toBe('45 minutes ago');
    expect(ago('2026-11-13T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(ago('2026-11-11T12:00:00Z', NOW)).toBe('2 days ago');
    expect(ago(null, NOW)).toBe('');
    expect(lastSynced(row(), NOW)).toBe('Last synced 5 minutes ago');
    expect(lastSynced(row({ last_synced_at: null }), NOW)).toBe('Not synced yet');
    expect(noteCount(1)).toBe('1 note');
    expect(noteCount(12)).toBe('12 notes');
  });

  it('says where the content comes from', () => {
    expect(remoteLine(row({ account: 'ana@example.com' }))).toBe('Folder in Google Drive, ana@example.com');
    expect(remoteLine(row({ remote_kind: 'file' }))).toBe('File in Google Drive');
    expect(remoteLine(row({ provider: 'github', remote_id: 'octo/handbook', options: { branch: 'main', path: 'docs' } }))).toBe('octo/handbook on main, docs folder');
    expect(remoteLine(row({ provider: 'github', remote_id: 'octo/handbook', options: {} }))).toBe('octo/handbook on the default branch');
  });

  it('offers Sync now, Pause, Resume and Remove by status', () => {
    expect(syncActions(row())).toEqual({ syncNow: true, pause: true, resume: false });
    expect(syncActions(row({ status: 'paused' }))).toEqual({ syncNow: false, pause: false, resume: true });
    expect(syncActions(row({ status: 'paused', paused_by: 'plan' })).resume).toBe(false);
    expect(syncActions(row({ status: 'needs_auth' })).syncNow).toBe(false);
    expect(syncActions(row({ connected: false })).syncNow).toBe(false);
  });

  it('checks a repository address', () => {
    expect(checkRepoUrl('https://github.com/octo/handbook')).toBeNull();
    expect(checkRepoUrl('https://github.com/octo/handbook/tree/main/docs')).toBeNull();
    expect(checkRepoUrl('')).toMatch(/Enter the repository/);
    expect(checkRepoUrl('https://github.com/octo')).toMatch(/GitHub repository address/);
    expect(checkRepoUrl('https://gitlab.com/octo/handbook')).toMatch(/GitHub repository address/);
  });
});

describe('the GitHub target', () => {
  // the repository's branches, as GitHub's matching-refs answers for the first segment of a /tree/ path
  const branches = (names) => async (url) => {
    const first = decodeURIComponent(url.split('/matching-refs/heads/')[1] ?? '');
    return { ok: true, status: 200, json: async () => names.filter((n) => n.startsWith(first)).map((n) => ({ ref: `refs/heads/${n}` })) };
  };
  it('reads the repository, and splits a /tree/ path at the branch the repository has', async () => {
    expect(await githubTarget('https://github.com/octo/handbook', null, branches([]))).toMatchObject({ id: 'octo/handbook', branch: null, path: null, name: 'octo/handbook' });
    expect(await githubTarget('https://github.com/octo/handbook/tree/main/docs/policies', null, branches(['main']))).toMatchObject({ branch: 'main', path: 'docs/policies', name: 'octo/handbook/docs/policies' });
    // a branch name with a slash is found without typing it in the branch field
    expect(await githubTarget('https://github.com/octo/handbook/tree/release/v2/docs', null, branches(['release', 'release/v2']))).toMatchObject({ branch: 'release/v2', path: 'docs' });
    expect(await githubTarget('https://github.com/octo/handbook/tree/release/v2/docs', 'release/v2', branches([]))).toMatchObject({ branch: 'release/v2', path: 'docs' });
    expect((await githubTarget('https://github.com/octo/handbook/tree/main/docs', 'dev', branches([]))).error).toMatch(/does not match/);
    expect((await githubTarget('https://github.com/octo/handbook/tree/nobranch/docs', null, branches(['main']))).error).toMatch(/not found/);
    expect((await githubTarget('nope', null, branches([]))).error).toBeTruthy();
  });
});

describe('the Drive picker for folder sync', () => {
  it('offers folders, one pick, and its own title', () => {
    const page = pickerPage({ apiKey: 'k', appId: '1', accessToken: 't', nonce: 'n', folders: true });
    expect(page).toContain('application/vnd.google-apps.folder');
    expect(page).toContain('"max":1');
    expect(page).toContain('<title>Choose a folder or file to sync</title>');
    const files = pickerPage({ apiKey: 'k', appId: '1', accessToken: 't', nonce: 'n' });
    expect(files).not.toContain('application/vnd.google-apps.folder,');
    expect(files).toContain('"folders":false');
    expect(files).toContain('<title>Choose files for Quorum</title>');
  });
});

function harness({ role = 'admin', driveConnected = true, refreshToken = 'rt-drive', github = { accessToken: 'gh-access', refreshToken: 'gh-rt', account: 'octocat' }, relay = () => ({ status: 200, body: { attachment: { id: 'A1', name: 'Policies' } } }), list = [{ id: 'A1' }], signIn = null, grants = [] } = {}) {
  const calls = { rpc: [], fetch: [], relay: [], picks: [], signIns: [], cancels: 0 };
  const kb = { id: 'KB', name: 'Handbook', role, folders: [{ id: 'F1', parent_id: null, name: 'Policies' }] };
  const rpc = async (name, args) => {
    calls.rpc.push({ name, args });
    if (name === 'kb_list') return { data: [kb], error: null };
    if (name === 'kb_attachments_list') return { data: typeof list === 'function' ? list() : list, error: null };
    if (name === 'kb_attachment_remove') return { data: 3, error: null };
    if (name === 'kb_sync_disconnect') return { data: 1, error: null };
    if (name === 'kb_sync_my_grants') return { data: grants, error: null };
    if (name === 'kb_sync_grant_disconnect') return { data: { paused: 1, removed: 0 }, error: null };
    return { data: { id: args.id, status: 'paused' }, error: null };
  };
  const account = {
    client: () => ({ rpc, auth: { getSession: async () => ({ data: { session: { access_token: 'session-jwt' } } }) } }),
    state: () => ({ signedIn: true, userId: 'U', workspace: { id: 'W', role: 'admin' } }),
    envStatus: () => ({ config: 'production' }),
  };
  const accounts = { list: () => [{ id: 'google-drive', connected: driveConnected, account: 'ana@example.com' }], accessToken: async () => 'drive-access', refreshToken: async () => refreshToken };
  // GitHub's API for the branch lookup
  const fetch = async (url, init) => { calls.fetch.push({ url, init }); return { ok: true, status: 200, json: async () => [{ ref: 'refs/heads/main' }] }; };
  const relayFetch = async (route, init) => { calls.relay.push({ route, init, body: JSON.parse(init.body) }); const r = relay(); if (r instanceof Error) throw r; return { ok: r.status < 300, status: r.status, json: async () => r.body }; };
  const s = createKbSync({
    account, accounts, fetch, relayFetch, picker: { apiKey: 'k', appId: '1' }, newId: () => 'attach-test-0001',
    pick: async (o) => { calls.picks.push(o); return { files: [{ id: 'folder-123', name: 'Policies', mimeType: DRIVE_FOLDER }] }; },
    signIn: signIn ?? (async (id) => { calls.signIns.push(id); return github; }),
    cancelSignIn: () => { calls.cancels++; return true; }, cancelPick: () => false,
  });
  return { s, calls };
}

describe('the synced folders IPC', () => {
  it('attaches a Drive folder with the Keychain grant, marked as shared with the Mac', async () => {
    const { s, calls } = harness();
    const r = await s.handlers['kb-sync-attach-drive']({ kbId: 'KB', folderId: 'F1' });
    expect(r.attachment.id).toBe('A1');
    expect(calls.picks[0]).toMatchObject({ folders: true, accessToken: 'drive-access' });
    const { route: url, init, body } = calls.relay[0];
    expect(url).toBe('/v1/kb-sync/attach');
    expect(body.attach_id).toBe('attach-test-0001');
    expect(init.headers.authorization).toBe('Bearer session-jwt');
    expect(body).toMatchObject({ kb_id: 'KB', folder_id: 'F1', provider: 'google-drive', refresh_token: 'rt-drive', shared_with_mac: true, remote: { id: 'folder-123', kind: 'folder', name: 'Policies' } });
  });

  it('attaches a GitHub repository with a sign-in of its own', async () => {
    const { s, calls } = harness();
    await s.handlers['kb-sync-attach-github']({ kbId: 'KB', url: 'https://github.com/octo/handbook/tree/main/docs' });
    expect(calls.signIns).toEqual(['github']);
    expect(calls.fetch[0].url).toMatch(/matching-refs\/heads\/main$/);
    expect(calls.fetch[0].init.headers.authorization).toBe('Bearer gh-access');
    expect(calls.relay[0].body).toMatchObject({ provider: 'github', refresh_token: 'gh-rt', shared_with_mac: false, remote: { id: 'octo/handbook', kind: 'folder', branch: 'main', path: 'docs' } });
  });

  it('refuses readers, a missing connection and a GitHub sign-in without a refresh token, and passes the relay\'s sentence on', async () => {
    expect((await harness({ role: 'reader' }).s.handlers['kb-sync-attach-drive']({ kbId: 'KB' })).error).toMatch(/admins/);
    expect((await harness({ driveConnected: false }).s.handlers['kb-sync-attach-drive']({ kbId: 'KB' })).error).toMatch(/Connect Google Drive/);
    expect((await harness({ github: { refreshToken: null } }).s.handlers['kb-sync-attach-github']({ kbId: 'KB', url: 'https://github.com/octo/handbook' })).error).toMatch(/refresh token/);
    const refused = harness({ relay: () => ({ status: 400, body: { error: 'Your workspace allows only connectors an admin approved.' } }) });
    expect((await refused.s.handlers['kb-sync-attach-drive']({ kbId: 'KB' })).error).toBe('Your workspace allows only connectors an admin approved.');
  });

  it('lists, pauses, syncs now, removes, and ends the grant on Disconnect', async () => {
    const { s, calls } = harness();
    expect((await s.handlers['kb-sync-list']('KB')).attachments).toEqual([{ id: 'A1' }]);
    await s.handlers['kb-sync-pause']({ id: 'A1', paused: true });
    await s.handlers['kb-sync-now']({ id: 'A1' });
    expect((await s.handlers['kb-sync-remove']({ id: 'A1' })).removed).toBe(3);
    expect(await s.disconnected('google-drive')).toBe(1);
    expect(await s.disconnected('notion')).toBe(0);
    expect(await s.disconnected('github')).toBe(0);
    expect(calls.rpc.map((c) => c.name)).toEqual(['kb_attachments_list', 'kb_attachment_pause', 'kb_attachment_sync_now', 'kb_attachment_remove', 'kb_sync_disconnect']);
    expect(calls.rpc[1].args).toEqual({ id: 'A1', paused: true });
    expect(calls.rpc[4].args).toEqual({ workspace_id: 'W', provider: 'google-drive' });
  });
});

describe('attach that may have reached the relay', () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  it('finds the attachment by its attach id after a timeout', async () => {
    const { s, calls } = harness({ relay: timeout, list: [{ id: 'A-made', attach_id: 'attach-test-0001' }] });
    const r = await s.handlers['kb-sync-attach-drive']({ kbId: 'KB' });
    expect(r.attachment.id).toBe('A-made');
    expect(calls.relay.length).toBe(1);
  });
  it('says the attach is not confirmed when the list does not have it', async () => {
    const { s } = harness({ relay: timeout, list: [] });
    expect((await s.handlers['kb-sync-attach-drive']({ kbId: 'KB' })).error).toMatch(/did not confirm/);
  });
  it('reports an unreachable relay plainly', async () => {
    const { s, calls } = harness({ relay: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
    expect((await s.handlers['kb-sync-attach-drive']({ kbId: 'KB' })).error).toMatch(/could not be reached/);
    expect(calls.rpc.some((c) => c.name === 'kb_attachments_list')).toBe(false);
  });
  it('tells a failure after sending from one before it', () => {
    expect(mayHaveArrived(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(mayHaveArrived(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))).toBe(true);
    expect(mayHaveArrived(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe(false);
    expect(mayHaveArrived(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe(false);
  });
});

describe('the GitHub sign-in for synced folders', () => {
  it('a cancelled sign-in is a cancel, and kb-sync-cancel ends a waiting sign-in', async () => {
    const { s, calls } = harness({ signIn: async () => { throw Object.assign(new Error('The sign-in was cancelled.'), { code: 'canceled' }); } });
    expect(await s.handlers['kb-sync-attach-github']({ kbId: 'KB', url: 'https://github.com/octo/handbook' })).toEqual({ canceled: true });
    expect(calls.relay.length).toBe(0);
    expect(await s.handlers['kb-sync-cancel']()).toEqual({ canceled: true });
    expect(calls.cancels).toBe(1);
  });
  it('lists the relay grants and disconnects one', async () => {
    const { s, calls } = harness({ grants: [{ provider: 'github', account: 'octocat', shared_with_mac: false, attachments: [] }] });
    expect((await s.handlers['kb-sync-grants']()).grants[0].provider).toBe('github');
    expect(await s.handlers['kb-sync-grant-disconnect']({ provider: 'github', mode: 'pause' })).toEqual({ paused: 1, removed: 0 });
    expect(calls.rpc.at(-1)).toEqual({ name: 'kb_sync_grant_disconnect', args: { workspace_id: 'W', provider: 'github', mode: 'pause' } });
    expect((await s.handlers['kb-sync-grant-disconnect']({ provider: 'github', mode: 'wipe' })).error).toMatch(/pause or remove/);
  });
  it('names the grant on Settings, Connections', () => {
    expect(grantLabel({ provider: 'github' })).toBe('GitHub (synced folders)');
    expect(grantLine({ account: 'octocat', attachments: [{ name: 'octo/handbook' }] })).toBe('octocat · Used by octo/handbook');
    expect(grantLine({ account: null, attachments: [] })).toBe('No synced folder uses it');
  });
});

describe('cancelling a waiting sign-in', () => {
  it('rejects the wait as canceled and frees the loopback port', async () => {
    const { awaitLoopback, cancelLoopback } = await import('../sources/oauth.js');
    const port = 47000 + Math.floor(Math.random() * 500);
    const waiting = awaitLoopback({ port });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelLoopback()).toBe(true);
    await expect(waiting).rejects.toMatchObject({ code: 'canceled' });
    expect(cancelLoopback()).toBe(false);
    // the port is free again: a new wait listens on it, and is ended the same way
    const again = awaitLoopback({ port });
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelLoopback()).toBe(true);
    await expect(again).rejects.toMatchObject({ code: 'canceled' });
  });
});
