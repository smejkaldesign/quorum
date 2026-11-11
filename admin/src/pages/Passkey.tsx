import { useState } from 'react';
import { auth } from '../api';
import { passkey } from '../passkey';

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
  return (
    <div className="card signin">
      {registered === 0 ? (
        <>
          <h1>Set up your passkey</h1>
          <p className="muted">The admin app needs a second step on top of the email code. Create a passkey on this device; from then on every sign-in asks for it, and the database refuses the owner's functions without it.</p>
          {!supported && <p className="error">This browser cannot create passkeys. Use Safari, Chrome or Edge on a device with Touch ID, Face ID or a security key.</p>}
          <form onSubmit={(e) => { e.preventDefault(); if (!busy && supported) create(); }}>
            <label>Name for this passkey<input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} placeholder="MacBook Pro" autoFocus /></label>
            <div className="actions"><button className="pill primary" type="submit" disabled={busy || !supported}>{busy ? 'Waiting for the device…' : 'Create passkey'}</button><button className="link" type="button" onClick={() => auth.signOut()}>Sign out</button></div>
          </form>
        </>
      ) : (
        <>
          <h1>Your passkey</h1>
          <p className="muted">Confirm it is you. The prompt comes from this device.</p>
          <div className="actions"><button className="pill primary" disabled={busy || !supported} onClick={present}>{busy ? 'Waiting for the device…' : 'Continue with passkey'}</button><button className="link" onClick={() => auth.signOut()}>Sign out</button></div>
          {!supported && <p className="error">This browser cannot use passkeys. Use Safari, Chrome or Edge on a device with Touch ID, Face ID or a security key.</p>}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
