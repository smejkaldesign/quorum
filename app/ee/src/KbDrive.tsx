import { useCallback, useEffect, useState } from 'react';
import type { Kb, KbDriveFile, KbDriveResult, KbDriveStatus, KbImportSkipped } from '../../src/quorum';
import { openConnectors } from '../../src/connectorsNav';
import { IconDoc } from '../../src/icons';
import { announceKbChange, kbCall, KbConfirm } from './kbUi';
import { driveSummary, folderChoices, folderLabel } from './kbTree';

// Google Drive files in a knowledge base folder (ee/kbDrive.js). The admin page's KB menu and the Knowledge tab's
// folder menu both open this panel: it says how to connect Google Drive when the account is not connected, opens the
// Google Picker in the browser, and lists the attached files with when each last synced, Sync now and Remove.

export const hasDrive = (): boolean => {
  const q = window.quorum as Partial<Window['quorum']> | undefined;
  return typeof q?.kbDriveAdd === 'function' && typeof q?.kbDriveStatus === 'function';
};

const syncedOn = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not synced yet');

// folderId undefined lets the admin pick the folder; a value (null is the top level) fixes it, as the tree's menu does
export function DrivePanel({ kb, folderId, onChanged, onDone }: { kb: Kb; folderId?: string | null; onChanged?: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<KbDriveStatus | null>(null);
  const [files, setFiles] = useState<KbDriveFile[] | null>(null);
  const [target, setTarget] = useState<string>(folderId ?? '');
  const [busy, setBusy] = useState<'add' | 'sync' | string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ headline: string; skipped: KbImportSkipped[] } | null>(null);
  const [removing, setRemoving] = useState<KbDriveFile | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await window.quorum.kbDriveStatus()); } catch { setStatus({ connected: false, available: false, account: null }); }
    const r = await kbCall(() => window.quorum.kbDriveFiles(kb.id), 'The Google Drive files could not be read.');
    if (r.error) setError(r.error); else setFiles(r.files ?? []);
  }, [kb.id]);
  useEffect(() => { load(); }, [load]);
  // coming back from Settings or the browser: the account may have been connected meanwhile
  useEffect(() => {
    const again = () => { window.quorum.kbDriveStatus().then(setStatus).catch(() => {}); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);

  const finish = (r: KbDriveResult, verb: string) => {
    if (r.error) { setError(r.error); return; }
    if (r.canceled) { setResult({ headline: 'Nothing was picked.', skipped: [] }); return; }
    if (r.files) setFiles(r.files);
    setResult(driveSummary(verb, r.synced ?? 0, r.skipped ?? []));
    announceKbChange();
    onChanged?.();
  };
  const run = async (kind: string, fn: () => Promise<KbDriveResult> | undefined, verb: string, fallback: string) => {
    if (busy) return;
    setBusy(kind); setError(''); setResult(null);
    const r = await kbCall(fn, fallback);
    setBusy(null);
    finish(r, verb);
  };
  const add = () => run('add', () => window.quorum.kbDriveAdd({ kbId: kb.id, folderId: target || null }), 'Added', 'The files could not be added.');
  const syncAll = () => run('sync', () => window.quorum.kbDriveSync({ kbId: kb.id }), 'Synced', 'The files could not be synced.');
  const syncOne = (f: KbDriveFile) => run(f.fileId, () => window.quorum.kbDriveSync({ kbId: kb.id, fileId: f.fileId }), 'Synced', 'The file could not be synced.');
  const remove = async (f: KbDriveFile) => {
    setRemoving(null);
    setBusy(f.fileId); setError(''); setResult(null);
    const r = await kbCall(() => window.quorum.kbDriveRemove({ kbId: kb.id, fileId: f.fileId }), 'The file could not be removed.');
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    setFiles(r.files ?? []);
    announceKbChange();
    onChanged?.();
  };

  const choices = folderChoices(kb);
  const mine = (files ?? []).filter((f) => f.mine);
  return (
    <div className="kb-panel kb-drive">
      {status === null && <p className="set-hint">Loading…</p>}
      {status && !status.connected && (
        <div className="kb-form-row">
          <p className="kb-hint">Connect Google Drive in Settings, Connections to add files from it. Quorum reads only the files you pick.</p>
          <button className="pill" onClick={() => openConnectors({ connector: 'google-drive' })}>Open Connections</button>
        </div>
      )}
      {status?.connected && !status.available && <p className="kb-hint muted">Adding files from Google Drive is not available in this build yet.</p>}
      {status?.connected && status.available && (
        <>
          <p className="kb-hint muted">Pick Google Docs, markdown or text files{status.account ? ` from ${status.account}` : ''}. Each one becomes a note in {kb.name}, shared with its readers. The picker opens in your browser.</p>
          <div className="kb-form-row">
            {folderId === undefined ? (
              <select className="set-select" aria-label="Folder" value={target} disabled={!!busy} onChange={(e) => setTarget(e.target.value)}>
                {choices.map((c) => <option key={c.id ?? 'top'} value={c.id ?? ''}>{c.label}</option>)}
              </select>
            ) : <span className="muted">Into {folderLabel(kb, folderId)}</span>}
            <button className="pill primary" disabled={!!busy} onClick={add}>{busy === 'add' ? 'Waiting for Google Drive…' : 'Choose files in Google Drive'}</button>
          </div>
          {busy === 'add' && <p className="kb-hint muted" role="status">Pick the files in the browser tab that opened, then come back here.</p>}
        </>
      )}
      {result && (
        <div className="kb-import" role="status">
          <strong>{result.headline}</strong>
          {result.skipped.length > 0 && <ul className="kb-skipped">{result.skipped.map((k) => <li key={`${k.path}:${k.reason}`}><span>{k.path}</span><em>{k.reason}</em></li>)}</ul>}
        </div>
      )}
      {error && <p className="set-error" role="alert">{error}</p>}
      {files && files.length > 0 && (
        <>
          <p className="kb-label">From Google Drive</p>
          <ul className="kb-drive-files">
            {files.map((f) => (
              <li key={f.fileId}>
                <IconDoc width={16} height={16} />
                <span className="kb-drive-name">
                  {f.url ? <button className="link-btn" title="Open in Google Drive" onClick={() => window.quorum.openExternal(f.url!)}>{f.name}</button> : f.name}
                  <em className="muted">{folderLabel(kb, f.folderId)} · {busy === f.fileId ? 'Syncing…' : `Synced ${syncedOn(f.syncedAt)}`}{f.mine ? '' : ' · attached by another admin'}</em>
                </span>
                {f.mine && status?.connected && <button className="pill small" disabled={!!busy} onClick={() => syncOne(f)}>Sync now</button>}
                {f.mine && <button className="pill small ghost" disabled={!!busy} onClick={() => setRemoving(f)}>Remove</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="kb-form-row">
        {mine.length > 1 && status?.connected && <button className="pill" disabled={!!busy} onClick={syncAll}>{busy === 'sync' ? 'Syncing…' : 'Sync all now'}</button>}
        <button className="pill ghost" disabled={busy === 'add' || busy === 'sync'} onClick={onDone}>Done</button>
      </div>
      {removing && <KbConfirm title={`Remove ${removing.name}?`} body="Its note leaves the knowledge base and the readers' vaults. The file stays in Google Drive." action="Remove" onDone={(ok) => (ok ? remove(removing) : setRemoving(null))} />}
    </div>
  );
}
