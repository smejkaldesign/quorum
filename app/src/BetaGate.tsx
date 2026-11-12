import { useState } from 'react';
import { codeHint, isCode, normalizeCode } from '../betaCode.js';
import { isCloud } from './edition';
import mark from '../assets/quorum-mark.png';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE = 'https://quorum.watch';

// the beta gate: the first screen of a fresh install, and of any install without an accepted code, in both editions.
// The code goes to the relay with an anonymous machine id; an accepted one is kept and the gate never shows again.
// The Cloud edition also takes the email the code was issued for, so sign-up later finds the same code
export function BetaGate({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hint = codeHint(code);
  const ready = isCode(code) && (!isCloud || !email.trim() || EMAIL.test(email.trim())) && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    const r = await window.quorum.betaCheck(normalizeCode(code), isCloud && email.trim() ? email.trim() : null).catch((e) => ({ ok: false, reason: String((e as Error).message || e) }));
    setBusy(false);
    if (r.ok) onDone(); else setError(r.reason || 'That code was not accepted.');
  };
  return (
    <div className="onb">
      <div className="onb-card">
        <section className="onb-step">
          <img className="onb-mark" src={mark} alt="" />
          <h1>Quorum is in early beta</h1>
          <p>Enter your access code to continue. Request one at <button type="button" className="link-btn" onClick={() => window.quorum.openExternal(SITE)}>quorum.watch</button>.</p>
          <div className="beta-form">
            {isCloud && <label className="set-field wide"><input type="email" autoComplete="email" aria-label="Email the code was sent to" placeholder="Email the code was sent to (optional)" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} /></label>}
            <label className="set-field wide"><input autoFocus aria-label="Access code" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onBlur={() => { if (code) setCode(normalizeCode(code)); }} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} /></label>
            {hint && <p className="beta-hint">{hint}</p>}
          </div>
          {error && <p className="set-error">{error}</p>}
          <p className="onb-muted">This install reports its code, an anonymous machine id and the app version to Quorum once a day during the beta.</p>
          <div className="onb-actions"><span /><button className="pill primary" disabled={!ready} onClick={submit}>{busy ? 'Checking…' : 'Continue'}</button></div>
        </section>
      </div>
    </div>
  );
}
