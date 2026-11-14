#!/usr/bin/env node
// End-to-end run of the KB sync worker against a real database and PostgREST, with the providers replaced by a fake
// Google Drive and GitHub on localhost. Not part of npm test: it needs the local Supabase stack. It runs against a
// throwaway copy of the local database (E2E_DB, quorum_e2e by default) behind its own PostgREST (E2E_REST_URL), so the
// shared local database is not changed. From relay/:
//   bash test/e2e/stack.sh up                                   the copy, 0032 on it, and its PostgREST on port 54399
//   E2E_JWT_ENV=<file stack.sh names> node test/e2e/kbSync.e2e.mjs
//   bash test/e2e/stack.sh down                                 drops the copy
// The service role key comes from `supabase status -o env`.
// It prints one line per step and never prints a key or a token.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgrestClient } from '@supabase/postgrest-js';
import { createKbSyncWorker } from '../../kbSync/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const DB = process.env.E2E_DB || 'quorum_e2e';
const REST = process.env.E2E_REST_URL || 'http://127.0.0.1:54399';
if (DB === 'postgres' && process.env.E2E_ALLOW_SHARED !== '1') throw new Error('E2E_DB is the shared local database; use a copy, or set E2E_ALLOW_SHARED=1');

const serviceKey = (() => {
  const out = execFileSync('supabase', ['status', '-o', 'env'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const line = out.split('\n').find((l) => l.startsWith('SERVICE_ROLE_KEY='));
  if (!line) throw new Error('supabase status gave no SERVICE_ROLE_KEY');
  return line.slice('SERVICE_ROLE_KEY='.length).replace(/^"|"$/g, '');
})();
const db = new PostgrestClient(REST, { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } });

// a signed-in admin's token, signed with the stack's JWT secret (E2E_JWT_ENV holds PGRST_JWT_SECRET), for the RPCs a
// person calls (Remove); null when the secret is not a shared HMAC secret
function userToken(sub) {
  const file = process.env.E2E_JWT_ENV;
  if (!file) return null;
  const raw = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('PGRST_JWT_SECRET='))?.slice('PGRST_JWT_SECRET='.length);
  if (!raw) return null;
  let secret = raw;
  if (raw.startsWith('{')) {
    const jwk = (JSON.parse(raw).keys ?? [JSON.parse(raw)]).find((k) => k.kty === 'oct');
    if (!jwk) return null;
    secret = Buffer.from(jwk.k, 'base64url');
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const psql = (sql) => execFileSync('docker', ['exec', '-i', 'supabase_db_quorum', 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-tAq'], { input: sql, encoding: 'utf8' }).trim();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };

// the fake providers. Every request the worker makes goes to https://<host>/...; fetchImpl sends it here instead
const drive = { files: new Map(), docs: new Map() };
const gh = { head: 'c1', tree: [], blobs: new Map(), limited: false };
const seen = [];
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://fake');
  const [, host, ...rest] = u.pathname.split('/');
  const p = `/${rest.join('/')}`;
  let body = '';
  for await (const c of req) body += c;
  seen.push(`${req.method} ${host}${p}`);
  if (host === 'oauth2.googleapis.com' && p === '/token') return send(res, 200, { access_token: 'drive-access', expires_in: 3600 });
  if (host === 'github.com' && p === '/login/oauth/access_token') return send(res, 200, { access_token: 'gh-access', refresh_token: `gh-rt-${Date.now()}`, expires_in: 28800 });
  if (host === 'www.googleapis.com') {
    if (p === '/drive/v3/files' && u.searchParams.get('q')) {
      const parent = u.searchParams.get('q').match(/'([^']+)' in parents/)[1];
      return send(res, 200, { files: [...drive.files.values()].filter((f) => f.parent === parent).map(({ parent: _p, ...f }) => f) });
    }
    const m = p.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (m && m[2]) return send(res, 200, drive.docs.get(m[1]) ?? '# Doc');
    if (m && u.searchParams.get('alt') === 'media') return send(res, 200, drive.docs.get(m[1]) ?? '# File');
    if (m && m[1] === 'root-folder') return send(res, 200, { id: 'root-folder', name: 'Policies', mimeType: 'application/vnd.google-apps.folder' });
    if (m && drive.files.has(m[1])) return send(res, 200, drive.files.get(m[1]));
  }
  if (host === 'api.github.com') {
    if (gh.limited) return send(res, 403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, { 'retry-after': '120' });
    if (/\/branches\/main$/.test(p)) return send(res, 200, { commit: { sha: gh.head } });
    if (/\/git\/trees\//.test(p)) return send(res, 200, { tree: gh.tree, truncated: false });
    const b = p.match(/\/git\/blobs\/(.+)$/);
    if (b) return send(res, 200, { content: Buffer.from(gh.blobs.get(b[1]) ?? '').toString('base64'), encoding: 'base64' });
  }
  send(res, 404, { error: { errors: [{ reason: 'notFound' }] } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const fetchImpl = (url, init) => fetch(String(url).replace(/^https:\/\/([^/]+)/, `http://127.0.0.1:${port}/$1`), init);
const config = { oauth: { google: { clientId: 'e2e-google', clientSecret: 'e2e-google-secret' }, github: { clientId: 'e2e-gh', clientSecret: 'e2e-gh-secret' } }, kbSync: {} };
const logs = [];
const worker = createKbSyncWorker({ db, config, fetchImpl, log: (e, f) => logs.push(JSON.stringify({ e, ...f })), settings: { renewEveryMs: 0, lockWaitMs: 50 } });
const due = (id) => psql(`update public.kb_attachments set next_run_at = now() - interval '1 second', lease_until = null, lease_owner = null where id = '${id}';`);

try {
  // fixtures: an owner who is the KB's admin, a paid team workspace with Google Drive and GitHub approved, one KB
  const ADMIN = '00000000-0000-4000-8000-00000000e2e1';
  const WS = '01KG00000000000000000E2EWS';
  psql(`
    create or replace function public.auth_user_gate() returns trigger language plpgsql as $$ begin return new; end $$;
    delete from public.workspaces where id = '${WS}';
    delete from auth.users where id = '${ADMIN}';
    insert into auth.users (id, email, aud, role) values ('${ADMIN}', 'e2e-admin@example.com', 'authenticated', 'authenticated');
    insert into public.workspaces (id, user_id, name, team_enabled, plan) values ('${WS}', '${ADMIN}', 'E2E Team', true, 'paid');
    insert into public.workspace_integrations (workspace_id, provider, mode) values ('${WS}', 'google-drive', 'personal'), ('${WS}', 'github', 'personal');
    insert into public.knowledge_bases (id, workspace_id, name, created_by) values ('01KG00000000000000000E2EKB', '${WS}', 'Handbook', '${ADMIN}');
    insert into public.kb_folders (id, kb_id, name) values ('01KG00000000000000000E2EF1', '01KG00000000000000000E2EKB', 'Policies');`);
  const KB = '01KG00000000000000000E2EKB';
  check(psql(`select count(*) from public.members where workspace_id = '${WS}' and user_id = '${ADMIN}'`) === '1', 'the owner is a member of the workspace');

  drive.files.set('d1', { id: 'd1', parent: 'root-folder', name: 'Leave', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-01T00:00:00.000Z' });
  drive.docs.set('d1', '# Leave\n\nTwenty days a year.\n');
  gh.tree = [{ path: 'docs/intro.md', type: 'blob', sha: 'b1' }];
  gh.blobs.set('b1', '# Intro\n');

  // 1. attach, through the same RPC the relay's attach route calls with the service role
  const attach = async (args) => { const { data, error } = await db.rpc('kb_sync_attach', { uid: ADMIN, kb_id: KB, url: null, client: 'quorum', account: null, ...args }); if (error) throw new Error(`attach: ${error.message}`); return data; };
  const driveAtt = await attach({ folder_id: '01KG00000000000000000E2EF1', provider: 'google-drive', remote_id: 'root-folder', remote_kind: 'folder', options: {}, name: 'Policies', token: 'rt-e2e-drive', shared_with_mac: true });
  const ghAtt = await attach({ folder_id: null, provider: 'github', remote_id: 'octo/handbook', remote_kind: 'folder', options: { branch: 'main', path: 'docs' }, name: 'octo/handbook', token: 'gh-rt-e2e', shared_with_mac: false });
  check(driveAtt?.status === 'pending' && ghAtt?.status === 'pending', 'attach stores both attachments, pending');
  check(psql(`select count(*) from public.kb_sync_grants g join vault.secrets s on s.id = g.secret_id where g.user_id = '${ADMIN}'`) === '2', 'both tokens are in Vault');

  // 2. the first sync writes the notes as the attaching admin, with their upstream bases
  const r1 = await worker.tick();
  check(r1.length === 2 && r1.every((r) => r.ok), `the first tick syncs both (${JSON.stringify(r1.map((r) => r.code ?? 'ok'))})`);
  const notes = psql(`select path || '|' || user_id from public.notes where kb_id = '${KB}' and deleted_at is null order by path`).split('\n');
  check(notes.length === 2 && notes.every((n) => n.endsWith(`|${ADMIN}`)), `two notes, both the admin's rows: ${notes.map((n) => n.split('|')[0]).join(', ')}`);
  check(psql(`select count(*) from public.kb_note_upstream u join public.notes n on n.id = u.note_id where n.kb_id = '${KB}'`) === '2', 'each note has its upstream base (kb_sync_upstream_save ran kb_upstream_save as the admin)');
  check(psql(`select string_agg(status, ',' order by provider) from public.kb_attachments where kb_id = '${KB}'`) === 'active,active', 'both attachments are active');

  // 3. an agent edits the Drive note, then the file changes in Drive: the source text is written through
  //    kb_synced_notes_write (as the admin) and the edit is kept as a ready suggestion
  const leave = psql(`select id from public.notes where kb_id = '${KB}' and path like '%Leave.md'`);
  psql(`update public.notes set body = body || E'\\nAgent note: carry over up to five days.\\n', hash = encode(sha256(convert_to(body || E'\\nAgent note: carry over up to five days.\\n', 'UTF8')), 'hex') where id = '${leave}';`);
  drive.docs.set('d1', '# Leave\n\nTwenty-five days a year.\n');
  drive.files.get('d1').modifiedTime = '2026-11-10T00:00:00.000Z';
  due(driveAtt.id);
  const r2 = await worker.tick();
  check(r2.length === 1 && r2[0].ok, 'the second tick syncs the changed file');
  const body = psql(`select body from public.notes where id = '${leave}'`);
  check(/Twenty-five days/.test(body) && !/Agent note/.test(body), 'the note has the source text');
  const sug = JSON.parse(psql(`select suggestions::text from public.kb_note_upstream where note_id = '${leave}'`));
  check(sug.length === 1 && sug[0].state === 'ready' && /Twenty-five days[\s\S]*Agent note: carry over/.test(sug[0].body), 'the agent edit is a ready suggestion merged onto the new text');

  // 4. a GitHub 403 secondary rate limit backs off without removing anything
  gh.limited = true;
  gh.head = 'c2';
  due(ghAtt.id);
  const before = psql(`select count(*) from public.notes where kb_id = '${KB}' and deleted_at is null`);
  const r3 = await worker.tick();
  const st = psql(`select status || '|' || (extract(epoch from next_run_at - now()) > 60)::text from public.kb_attachments where id = '${ghAtt.id}'`);
  check(r3.length === 1 && r3[0].code === 'limited', 'the secondary limit is read as a rate limit');
  check(st === 'error|true', 'the attachment shows the error and its next try waits out Retry-After');
  check(psql(`select count(*) from public.notes where kb_id = '${KB}' and deleted_at is null`) === before, 'no note was removed');
  gh.limited = false;

  // 5. Remove, called by the signed-in admin through PostgREST, takes the attachment's notes out and ends the grant
  const token = userToken(ADMIN);
  if (token) {
    const asAdmin = new PostgrestClient(REST, { headers: { apikey: serviceKey, authorization: `Bearer ${token}` } });
    const { data, error } = await asAdmin.rpc('kb_attachment_remove', { id: driveAtt.id });
    check(!error && data === 1, `Remove as the admin takes 1 note out${error ? ` (${error.message})` : ''}`);
  } else {
    psql(`select set_config('request.jwt.claims', '{"sub": "${ADMIN}", "role": "authenticated"}', true), set_config('role', 'authenticated', true); select public.kb_attachment_remove('${driveAtt.id}');`);
    check(true, 'Remove ran through psql with the admin\'s claims (no HMAC secret for a token)');
  }
  check(psql(`select count(*) from public.notes where id = '${leave}' and deleted_at is not null`) === '1', 'the Drive note is soft deleted');
  check(psql(`select count(*) from public.kb_sync_grants where user_id = '${ADMIN}' and provider = 'google-drive'`) === '0', 'the shared Drive grant ended with its last attachment');
  check(psql(`select count(*) from public.notes where kb_id = '${KB}' and deleted_at is null`) === '1', 'the GitHub note stays');

  const logged = logs.join('\n');
  check(!/rt-e2e|gh-rt|drive-access|gh-access|e2e-google-secret|e2e-gh-secret/.test(logged), 'no token or secret in the worker log');
  console.log(`provider calls: ${seen.length}`);
} finally {
  await worker.stop();
  server.close();
}
console.log(failures ? `kb sync e2e: ${failures} failed` : 'kb sync e2e: ok');
process.exit(failures ? 1 : 0);
