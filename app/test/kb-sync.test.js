import { describe, expect, it } from 'vitest';
import { ago, checkRepoUrl, lastSynced, noteCount, remoteLine, syncActions, syncStatus } from '../ee/src/kbSyncUi.ts';
const { createKbSync, githubTarget, DRIVE_FOLDER } = await import('../ee/kbSync.js');
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
    expect(checkRepoUrl('https://gitlab.com/octo/handbook')).toMatch(/GitHub repository address/);
  });
});

describe('the GitHub target', () => {
  it('reads the repository, branch and folder from an address', () => {
    expect(githubTarget('https://github.com/octo/handbook')).toMatchObject({ id: 'octo/handbook', branch: null, path: null, name: 'octo/handbook' });
    expect(githubTarget('https://github.com/octo/handbook/tree/main/docs/policies')).toMatchObject({ branch: 'main', path: 'docs/policies', name: 'octo/handbook/docs/policies' });
    expect(githubTarget('https://github.com/octo/handbook/tree/release/v2/docs', 'release/v2')).toMatchObject({ branch: 'release/v2', path: 'docs' });
    expect(githubTarget('https://github.com/octo/handbook/tree/main/docs', 'dev').error).toMatch(/does not match/);
    expect(githubTarget('nope').error).toBeTruthy();
  });
});

describe('the Drive picker for folder sync', () => {
  it('offers folders, one pick, and its own title', () => {
    const page = pickerPage({ apiKey: 'k', appId: '1', accessToken: 't', nonce: 'n', folders: true });
    expect(page).toContain('application/vnd.google-apps.folder');
    expect(page).toContain('"max":1');
    expect(page).toContain('Choose a folder or file to sync');
    const files = pickerPage({ apiKey: 'k', appId: '1', accessToken: 't', nonce: 'n' });
    expect(files).not.toContain('application/vnd.google-apps.folder,');
    expect(files).toContain('"folders":false');
  });
});

function harness({ role = 'admin', driveConnected = true, refreshToken = 'rt-drive', github = { refreshToken: 'gh-rt', account: 'octocat' }, relay = () => ({ status: 200, body: { attachment: { id: 'A1', name: 'Policies' } } }) } = {}) {
  const calls = { rpc: [], fetch: [], picks: [], signIns: [] };
  const kb = { id: 'KB', name: 'Handbook', role, folders: [{ id: 'F1', parent_id: null, name: 'Policies' }] };
  const rpc = async (name, args) => {
    calls.rpc.push({ name, args });
    if (name === 'kb_list') return { data: [kb], error: null };
    if (name === 'kb_attachments_list') return { data: [{ id: 'A1' }], error: null };
    if (name === 'kb_attachment_remove') return { data: 3, error: null };
    if (name === 'kb_sync_disconnect') return { data: 1, error: null };
    return { data: { id: args.id, status: 'paused' }, error: null };
  };
  const account = {
    client: () => ({ rpc, auth: { getSession: async () => ({ data: { session: { access_token: 'session-jwt' } } }) } }),
    state: () => ({ signedIn: true, userId: 'U', workspace: { id: 'W', role: 'admin' } }),
    envStatus: () => ({ config: 'production' }),
  };
  const accounts = { list: () => [{ id: 'google-drive', connected: driveConnected, account: 'ana@example.com' }], accessToken: async () => 'drive-access' };
  const fetch = async (url, init) => { calls.fetch.push({ url, init, body: JSON.parse(init.body) }); const r = relay(); return { ok: r.status < 300, status: r.status, json: async () => r.body }; };
  const s = createKbSync({
    account, accounts, fetch, picker: { apiKey: 'k', appId: '1' },
    pick: async (o) => { calls.picks.push(o); return { files: [{ id: 'folder-123', name: 'Policies', mimeType: DRIVE_FOLDER }] }; },
    refreshTokenOf: async () => refreshToken,
    signIn: async (id) => { calls.signIns.push(id); return github; },
  });
  return { s, calls };
}

describe('the synced folders IPC', () => {
  it('attaches a Drive folder with the Keychain grant, marked as shared with the Mac', async () => {
    const { s, calls } = harness();
    const r = await s.handlers['kb-sync-attach-drive']({ kbId: 'KB', folderId: 'F1' });
    expect(r.attachment.id).toBe('A1');
    expect(calls.picks[0]).toMatchObject({ folders: true, accessToken: 'drive-access' });
    const { url, init, body } = calls.fetch[0];
    expect(url).toMatch(/\/v1\/kb-sync\/attach$/);
    expect(init.headers.authorization).toBe('Bearer session-jwt');
    expect(body).toMatchObject({ kb_id: 'KB', folder_id: 'F1', provider: 'google-drive', refresh_token: 'rt-drive', shared_with_mac: true, remote: { id: 'folder-123', kind: 'folder', name: 'Policies' } });
  });

  it('attaches a GitHub repository with a sign-in of its own', async () => {
    const { s, calls } = harness();
    await s.handlers['kb-sync-attach-github']({ kbId: 'KB', url: 'https://github.com/octo/handbook/tree/main/docs' });
    expect(calls.signIns).toEqual(['github']);
    expect(calls.fetch[0].body).toMatchObject({ provider: 'github', refresh_token: 'gh-rt', shared_with_mac: false, remote: { id: 'octo/handbook', kind: 'folder', branch: 'main', path: 'docs' } });
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
    expect(calls.rpc.map((c) => c.name)).toEqual(['kb_attachments_list', 'kb_attachment_pause', 'kb_attachment_sync_now', 'kb_attachment_remove', 'kb_sync_disconnect']);
    expect(calls.rpc[1].args).toEqual({ id: 'A1', paused: true });
    expect(calls.rpc[4].args).toEqual({ workspace_id: 'W', provider: 'google-drive' });
  });
});
