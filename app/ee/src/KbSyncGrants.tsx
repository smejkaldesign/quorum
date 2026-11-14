import { useCallback, useEffect, useState } from 'react';
import type { KbSyncGrant } from '../../src/quorum';
import { kbCall } from './kbUi';
import { grantLabel, grantLine } from './kbSyncUi';

// The connections only Quorum's relay holds for synced folders (ee/kbSync.js, migration 0033), on Settings,
// Connections. A GitHub sign-in made for a synced repository is a grant the Mac never keeps, so it is listed here as
// "GitHub (synced folders)" with Disconnect: the relay ends it and revokes its token with GitHub, and the synced
// folders that used it are paused (their notes stay) or removed (their notes leave the knowledge bases), as the person
// picks in the confirm. A Google Drive grant is the Mac's own Google Drive connection, so it is not listed twice.

export function KbSyncGrants() {
  const [grants, setGrants] = useState<KbSyncGrant[] | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<KbSyncGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const q = window.quorum as Partial<Window['quorum']>;
    if (typeof q.kbSyncGrants !== 'function') { setGrants([]); return; }
    const r = await kbCall(() => window.quorum.kbSyncGrants(), 'The synced-folder connections could not be read.');
    if (r.error) { setError(r.error); return; }
    setError('');
    setGrants((r.grants ?? []).filter((g) => !g.shared_with_mac));
  }, []);
  useEffect(() => { load(); }, [load]);

  const disconnect = async (g: KbSyncGrant, mode: 'pause' | 'remove') => {
    setBusy(true); setError('');
    const r = await kbCall(() => window.quorum.kbSyncGrantDisconnect({ provider: g.provider, mode }), 'The connection could not be disconnected.');
    setBusy(false);
    setConfirm(null);
    if (r.error) { setError(r.error); return; }
    load();
  };

  if (!grants?.length && !error) return null;
  return (
    <div className="conn-group">
      <h4>Synced folders</h4>
      <div className="set-card conn-card">
        {(grants ?? []).map((g) => (
          <div key={g.provider} className="conn-row">
            <div className="conn-line">
              <strong className="conn-title">{grantLabel(g)}</strong>
              <span className="conn-ok"><i />Connected</span>
              <span className="conn-meta">{grantLine(g)}</span>
              <span className="conn-actions"><button className="pill" disabled={busy} onClick={() => setConfirm(g)}>Disconnect</button></span>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      {confirm && (
        <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setConfirm(null); }}>
          <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="kbsg-title" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setConfirm(null); }}>
            <h2 id="kbsg-title">Disconnect {grantLabel(confirm)}?</h2>
            <p>Quorum's relay stops using this sign-in and revokes it with {confirm.provider === 'github' ? 'GitHub' : 'the provider'}. {confirm.attachments.length ? `${confirm.attachments.length === 1 ? 'One synced folder uses' : `${confirm.attachments.length} synced folders use`} it: ${confirm.attachments.map((a) => `${a.name} in ${a.kb_name}`).join(', ')}.` : 'No synced folder uses it.'}</p>
            {confirm.attachments.length > 0 && <p className="muted">Pause keeps their notes and stops syncing; attach them again to resume. Remove takes their notes out of the knowledge bases.</p>}
            <div className="modal-actions">
              <span />
              <span className="modal-actions-end">
                <button className="pill" autoFocus disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
                {confirm.attachments.length > 0 && <button className="pill danger-pill" disabled={busy} onClick={() => disconnect(confirm, 'remove')}>Disconnect and remove</button>}
                <button className="pill primary" disabled={busy} onClick={() => disconnect(confirm, 'pause')}>{confirm.attachments.length ? 'Disconnect and pause' : 'Disconnect'}</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
