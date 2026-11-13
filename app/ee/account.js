// the hosted edition's account: Supabase Auth with a 6-digit email code, the chosen workspace, invites and the sync
// switch. Pure Node, no electron import, so a script can drive the same handlers the IPC does.
import { createClient } from '@supabase/supabase-js';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import store from '../store/index.js';
import { DATA_DIR, ENV, isDevelopment } from '../edition.js';
import { codeChars } from '../betaCode.js';
import { createSync } from './sync.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
// The local Supabase stack (supabase start) listens here and ships one anon key that is the same for every local
// stack; the CLI prints it on start. resolveCloudConfig reads the live values from `supabase status` when the CLI is
// on PATH and falls back to these, so a development copy signs in to the local stack with no .env.development at all.
const LOCAL_STACK = { url: 'http://127.0.0.1:54321', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' };

// reads KEY=value lines from a dotenv-style file into a plain object; missing file gives {}
export function readEnvFile(file) {
  const out = {};
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// npm start has no .env loader, so the repo root's .env fills the two Supabase values when the shell did not
export function loadEnv(file = path.join(ROOT, '.env')) {
  for (const [k, v] of Object.entries(readEnvFile(file))) if (!(k in process.env)) process.env[k] = v;
}

// the local stack's live URL and anon key from the CLI, when it is installed and the stack is up; null otherwise
function localStackStatus() {
  try {
    const out = execFileSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const vars = {};
    for (const line of out.split('\n')) { const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/); if (m) vars[m[1]] = m[2]; }
    const url = vars.API_URL, key = vars.ANON_KEY || vars.PUBLISHABLE_KEY;
    return url && key ? { url, key } : null;
  } catch { return null; }
}

// Which Supabase project this process talks to (docs/self-hosting.md, Development). In order:
//  1. QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY already in the shell environment ('shell')
//  2. production, or a development copy with settings.devUseProduction on: the repo root's .env ('production')
//  3. development: .env.development when present ('development'), else the local stack ('local')
// Production never falls back to the local stack: without .env it stays unconfigured.
function packagedCloudConfig() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).quorumCloud ?? null; } catch { return null; }
}

export function resolveCloudConfig(settings = {}) {
  const env = ENV;
  const useProduction = isDevelopment && settings.devUseProduction === true;
  const base = { env, useProduction, url: null, key: null };
  if (process.env.QUORUM_SUPABASE_URL && process.env.QUORUM_SUPABASE_ANON_KEY) return { ...base, source: 'shell', url: process.env.QUORUM_SUPABASE_URL, key: process.env.QUORUM_SUPABASE_ANON_KEY };
  if (!isDevelopment || useProduction) {
    const prod = readEnvFile(path.join(ROOT, '.env'));
    if (prod.QUORUM_SUPABASE_URL && prod.QUORUM_SUPABASE_ANON_KEY) return { ...base, source: 'production', url: prod.QUORUM_SUPABASE_URL, key: prod.QUORUM_SUPABASE_ANON_KEY };
    // the installed build has no repo file; package:cloud writes the values into the packaged package.json (scripts/package-cloud.mjs)
    const packaged = packagedCloudConfig();
    return { ...base, source: 'production', url: packaged?.url ?? null, key: packaged?.anonKey ?? null };
  }
  const dev = readEnvFile(path.join(ROOT, '.env.development'));
  if (dev.QUORUM_SUPABASE_URL && dev.QUORUM_SUPABASE_ANON_KEY) return { ...base, source: 'development', url: dev.QUORUM_SUPABASE_URL, key: dev.QUORUM_SUPABASE_ANON_KEY };
  return { ...base, source: 'local', ...(localStackStatus() ?? LOCAL_STACK) };
}

// the session and the sync id map live next to settings.json; a development copy pointed at production keeps both
// apart from its local-stack files, so switching back and forth never mixes sessions or ids between projects
const perConfig = (cloud, name, ext) => path.join(DATA_DIR, `${name}${cloud.useProduction ? '-production' : ''}.${ext}`);

// the session lives in one file only this user can read; supabase-js reads and writes it through this adapter
function fileStorage(file) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); try { chmodSync(file, 0o600); } catch {} };
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

// The browser lands here after Google: quorum://auth/callback?code=… from the installed app, or the loopback URL a
// development copy listens on. Supabase reports a refused sign-up in the same place as error_description.
export const OAUTH_LOOPBACK = 'http://127.0.0.1:47831/auth/callback';
export function parseOAuthReturn(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!`${u.host}${u.pathname}`.endsWith('auth/callback')) return null;
  const q = u.searchParams;
  const desc = q.get('error_description') || q.get('error');
  if (desc) {
    if (/database error saving new user/i.test(desc)) return { error: 'That Google account has no Quorum account yet. Quorum Cloud is invite-only: sign in with your email and access code first, then Google works for that address.' };
    return { error: /^[\w\s'.,-]+$/.test(desc) ? desc.replace(/\+/g, ' ') : 'Google sign-in did not complete. Try again.' };
  }
  const code = q.get('code');
  return code ? { code } : { error: 'Google sign-in did not complete. Try again.' };
}

export function createAccount({ settings, saveSettings, log = () => {}, brain = () => null, meetingIndex = () => [], isExcluded, isExcludedText, openExternal = null, oauthRedirect = () => null } = {}) {
  let cloud = resolveCloudConfig(settings);
  const makeClient = (c) => (c.url && c.key ? createClient(c.url, c.key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storage: fileStorage(perConfig(c, 'auth', 'json')) } }) : null);
  let client = makeClient(cloud);
  // live is whether the Realtime channel is subscribed (sync.js live()); the UI shows "Live" or "Polling" from it
  const state = { configured: !!client, signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [], sync: settings.sync === true, lastSyncAt: null, lastPullAt: null, syncError: null, live: false };
  const listeners = new Set();
  const snapshot = () => JSON.parse(JSON.stringify(state));
  // every state change also lets sync.js bring its channel and watcher in line with the sign-in, switch and workspace
  const emit = () => { for (const l of listeners) { try { l(snapshot()); } catch {} } inner?.live(); };
  const fail = (err, fallback) => { log('account', err?.message ?? err); return { error: plain(err, fallback) }; };
  const NOT_CONFIGURED = { error: 'Hosted accounts are not set up in this build.' };
  const SIGNED_OUT = { error: 'Sign in first.' };
  const NO_WORKSPACE = { error: 'Pick a workspace first.' };

  const account = {
    client: () => client,
    state: snapshot,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    markSync: ({ lastSyncAt, lastPullAt, syncError, live }) => { if (lastSyncAt !== undefined) state.lastSyncAt = lastSyncAt; if (lastPullAt !== undefined) state.lastPullAt = lastPullAt; if (syncError !== undefined) state.syncError = syncError; if (live !== undefined) state.live = live; emit(); },
  };
  const makeSync = (c) => createSync({ account, store, brain, log, meetingIndex, isExcluded, isExcludedText, idsFile: perConfig(c, 'sync-ids', 'json') });
  let inner = makeSync(cloud);
  // main.js keeps one reference to sync; the developer switch below swaps what sits behind it. A full sync pulls
  // first so a remote edit lands before the local copy of the same note goes up.
  const sync = {
    pushNote: (...a) => inner.pushNote(...a),
    pushMeetingNote: (...a) => inner.pushMeetingNote(...a),
    pullNow: () => inner.pullNow(),
    syncNow: async () => { const pulled = await inner.pullNow(); const pushed = await inner.syncNow(); return pushed.error ? pushed : { ...pushed, pulled: pulled.error ? null : pulled }; },
    live: () => inner.live(),
    status: () => inner.status(),
  };
  // while signed in with sync on, other devices' changes arrive over the Realtime channel (sync.js live()); this timer
  // is the fallback for the time a dropped socket takes to rejoin
  const PULL_EVERY = 3 * 60 * 1000;
  const pullTimer = setInterval(() => { if (state.sync && state.signedIn && state.workspace) inner.pullNow().catch(() => {}); }, PULL_EVERY);
  pullTimer.unref?.();
  // what the renderer may know about the connection: environment, which config is active and the project's host. The
  // key stays in the main process.
  const envStatus = () => ({ env: cloud.env, config: cloud.source, host: cloud.url ? new URL(cloud.url).host : null, useProduction: cloud.useProduction, configured: !!client });

  const row = (w, role) => ({ id: w.id, name: w.name, domain: w.domain ?? null, domainJoin: w.domain_join !== false, role, teamEnabled: w.team_enabled === true });
  const signedOut = () => { Object.assign(state, { signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [] }); };
  const chooseWorkspace = (id) => {
    state.workspace = state.workspaces.find((w) => w.id === id) ?? state.workspaces[0] ?? null;
    if (settings.workspaceId !== (state.workspace?.id ?? null)) { settings.workspaceId = state.workspace?.id ?? null; saveSettings?.(); }
  };

  // the memberships with their workspace rows; team_enabled came with migration 0019, so a project without it is asked
  // once more without the column and every workspace reads as team off
  let teamColumn = true;
  const memberships = async () => {
    const select = (withTeam) => client.from('members').select(`role, workspace:workspaces(id, name, domain, domain_join, ${withTeam ? 'team_enabled, ' : ''}deleted_at)`).is('deleted_at', null);
    let r = await select(teamColumn);
    if (r.error && teamColumn && /team_enabled/.test(r.error.message ?? '')) { teamColumn = false; log('account', 'workspaces have no team_enabled column (migration 0019); teams read as off'); r = await select(false); }
    return r;
  };

  // one read of everything the account page shows: memberships, invites waiting for this email, domain matches
  async function refresh() {
    if (!client) return snapshot();
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session) { signedOut(); emit(); return snapshot(); }
      state.signedIn = true; state.email = session.user.email ?? null; state.userId = session.user.id;
      const [members, invites, domains] = await Promise.all([
        memberships(),
        client.rpc('pending_invites'),
        client.rpc('domain_workspaces'),
      ]);
      for (const r of [members, invites, domains]) if (r.error) throw r.error;
      state.workspaces = (members.data ?? []).filter((m) => m.workspace && !m.workspace.deleted_at).map((m) => row(m.workspace, m.role)).sort((a, b) => a.name.localeCompare(b.name));
      state.invites = (invites.data ?? []).map((i) => ({ id: i.invite_id, inviteId: i.invite_id, workspaceId: i.workspace_id, workspaceName: i.workspace_name, role: i.role, invitedBy: i.invited_by_email ?? null, invitedByEmail: i.invited_by_email ?? null, expiresAt: i.expires_at }));
      state.domainMatches = (domains.data ?? []).map((d) => ({ id: d.workspace_id, workspaceId: d.workspace_id, name: d.name }));
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
      invites: (invites.data ?? []).map((i) => ({ id: i.id, inviteId: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, invitedBy: i.user_id })),
    };
  }

  const guard = (fn) => async (...a) => {
    if (!client) return NOT_CONFIGURED;
    try { return await fn(...a); } catch (err) { return fail(err); }
  };
  const signedInGuard = (fn) => guard(async (...a) => (state.signedIn ? fn(...a) : SIGNED_OUT));
  const oauthListeners = new Set();
  account.onOAuth = (fn) => { oauthListeners.add(fn); return () => oauthListeners.delete(fn); };
  const oauthDone = (r) => { for (const l of oauthListeners) { try { l(r); } catch {} } return r; };
  // the deep link or loopback visit that ends a Google sign-in; returns what the UI should show
  account.finishOAuth = async (url) => {
    const r = parseOAuthReturn(url);
    if (!r) return null;
    if (r.error) return oauthDone({ error: r.error });
    if (!client) return oauthDone(NOT_CONFIGURED);
    const { error } = await client.auth.exchangeCodeForSession(r.code);
    if (error) { log('account oauth', error.message); return oauthDone({ error: plain(error, 'Google sign-in did not complete. Try again.') }); }
    await refresh();
    kickSync();
    return oauthDone({ ok: true });
  };
  let loopback = null;
  const listenLoopback = () => {
    if (loopback) return;
    const port = Number(new URL(OAUTH_LOOPBACK).port);
    const close = () => { loopback?.close(); loopback = null; };
    loopback = http.createServer(async (req, res) => {
      const r = await account.finishOAuth(`http://127.0.0.1:${port}${req.url}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Quorum</title><body style="font: 16px -apple-system, sans-serif; padding: 40px; color: #111"><p>${r?.error ? r.error : 'Signed in. You can close this tab and go back to Quorum.'}</p>`);
      if (r) close();
    });
    loopback.on('error', (err) => { log('account oauth loopback', err.message); close(); });
    loopback.listen(port, '127.0.0.1');
    setTimeout(close, 5 * 60 * 1000).unref();
  };
  const kickSync = () => { if (state.sync && state.workspace) sync.syncNow().catch(() => {}); };

  const handlers = {
    'account-status': () => (client ? refresh() : snapshot()),
    // sign-up is gated (migration 0009): a new email needs an access code from the platform owner before the sign-in
    // email goes out. The code is claimed here; the trigger on auth.users redeems it when the account is created
    'account-send-code': guard(async (email, accessCode) => {
      const e = String(email ?? '').trim().toLowerCase();
      if (!EMAIL.test(e)) return { error: 'Enter a full email address.' };
      const needed = await client.rpc('access_code_needed', { email: e });
      if (needed.error) log('account access_code_needed', needed.error.message);
      if (needed.data === true) {
        // the same reading as the beta gate: dash and spaces dropped, uppercase, 0 as O and 1 as I
        const code = codeChars(accessCode).join('');
        if (!code) return { needsCode: true, email: e };
        const claim = await client.rpc('access_code_claim', { email: e, code });
        if (claim.error) return fail(claim.error, 'That access code is not valid for this email.');
      }
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
    // Google through the system browser (PKCE). The installed app gets the code back on quorum://auth/callback; a
    // development copy cannot register that scheme, so it listens on the loopback URL for one visit instead
    'account-google': guard(async () => {
      const redirectTo = oauthRedirect();
      if (!redirectTo || !openExternal) return { error: 'Google sign-in is not available in this build.' };
      const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } });
      if (error || !data?.url) return fail(error, 'Google sign-in could not start.');
      if (redirectTo === OAUTH_LOOPBACK) listenLoopback();
      await openExternal(data.url);
      return { ok: true };
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
    // the Teams page's switch (migration 0019): owners and admins turn the team-level pages on for the workspace
    'team-enabled-set': signedInGuard(async (on) => {
      if (!state.workspace) return NO_WORKSPACE;
      if (state.workspace.role === 'member') return { error: 'Only owners and admins can enable a team.' };
      const { error } = await client.rpc('workspace_set_team_enabled', { ws: state.workspace.id, enabled: on === true });
      if (error) return fail(error, 'The team setting could not be saved.');
      return refresh();
    }),
    'invite-revoke': signedInGuard(async (inviteId) => {
      if (!state.workspace) return NO_WORKSPACE;
      const { error } = await client.rpc('revoke_invite', { invite_id: String(inviteId) });
      if (error) return fail(error, 'That invite could not be revoked.');
      return membersList();
    }),
    // the paywall on the app side: sync turns on only for a workspace with Cloud service (paid, cloud or internal)
    'sync-set': async (on) => {
      if (on === true && client && state.signedIn && state.workspace) {
        try {
          const { data } = await client.rpc('workspace_billing', { workspace_id: state.workspace.id });
          if (data && !['paid', 'cloud', 'internal'].includes(data.plan)) return { ...snapshot(), error: 'Sync starts with a Quorum Cloud subscription. An owner or admin can start it in Settings › Admin.' };
        } catch (err) { log('sync plan check', err?.message ?? err); }
      }
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
      return r.error ? { error: r.error } : { ...snapshot(), pushed: { notes: r.pushed, meetings: r.meetings }, pulled: r.pulled ? { notes: r.pulled.written, conflicts: r.pulled.conflicts, removed: r.pulled.removed } : null };
    }),
    'env-status': envStatus,
    // the developer switch (docs/self-hosting.md, Development): a development copy loads the production .env instead of
    // its own config. The setting is written, the client is rebuilt against the other project with its own session
    // file, and the account state is re-read. Production builds ignore the call.
    'env-set-production': async (on) => {
      if (!isDevelopment) return envStatus();
      const next = on === true;
      if ((settings.devUseProduction === true) !== next) { settings.devUseProduction = next; saveSettings?.(); }
      connect();
      await refresh();
      log('env', `${cloud.env}, config ${cloud.source}`, cloud.url ? new URL(cloud.url).host : 'unconfigured');
      return envStatus();
    },
  };

  // builds the client and sync for the current config and watches its auth events. A token refresh or sign-out from
  // another path still reaches the UI; supabase-js asks that the callback stays quick.
  let authWatch = null;
  function connect() {
    authWatch?.unsubscribe();
    authWatch = null;
    cloud = resolveCloudConfig(settings);
    client = makeClient(cloud);
    inner?.stop();
    inner = makeSync(cloud);
    state.configured = !!client;
    signedOut();
    authWatch = client?.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') setTimeout(() => refresh().catch(() => {}), 0); }).data.subscription ?? null;
  }
  connect();

  // the signed-in email. getSession refreshes an expired token over the network and answers no session when that
  // fails, so an offline Mac falls back to the stored session; a sign-out or a refused refresh removes it from the file
  const storedEmail = () => {
    const all = (() => { try { return JSON.parse(readFileSync(perConfig(cloud, 'auth', 'json'), 'utf8')); } catch { return {}; } })();
    for (const [k, v] of Object.entries(all)) {
      if (!k.endsWith('-auth-token')) continue;
      try { const s = typeof v === 'string' ? JSON.parse(v) : v; if (s?.refresh_token && s?.user?.email) return s.user.email; } catch {}
    }
    return null;
  };
  const sessionEmail = async () => {
    if (!client) return null;
    try { const { data } = await client.auth.getSession(); if (data?.session?.user?.email) return data.session.user.email; } catch {}
    return storedEmail();
  };
  return { ...account, handlers, refresh, sync, envStatus, sessionEmail, stop: () => { clearInterval(pullTimer); inner.stop(); } };
}

// wires the account into the main process: one IPC handler per entry, and every change goes to the UI as 'account'
export function registerAccount({ ipcMain, settings, saveSettings, toUI = () => {}, log = () => {}, brain, meetingIndex, isExcluded, isExcludedText, openExternal, oauthRedirect }) {
  const acct = createAccount({ settings, saveSettings, log, brain, meetingIndex, isExcluded, isExcludedText, openExternal, oauthRedirect });
  acct.onChange((s) => toUI('account', s));
  acct.onOAuth((r) => toUI('account-oauth', r));
  for (const [name, fn] of Object.entries(acct.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  const e = acct.envStatus();
  log('env', `${e.env}, config ${e.config}`, e.host ?? 'unconfigured');
  acct.refresh().then((s) => { if (s.signedIn) log('account', s.email, s.workspace ? `workspace ${s.workspace.name}` : 'no workspace', s.sync ? 'sync on' : 'sync off'); if (s.sync && s.workspace) acct.sync.syncNow().catch(() => {}); }).catch((err) => log('account', err?.message ?? err));
  return acct;
}
