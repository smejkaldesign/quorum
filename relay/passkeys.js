// The platform owner's passkey (WebAuthn), the second step of the admin app's sign-in. The email code gives a
// Supabase session; the ceremonies here (register once, then sign in each time) are verified against the stored
// public key, and a successful sign-in writes a platform_sessions row (migration 0017). The admin app then sends that
// session's token as x-quorum-passkey on every request, and is_platform_owner() in the database is true only while
// the row is live. The first registration needs only the owner's email-code session; any later one needs a live
// passkey session too, so a stolen inbox cannot add a passkey of its own.
import { createHash, randomBytes } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { bearer, RelayError, verifyToken } from './lib/auth.js';
import { corsHeaders, clientAddress, createLimiter } from './platform.js';
import { readJson } from './summary.js';

const CHALLENGE_MS = 5 * 60 * 1000;
export const SESSION_HOURS = 12;
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
const failJson = (res, err, log, what, extra = {}) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.', code: err.code ?? 'server' }, extra);
};

// one pending challenge per user and purpose, forgotten after five minutes or first use
export function createChallenges({ now = Date.now } = {}) {
  const map = new Map();
  return {
    put(userId, purpose, challenge) { map.set(`${userId}:${purpose}`, { challenge, at: now() }); },
    take(userId, purpose) {
      const k = `${userId}:${purpose}`; const v = map.get(k); map.delete(k);
      if (!v || now() - v.at > CHALLENGE_MS) return null;
      return v.challenge;
    },
  };
}
const challenges = createChallenges();
const limiter = createLimiter({ max: 30, windowMs: 15 * 60 * 1000 });

async function owner({ anon, db }, token) {
  const user = await verifyToken(anon, token);
  const { data, error } = await db.from('platform_owners').select('user_id').eq('user_id', user.userId).maybeSingle();
  if (error) throw new RelayError('server', 'The owner role could not be read.', 500);
  if (!data) throw new RelayError('forbidden', 'Only the platform owner can do that.', 403);
  return user;
}
async function passkeysOf(db, userId) {
  const { data, error } = await db.from('platform_passkeys').select('id, credential_id, public_key, counter, transports, label, created_at, last_used_at').eq('user_id', userId);
  if (error) throw new RelayError('server', 'The passkeys could not be read.', 500);
  return data ?? [];
}
// a live passkey session for this user, from the header the admin app sends
async function sessionOk(db, userId, header) {
  if (!header) return false;
  const { data } = await db.from('platform_sessions').select('id').eq('user_id', userId).eq('token_hash', hashToken(header)).gt('expires_at', new Date().toISOString()).maybeSingle();
  return !!data;
}

export function passkeyRoutes({ clients, config, log = () => {} }) {
  const rpID = config.passkey.rpId;
  const origins = config.corsOrigins;
  const route = (fn) => async (req, res) => {
    const cors = corsHeaders(req.headers.origin, origins);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
      if (!limiter.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many attempts. Wait fifteen minutes.', 429);
      const user = await owner(clients, bearer(req.headers.authorization));
      const body = await readJson(req, 64 * 1024);
      json(res, 200, await fn({ user, body, header: String(req.headers['x-quorum-passkey'] ?? '') }), cors);
    } catch (err) { failJson(res, err, log, 'passkey', cors); }
  };

  return {
    // what the admin app asks first: how many passkeys this owner has, and whether the header it holds is still good
    '/v1/platform/passkey/status': route(async ({ user, header }) => {
      const keys = await passkeysOf(clients.db, user.userId);
      return { registered: keys.length, session: keys.length ? await sessionOk(clients.db, user.userId, header) : false, rpId: rpID, keys: keys.map((k) => ({ id: k.id, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at })) };
    }),
    '/v1/platform/passkey/register-options': route(async ({ user, header }) => {
      const keys = await passkeysOf(clients.db, user.userId);
      if (keys.length && !(await sessionOk(clients.db, user.userId, header))) throw new RelayError('forbidden', 'Sign in with your passkey before adding another.', 403);
      const options = await generateRegistrationOptions({
        rpName: 'Quorum Admin', rpID, userName: user.email ?? user.userId, userDisplayName: user.email ?? 'Platform owner',
        userID: new TextEncoder().encode(user.userId), attestationType: 'none',
        excludeCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports ?? [] })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      challenges.put(user.userId, 'register', options.challenge);
      return options;
    }),
    '/v1/platform/passkey/register': route(async ({ user, body, header }) => {
      const keys = await passkeysOf(clients.db, user.userId);
      if (keys.length && !(await sessionOk(clients.db, user.userId, header))) throw new RelayError('forbidden', 'Sign in with your passkey before adding another.', 403);
      const expectedChallenge = challenges.take(user.userId, 'register');
      if (!expectedChallenge) throw new RelayError('bad_request', 'The registration took too long. Start again.', 400);
      let v;
      try { v = await verifyRegistrationResponse({ response: body.response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true }); } catch (err) { throw new RelayError('bad_request', `The passkey could not be verified: ${err.message}`, 400); }
      if (!v.verified || !v.registrationInfo) throw new RelayError('bad_request', 'The passkey could not be verified.', 400);
      const c = v.registrationInfo.credential;
      const { error } = await clients.db.from('platform_passkeys').insert({ user_id: user.userId, credential_id: c.id, public_key: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports ?? [], label: String(body.label ?? '').trim().slice(0, 80) || null });
      if (error) throw new RelayError('server', 'The passkey could not be saved.', 500);
      log('passkey_registered', { userId: user.userId });
      return { ok: true };
    }),
    '/v1/platform/passkey/login-options': route(async ({ user }) => {
      const keys = await passkeysOf(clients.db, user.userId);
      if (!keys.length) throw new RelayError('bad_request', 'No passkey is registered yet.', 400);
      const options = await generateAuthenticationOptions({ rpID, allowCredentials: keys.map((k) => ({ id: k.credential_id, transports: k.transports ?? [] })), userVerification: 'required' });
      challenges.put(user.userId, 'login', options.challenge);
      return options;
    }),
    '/v1/platform/passkey/login': route(async ({ user, body }) => {
      const expectedChallenge = challenges.take(user.userId, 'login');
      if (!expectedChallenge) throw new RelayError('bad_request', 'The sign-in took too long. Start again.', 400);
      const keys = await passkeysOf(clients.db, user.userId);
      const stored = keys.find((k) => k.credential_id === body.response?.id);
      if (!stored) throw new RelayError('forbidden', 'That passkey is not registered for this account.', 403);
      let v;
      try {
        v = await verifyAuthenticationResponse({ response: body.response, expectedChallenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: stored.credential_id, publicKey: new Uint8Array(Buffer.from(stored.public_key, 'base64url')), counter: Number(stored.counter), transports: stored.transports ?? [] } });
      } catch (err) { throw new RelayError('forbidden', `The passkey could not be verified: ${err.message}`, 403); }
      if (!v.verified) throw new RelayError('forbidden', 'The passkey could not be verified.', 403);
      const token = newToken();
      const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
      const [sess, upd] = await Promise.all([
        clients.db.from('platform_sessions').insert({ user_id: user.userId, token_hash: hashToken(token), expires_at: expiresAt }),
        clients.db.from('platform_passkeys').update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq('id', stored.id),
      ]);
      if (sess.error || upd.error) throw new RelayError('server', 'The session could not be saved.', 500);
      clients.db.rpc('platform_sessions_sweep').then(() => {}, () => {});
      log('passkey_signed_in', { userId: user.userId });
      return { token, expiresAt };
    }),
    '/v1/platform/passkey/logout': route(async ({ user, header }) => {
      if (header) await clients.db.from('platform_sessions').delete().eq('user_id', user.userId).eq('token_hash', hashToken(header));
      return { ok: true };
    }),
  };
}
