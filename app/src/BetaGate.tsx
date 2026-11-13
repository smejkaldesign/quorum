import { useEffect, useRef, useState } from 'react';
import { CODE_LENGTH, cellsCode, cellsFull, emptyCells, shouldSend } from '../betaCode.js';
import { CodeBoxes } from './CodeBoxes';
import mark from '../assets/quorum-mark.png';

const SITE = 'https://quorum.watch';

// the beta gate: the first screen of a fresh install, and of any install without an accepted code, in both editions.
// The code goes to the relay with an anonymous machine id; an accepted one is kept and the gate never shows again.
// It is sent once, as soon as the last box is filled; Continue stays for keyboard and screen reader use.
export function BetaGate({ onDone }: { onDone: () => void }) {
  const [cells, setCells] = useState<string[]>(emptyCells);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  // the code last sent, so a full code is sent once; a refusal resets it so the same code can be tried again
  const sent = useRef('');
  const full = cellsFull(cells);

  const submit = async (code: string) => {
    if (busy || !code) return;
    sent.current = code;
    setBusy(true); setError('');
    const r = await window.quorum.betaCheck(code).catch((e) => ({ ok: false, reason: String((e as Error).message || e) }));
    setBusy(false);
    if (r.ok) { onDone(); return; }
    setError(r.reason || 'That code was not accepted.');
    sent.current = '';
    setCells(emptyCells());
    setFocusKey((k) => k + 1);
  };

  useEffect(() => {
    if (shouldSend(cells, sent.current, busy)) submit(cellsCode(cells));
  }, [cells]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="onb">
      <div className="onb-card">
        <section className="onb-step">
          <img className="onb-mark" src={mark} alt="" />
          <h1>Quorum is in early beta</h1>
          <p>Enter your access code to continue. Request one at <button type="button" className="link-btn inline" onClick={() => window.quorum.openExternal(SITE)}>quorum.watch</button>.</p>
          <div className={`beta-form${busy ? ' checking' : ''}`} aria-busy={busy}>
            <CodeBoxes cells={cells} onChange={(c) => { setCells(c); if (error) setError(''); }} onHint={setHint} disabled={busy} focusKey={focusKey} />
            {hint && <p className="beta-hint" role="status">{hint}</p>}
          </div>
          {error && <p className="set-error" role="alert">{error}</p>}
          <p className="onb-muted">This install reports its code, an anonymous machine id and the app version to Quorum once a day during the beta.</p>
          <div className="onb-actions"><span />
            <button className="pill primary" disabled={!full || busy} onClick={() => submit(cellsCode(cells))}>
              {busy ? <><span className="code-spin" aria-hidden="true" />Checking…</> : 'Continue'}
            </button>
          </div>
          <p className="sr-only">The code has {CODE_LENGTH} characters.</p>
        </section>
      </div>
    </div>
  );
}
