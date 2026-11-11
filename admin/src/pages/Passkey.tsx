import { useState } from 'react';
import { auth } from '../api';
import { passkey } from '../passkey';
import { Button, Card, Field, Input } from '../ui';

// the second step of signing in. First visit: create a passkey (Touch ID, Face ID, a security key). Every visit after:
// present it. Nothing on the other pages answers until this step is done, because the database checks the session
// the relay writes here (migration 0017).
export function Passkey({ registered, onDone }: { registered: number; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = passkey.supported();
  const create = async () => {
    setBusy(true); setError('');
    const r = await passkey.register(label || 'This device');
    if (!r.ok) { setBusy(false); setError(r.error); return; }
    const s = await passkey.login();
    setBusy(false);
    if (!s.ok) { setError(s.error); return; }
    onDone();
  };
  const present = async () => {
    setBusy(true); setError('');
    const r = await passkey.login();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone();
  };
  const unsupported = <p className="error">This browser cannot use passkeys. Use Safari, Chrome or Edge on a device with Touch ID, Face ID or a security key.</p>;
  return (
    <Card form>
      {registered === 0 ? (
        <>
          <h1>Set up your passkey</h1>
          <p className="muted lede">The admin app needs a second step on top of the email code. Create a passkey on this device; from then on every sign-in asks for it, and the database refuses the owner's functions without it.</p>
          {!supported && unsupported}
          <form onSubmit={(e) => { e.preventDefault(); if (!busy && supported) create(); }}>
            <Field label="Name for this passkey"><Input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} placeholder="MacBook Pro" autoFocus /></Field>
            <div className="actions"><Button variant="primary" type="submit" disabled={busy || !supported}>{busy ? 'Waiting for the device…' : 'Create passkey'}</Button><Button variant="link" onClick={() => auth.signOut()}>Sign out</Button></div>
          </form>
        </>
      ) : (
        <>
          <h1>Your passkey</h1>
          <p className="muted lede">Confirm it is you. The prompt comes from this device.</p>
          <div className="actions" style={{ marginTop: 16 }}><Button variant="primary" disabled={busy || !supported} onClick={present}>{busy ? 'Waiting for the device…' : 'Continue with passkey'}</Button><Button variant="link" onClick={() => auth.signOut()}>Sign out</Button></div>
          {!supported && unsupported}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </Card>
  );
}
