// the hosted edition's account: Supabase Auth with a 6-digit email code, the chosen workspace, invites and the sync
// switch. Pure Node, no electron import, so a script can drive the same handlers the IPC does.
import { createClient } from '@supabase/supabase-js';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import store from './store/index.js';
import { createSync } from './sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(homedir(), 'Library/Application Support/Quorum');
const AUTH_FILE = path.join(DIR, 'auth.json');

// npm start has no .env loader, so the repo root's .env fills the two Supabase values when the shell did not
export function loadEnv(file = path.resolve(here, '../.env')) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// the session lives in one file only this user can read; supabase-js reads and writes it through this adapter
function fileStorage() {
  const read = () => { try { return JSON.parse(readFileSync(AUTH_FILE, 'utf8')); } catch { return {}; } };
  const write = (data) => { mkdirSync(DIR, { recursive: true }); writeFileSync(AUTH_FILE, JSON.stringify(data), { mode: 0o600 }); try { chmodSync(AUTH_FILE, 0o600); } catch {} };
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => write({ ...read(), [k]: v }),
    removeItem: (k) => { const d = read(); delete d[k]; write(d); },
  };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// what the UI shows when something fails: a plain sentence, never a server message with internals
export function plain(err, fallback = 'Something went wrong. Try again.') {
  const msg = String(err?.message ?? err ?? '').trim();
  const code = String(err?.code ?? '');
  if (/rate limit|too many/i.test(msg) || code.includes('rate_limit')) return 'Too many emails were sent. Wait an hour and try again.';
  if (/expired|invalid|otp/i.test(msg) && /token|otp|code/i.test(msg)) return 'That code is wrong or has expired. Ask for a new one.';
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)) return 'Quorum could not reach the server. Check your connection.';
  if (/not signed in|JWT|session/i.test(msg)) return 'You are signed out. Sign in again.';
  // the RPCs raise full sentences meant for people; those pass through, SQL-shaped messages do not
  if (code.startsWith('P0') && msg && !/[(){};]|column|relation|syntax/i.test(msg)) return msg.endsWith('.') ? msg : `${msg}.`;
  return fallback;
}

export function createAccount({ settings, saveSettings, log = () => {}, brain = () => null, meetingIndex = () => [], isExcluded, isExcludedText } = {}) {
  if (!process.env.QUORUM_SUPABASE_URL || !process.env.QUORUM_SUPABASE_ANON_KEY) loadEnv();
  const { QUORUM_SUPABASE_URL: url, QUORUM_SUPABASE_ANON_KEY: key } = process.env;
  const client = url && key ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: fileStorage() } }) : null;
  const state = { configured: !!client, signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [], sync: settings.sync === true, lastSyncAt: null, syncError: null };
  const listeners = new Set();
  const snapshot = () => JSON.parse(JSON.stringify(state));
  const emit = () => { for (const l of listeners) { try { l(snapshot()); } catch {} } };
  const fail = (err, fallback) => { log('account', err?.message ?? err); return { error: plain(err, fallback) }; };
  const NOT_CONFIGURED = { error: 'Hosted accounts are not set up in this build.' };
  const SIGNED_OUT = { error: 'Sign in first.' };
  const NO_WORKSPACE = { error: 'Pick a workspace first.' };

  const account = {
    client: () => client,
    state: snapshot,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    markSync: ({ lastSyncAt, syncError }) => { if (lastSyncAt !== undefined) state.lastSyncAt = lastSyncAt; if (syncError !== undefined) state.syncError = syncError; emit(); },
  };
  const sync = createSync({ account, store, brain, log, meetingIndex, isExcluded, isExcludedText });

  const row = (w, role) => ({ id: w.id, name: w.name, domain: w.domain ?? null, domainJoin: w.domain_join !== false, role });
  const signedOut = () => { Object.assign(state, { signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [] }); };
  const chooseWorkspace = (id) => {
    state.workspace = state.workspaces.find((w) => w.id === id) ?? state.workspaces[0] ?? null;
    if (settings.workspaceId !== (state.workspace?.id ?? null)) { settings.workspaceId = state.workspace?.id ?? null; saveSettings?.(); }
  };

  // one read of everything the account page shows: memberships, invites waiting for this email, domain matches
  async function refresh() {
    if (!client) return snapshot();
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session) { signedOut(); emit(); return snapshot(); }
      state.signedIn = true; state.email = session.user.email ?? null; state.userId = session.user.id;
      const [members, invites, domains] = await Promise.all([
        client.from('members').select('role, workspace:workspaces(id, name, domain, domain_join, deleted_at)').is('deleted_at', null),
        client.rpc('pending_invites'),
        client.rpc('domain_workspaces'),
      ]);
      for (const r of [members, invites, domains]) if (r.error) throw r.error;
      state.workspaces = (members.data ?? []).filter((m) => m.workspace && !m.workspace.deleted_at).map((m) => row(m.workspace, m.role)).sort((a, b) => a.name.localeCompare(b.name));
      state.invites = (invites.data ?? []).map((i) => ({ id: i.invite_id, workspaceId: i.workspace_id, workspaceName: i.workspace_name, role: i.role, invitedBy: i.invited_by_email ?? null, expiresAt: i.expires_at }));
      state.domainMatches = (domains.data ?? []).map((d) => ({ id: d.workspace_id, name: d.name }));
      chooseWorkspace(settings.workspaceId);
      state.syncError = null;
    } catch (err) {
      log('account refresh', err?.message ?? err);
      state.syncError = plain(err);
    }
    emit();
    return snapshot();
  }

  // members and open invites of the chosen workspace, the shape the Members page renders
  async function membersList() {
    if (!client) return NOT_CONFIGURED;
    if (!state.signedIn) return SIGNED_OUT;
    if (!state.workspace) return NO_WORKSPACE;
    const ws = state.workspace.id;
    const [members, invites] = await Promise.all([
      client.rpc('workspace_members', { ws }),
      client.from('invites').select('id, email, role, expires_at, user_id').eq('workspace_id', ws).is('accepted_at', null).is('deleted_at', null).order('created_at'),
    ]);
    if (members.error) return fail(members.error);
    if (invites.error) return fail(invites.error);
    return {
      members: (members.data ?? []).map((m) => ({ userId: m.user_id, email: m.email ?? null, name: m.name ?? null, role: m.role, joinedAt: m.joined_at })),
      invites: (invites.data ?? []).map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, invitedBy: i.user_id })),
    };
  }

  const guard = (fn) => async (...a) => {
    if (!client) return NOT_CONFIGURED;
    try { return await fn(...a); } catch (err) { return fail(err); }
  };
  const signedInGuard = (fn) => guard(async (...a) => (state.signedIn ? fn(...a) : SIGNED_OUT));
  const kickSync = () => { if (state.sync && state.workspace) sync.syncNow().catch(() => {}); };

  const handlers = {
    'account-status': () => (client ? refresh() : snapshot()),
    'account-send-code': guard(async (email) => {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(e)) return { error: 'Enter a full email address.' };
      const { error } = await client.auth.signInWithOtp({ email: e, options: { shouldCreateUser: true } });
      if (error) return fail(error, 'The code could not be sent. Try again in a minute.');
      return { ok: true, email: e };
    }),
    'account-verify-code': guard(async (email, code) => {
      const e = String(email ?? '').trim().toLowerCase(), token = String(code ?? '').replace(/\D/g, '');
      if (!EMAIL.test(e)) return { error: 'Enter a full email address.' };
      if (token.length !== 6) return { error: 'Enter the 6-digit code from the email.' };
      const { error } = await client.auth.verifyOtp({ email: e, token, type: 'email' });
      if (error) return fail(error, 'That code is wrong or has expired. Ask for a new one.');
      const s = await refresh();
      kickSync();
      return s;
    }),
    'account-sign-out': guard(async () => {
      try { await client.auth.signOut({ scope: 'local' }); } catch (err) { log('account sign-out', err?.message ?? err); }
      signedOut(); emit();
      return snapshot();
    }),
    'org-create': signedInGuard(async (name, domain, domainJoin) => {
      const { data, error } = await client.rpc('create_workspace', { name: String(name ?? '').trim(), domain: String(domain ?? '').trim().toLowerCase() || null, domain_join: domainJoin !== false });
      if (error) return fail(error, 'The workspace could not be created.');
      settings.workspaceId = data?.id ?? settings.workspaceId;
      const s = await refresh();
      kickSync();
      return s;
    }),
    'org-join': signedInGuard(async (how = {}) => {
      const r = how.inviteId ? await client.rpc('accept_invite', { invite_id: String(how.inviteId) }) : how.workspaceId ? await client.rpc('join_by_domain', { ws: String(how.workspaceId) }) : { error: new Error('nothing to join') };
      if (r.error) return fail(r.error, 'Quorum could not join that workspace.');
      settings.workspaceId = r.data ?? settings.workspaceId;
      const s = await refresh();
      kickSync();
      return s;
    }),
    'org-switch': signedInGuard(async (workspaceId) => {
      if (!state.workspaces.some((w) => w.id === workspaceId)) return { error: 'You are not a member of that workspace.' };
      chooseWorkspace(String(workspaceId));
      emit();
      kickSync();
      return snapshot();
    }),
    'members-list': guard(membersList),
    'member-invite': signedInGuard(async (email, role = 'member') => {
      if (!state.workspace) return NO_WORKSPACE;
      const { error } = await client.rpc('invite_member', { ws: state.workspace.id, email: String(email ?? '').trim().toLowerCase(), role: role === 'admin' ? 'admin' : 'member' });
      if (error) return fail(error, 'The invite could not be sent.');
      return membersList();
    }),
    'member-remove': signedInGuard(async (userId) => {
      if (!state.workspace) return NO_WORKSPACE;
      const { error } = await client.rpc('remove_member', { ws: state.workspace.id, user_id: String(userId) });
      if (error) return fail(error, 'That member could not be removed.');
      return membersList();
    }),
    'invite-revoke': signedInGuard(async (inviteId) => {
      if (!state.workspace) return NO_WORKSPACE;
      const { error } = await client.rpc('revoke_invite', { invite_id: String(inviteId) });
      if (error) return fail(error, 'That invite could not be revoked.');
      return membersList();
    }),
    'sync-set': (on) => {
      state.sync = on === true;
      if (settings.sync !== state.sync) { settings.sync = state.sync; saveSettings?.(); }
      emit();
      kickSync();
      return snapshot();
    },
    'sync-now': signedInGuard(async () => {
      if (!state.sync) return { error: 'Turn sync on first.' };
      if (!state.workspace) return NO_WORKSPACE;
      const r = await sync.syncNow();
      return r.error ? { error: r.error } : snapshot();
    }),
  };

  // a token refresh or sign-out from another path still reaches the UI; supabase-js asks that this callback stays quick
  client?.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') setTimeout(() => refresh().catch(() => {}), 0); });

  return { ...account, handlers, refresh, sync };
}

// wires the account into the main process: one IPC handler per entry, and every change goes to the UI as 'account'
export function registerAccount({ ipcMain, settings, saveSettings, toUI = () => {}, log = () => {}, brain, meetingIndex, isExcluded, isExcludedText }) {
  const acct = createAccount({ settings, saveSettings, log, brain, meetingIndex, isExcluded, isExcludedText });
  acct.onChange((s) => toUI('account', s));
  for (const [name, fn] of Object.entries(acct.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  acct.refresh().then((s) => { if (s.signedIn) log('account', s.email, s.workspace ? `workspace ${s.workspace.name}` : 'no workspace', s.sync ? 'sync on' : 'sync off'); if (s.sync && s.workspace) acct.sync.syncNow().catch(() => {}); }).catch((err) => log('account', err?.message ?? err));
  return acct;
}
