// the passkey step: the owner registers one from this page, then presents it on each sign-in. The ceremonies run
// against the relay (relay/passkeys.js); what comes back is a session token, kept for this tab only and sent on
// every request as x-quorum-passkey, which the database checks before any owner-only function answers.
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import { RELAY_URL, auth } from './api';
import { token } from './session';
import { plain } from './shape';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type PasskeyStatus = { registered: number; session: boolean; rpId: string; keys: { id: string; label: string | null; createdAt: string; lastUsedAt: string | null }[] };

async function call<T>(path: string, body: unknown = {}): Promise<Result<T>> {
  try {
    const session = await auth.session();
    if (!session) return { ok: false, error: 'You are signed out. Sign in again.' };
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` };
    const t = token.get();
    if (t) headers['x-quorum-passkey'] = t;
    const res = await fetch(`${RELAY_URL}/v1/platform/passkey/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(data.error ?? 'The relay refused the request.') };
    return { ok: true, value: data as T };
  } catch (err) { return { ok: false, error: plain(err, 'The relay could not be reached.') }; }
}

export const passkey = {
  supported: () => typeof window !== 'undefined' && !!window.PublicKeyCredential,
  status: () => call<PasskeyStatus>('status'),
  // register: options from the relay, the authenticator's answer back to it
  register: async (label: string): Promise<Result<true>> => {
    const opts = await call<PublicKeyCredentialCreationOptionsJSON>('register-options');
    if (!opts.ok) return opts;
    let response: RegistrationResponseJSON;
    try { response = await startRegistration({ optionsJSON: opts.value }); } catch (err) { return { ok: false, error: webauthnError(err, 'The passkey was not created.') }; }
    const r = await call<{ ok: true }>('register', { response, label });
    return r.ok ? { ok: true, value: true } : r;
  },
  // sign in: the assertion back to the relay, the session token kept for this tab
  login: async (): Promise<Result<true>> => {
    const opts = await call<PublicKeyCredentialRequestOptionsJSON>('login-options');
    if (!opts.ok) return opts;
    let response: AuthenticationResponseJSON;
    try { response = await startAuthentication({ optionsJSON: opts.value }); } catch (err) { return { ok: false, error: webauthnError(err, 'The passkey was not presented.') }; }
    const r = await call<{ token: string; expiresAt: string }>('login', { response });
    if (!r.ok) return r;
    token.set(r.value.token, r.value.expiresAt);
    return { ok: true, value: true };
  },
  logout: async () => { await call('logout'); token.clear(); },
};

// what the browser says when a ceremony stops, in one sentence
function webauthnError(err: unknown, fallback: string): string {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'NotAllowedError') return 'The passkey prompt was dismissed or timed out.';
  if (e?.name === 'InvalidStateError') return 'This passkey is already registered here.';
  if (e?.name === 'SecurityError') return 'This page is not served from the passkey domain, so the browser refused.';
  return e?.message ? `${fallback} ${e.message}` : fallback;
}
