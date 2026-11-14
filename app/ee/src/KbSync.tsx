import { useCallback, useEffect, useRef, useState } from 'react';
import type { Kb, KbSyncAttachment, KbSyncResult } from '../../src/quorum';
import { openConnectors } from '../../src/connectorsNav';
import { IconFolder } from '../../src/icons';
import { announceKbChange, kbCall, KbConfirm } from './kbUi';
import { folderLabel } from './kbTree';
import { checkRepoUrl, lastSynced, noteCount, providerName, remoteLine, syncActions, syncStatus } from './kbSyncUi';

// Synced folders in a knowledge base (ee/kbSync.js; the relay's worker keeps them in sync with no Mac open). The tree's
// folder menu opens this panel with Google Drive or GitHub chosen: the admin attaches a Drive folder or file through the
// Google Picker, or a GitHub repository by its address, and every attachment in the KB is listed with its status, when
// it last synced, the last error, and Sync now, Pause or Resume, and Remove.

export type SyncSource = 'google-drive' | 'github';

export const hasKbSync = (): boolean => {
  const q = window.quorum as Partial<Window['quorum']> | undefined;
  return typeof q?.kbSyncList === 'function' && typeof q?.kbSyncAttachDrive === 'function';
};

export function SyncPanel({ kb, folderId, source, onChanged, onDone }: { kb: Kb; folderId: string | null; source: SyncSource; onChanged?: () => void; onDone: () => void }) {
  const [list, setList] = useState<KbSyncAttachment[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [removing, setRemoving] = useState<KbSyncAttachment | null>(null);
  const [now, setNow] = useState<number | null>(null);
  // the list's own read error, kept apart from an action's error so the next good read clears it
  const [pollError, setPollError] = useState('');
  // a Drive picker or a GitHub sign-in still waiting in the browser when the panel closes (Done, Escape, the scrim) is
  // ended, which frees its port
  const waiting = useRef(false);
  useEffect(() => () => { if (waiting.current) { waiting.current = false; window.quorum.kbSyncCancel?.().catch(() => {}); } }, []);
  const changed = () => { if (onChanged) onChanged(); else announceKbChange(); };

  const load = useCallback(async () => {
    const r = await kbCall(() => window.quorum.kbSyncList(kb.id), 'The synced folders could not be read.');
    setNow(Date.now());
    if (r.error) { setPollError(r.error); return; }
    setPollError('');
    setList(r.attachments ?? []);
  }, [kb.id]);
  useEffect(() => { load(); }, [load]);
  // the worker runs on the relay: while the panel is open the list is read again every half minute
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const attached = (r: KbSyncResult) => {
    if (r.error) { setError(r.error); return; }
    if (r.canceled) { setNotice(source === 'github' ? 'The GitHub sign-in was cancelled.' : 'Nothing was picked.'); return; }
    setNotice(`${r.attachment?.name ?? 'It'} is attached. The first sync starts in a minute, and the notes reach every reader's Mac after it.`);
    setRepo(''); setBranch('');
    load();
    changed();
  };
  const run = async (key: string, fn: () => Promise<KbSyncResult>, fallback: string) => {
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    waiting.current = key === 'drive' || key === 'github';
    const r = await kbCall(fn, fallback);
    waiting.current = false;
    setBusy(null);
    attached(r);
  };
  const attachDrive = () => run('drive', () => window.quorum.kbSyncAttachDrive({ kbId: kb.id, folderId }), 'The Google Drive item could not be attached.');
  const repoError = repo ? checkRepoUrl(repo) : null;
  const cancelWait = () => { window.quorum.kbSyncCancel?.().catch(() => {}); };
  const attachRepo = () => { if (checkRepoUrl(repo)) { setError(checkRepoUrl(repo)!); return; } run('github', () => window.quorum.kbSyncAttachGithub({ kbId: kb.id, folderId, url: repo.trim(), branch: branch.trim() || null }), 'The repository could not be attached.'); };

  const act = async (a: KbSyncAttachment, fn: () => Promise<KbSyncResult>, fallback: string) => {
    if (busy) return;
    setBusy(a.id); setError(''); setNotice('');
    const r = await kbCall(fn, fallback);
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    load();
  };
  const remove = async (a: KbSyncAttachment) => {
    setRemoving(null);
    setBusy(a.id); setError(''); setNotice('');
    const r = await kbCall(() => window.quorum.kbSyncRemove({ id: a.id }), 'The synced folder could not be removed.');
    setBusy(null);
    if (r.error) { setError(r.error); return; }
    setNotice(`${a.name} is removed. ${r.removed ? `${noteCount(r.removed)} left the knowledge base.` : ''}`.trim());
    load();
    changed();
  };

  return (
    <div className="kb-panel kb-sync">
      {source === 'google-drive' ? (
        <>
          <p className="kb-hint muted">Pick one Google Drive folder or file. Quorum's relay keeps it in sync in {folderLabel(kb, folderId)}, also while no Mac is open, using your Google Drive connection. Each Google Doc, markdown or text file becomes a note shared with the knowledge base's readers.</p>
          <div className="kb-form-row">
            <button className="pill primary" disabled={!!busy} onClick={attachDrive}>{busy === 'drive' ? 'Waiting for Google Drive…' : 'Choose in Google Drive'}</button>
            <button className="pill ghost" disabled={!!busy} onClick={() => openConnectors({ connector: 'google-drive' })}>Google Drive connection</button>
          </div>
          {busy === 'drive' && <p className="kb-hint muted" role="status">Pick the folder or file in the browser tab that opened, then come back here. Cancel ends the picker.</p>}
        </>
      ) : (
        <>
          <p className="kb-hint muted">Enter a GitHub repository, or a folder in one with /tree/branch/folder. You sign in to GitHub once for the relay, which then keeps its markdown files in sync in {folderLabel(kb, folderId)}. Private repositories need the Quorum GitHub App installed on them.</p>
          <div className="kb-form-row">
            <span className="set-field wide"><input aria-label="Repository address" placeholder="https://github.com/owner/repository" value={repo} disabled={!!busy} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') attachRepo(); }} /></span>
            <span className="set-field kb-branch"><input aria-label="Branch" placeholder="Branch (optional)" value={branch} disabled={!!busy} onChange={(e) => setBranch(e.target.value)} /></span>
            <button className="pill primary" disabled={!!busy || !repo.trim() || !!repoError} onClick={attachRepo}>{busy === 'github' ? 'Waiting for GitHub…' : 'Sign in and sync'}</button>
            {busy === 'github' && <button className="pill ghost" onClick={cancelWait}>Cancel</button>}
          </div>
          {busy === 'github' && <p className="kb-hint muted" role="status">Sign in to GitHub in the browser tab that opened, then come back here. Cancel ends the sign-in.</p>}
          {repoError && <p className="kb-hint muted">{repoError}</p>}
        </>
      )}
      {notice && <p className="kb-hint" role="status">{notice}</p>}
      {(error || pollError) && <p className="set-error" role="alert">{error || pollError}</p>}
      {list && list.length > 0 && (
        <>
          <p className="kb-label">Synced into {kb.name}</p>
          <ul className="kb-sync-list">
            {list.map((a) => {
              const st = syncStatus(a);
              const can = syncActions(a);
              return (
                <li key={a.id}>
                  <IconFolder width={16} height={16} />
                  <span className="kb-drive-name">
                    {a.url ? <button className="link-btn" title={`Open in ${providerName(a.provider)}`} onClick={() => window.quorum.openExternal(a.url!)}>{a.name}</button> : a.name}
                    <em className="muted">{remoteLine(a)} · into {folderLabel(kb, a.folder_id)}</em>
                    <em className="muted"><span className={`kb-sync-status ${st.tone}`}>{busy === a.id ? 'Working…' : st.label}</span> · {lastSynced(a, now ?? undefined)} · {noteCount(a.note_count)}</em>
                    {a.error && <em className={st.tone === 'warn' ? 'set-error' : 'muted'}>{a.error}</em>}
                  </span>
                  {can.syncNow && <button className="pill small" disabled={!!busy} onClick={() => act(a, () => window.quorum.kbSyncNow({ id: a.id }), 'The sync could not be started.')}>Sync now</button>}
                  {can.pause && <button className="pill small ghost" disabled={!!busy} onClick={() => act(a, () => window.quorum.kbSyncPause({ id: a.id, paused: true }), 'The sync could not be paused.')}>Pause</button>}
                  {can.resume && <button className="pill small" disabled={!!busy} onClick={() => act(a, () => window.quorum.kbSyncPause({ id: a.id, paused: false }), 'The sync could not be resumed.')}>Resume</button>}
                  <button className="pill small ghost" disabled={!!busy} onClick={() => setRemoving(a)}>Remove</button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {list && !list.length && <p className="kb-hint muted">Nothing is synced into {kb.name} yet.</p>}
      <div className="kb-form-row">
        <button className="pill ghost" disabled={!!busy && busy !== 'drive' && busy !== 'github'} onClick={onDone}>{busy === 'drive' || busy === 'github' ? 'Cancel' : 'Done'}</button>
      </div>
      {removing && <KbConfirm title={`Remove ${removing.name}?`} body={`Its notes leave the knowledge base and the readers' vaults, and the relay stops syncing it. Nothing changes in ${providerName(removing.provider)}.`} action="Remove" onDone={(ok) => (ok ? remove(removing) : setRemoving(null))} />}
    </div>
  );
}
