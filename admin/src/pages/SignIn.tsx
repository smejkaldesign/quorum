import { useState } from 'react';
import { auth, host } from '../api';
import { EMAIL } from '../shape';
import { Button, Card, Field, Input } from '../ui';

// the same email-code sign-in the app uses, for an account that already exists; the owner check happens after
export function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError('');
    const r = await auth.sendCode(email.trim().toLowerCase());
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setSent(true);
  };
  const verify = async () => {
    setBusy(true); setError('');
    const r = await auth.verify(email.trim().toLowerCase(), code.replace(/\D/g, ''));
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const emailOk = EMAIL.test(email.trim());
  return (
    <Card form>
      <h1>Sign in</h1>
      <p className="muted lede">The platform owner's account on {host}. A 6-digit code comes by email.</p>
      {!sent ? (
        <form onSubmit={(e) => { e.preventDefault(); if (emailOk && !busy) send(); }}>
          <Field label="Email"><Input type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" /></Field>
          <div className="actions"><Button variant="primary" disabled={!emailOk || busy} type="submit">{busy ? 'Sending…' : 'Send code'}</Button></div>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (code.replace(/\D/g, '').length === 6 && !busy) verify(); }}>
          <p>Code sent to <strong>{email.trim().toLowerCase()}</strong>.</p>
          <Field label="6-digit code"><Input inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" /></Field>
          <div className="actions">
            <Button variant="primary" disabled={code.replace(/\D/g, '').length !== 6 || busy} type="submit">{busy ? 'Checking…' : 'Sign in'}</Button>
            <Button variant="link" onClick={() => { setSent(false); setCode(''); setError(''); }}>Use another email</Button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </Card>
  );
}
