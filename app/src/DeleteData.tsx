import { useEffect, useState } from 'react';
import type { DataResetInfo } from './quorum';
import { Modal, ModalActions, Row } from './controls';
import { IconTrash } from './icons';

// Delete my data (main.js, dataReset.js), in both editions. The Local edition and a signed-out Cloud build confirm by
// typing the phrase; a signed-in Cloud account confirms with its email in ee/src/AccountDelete.tsx.

// the phrase has to match exactly; case and spaces around it are ignored
export const phraseMatches = (typed: string, phrase: string) => typed.trim().toLowerCase() === phrase;

export function useDataResetInfo(): DataResetInfo | null {
  const [info, setInfo] = useState<DataResetInfo | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve(window.quorum.dataResetInfo?.()).then((i) => { if (live && i) setInfo(i); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return info;
}

// what the confirm says. hosted adds the Cloud half; the vault sentence names the folder that stays
export function dataBody(info: DataResetInfo | null, hosted: boolean): string {
  const cloud = hosted ? 'This deletes your private synced notes, chats, meetings and personal knowledge bases from Quorum Cloud. Your account, email and plan stay. Notes you shared with a workspace, a team or a knowledge base move to the workspace owner, so the team keeps them. In a workspace where you are the only member, everything synced to it goes, and the workspace and its plan stay. ' : '';
  const local = 'everything Quorum keeps on this Mac: settings, chats, meeting recordings and transcripts, the memory graph and search index, note versions, logs, caches, the sign-in, and the Keychain key that protects saved keys and tokens.';
  const models = info?.keepsModels ? ' Downloaded models stay, so Quorum does not download them again.' : '';
  const vault = info?.vault ? ` The vault folder at ${info.vault} stays as it is, with every note in it.` : ' Quorum has no vault folder connected; any vault folder on this Mac stays as it is.';
  return `${cloud}${hosted ? 'Then it deletes' : 'This deletes'} ${local}${models}${vault} Quorum then restarts into setup. This cannot be undone.`;
}

// the sheet for the phrase: what goes, a field to type the phrase into, and the delete button that stays off until it matches
export function PhraseConfirm({ info, onClose }: { info: DataResetInfo | null; onClose: () => void }) {
  const phrase = info?.phrase ?? 'delete my data';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = phraseMatches(typed, phrase);
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true); setError('');
    // on success Quorum quits and starts again, so only a refusal comes back
    const r = await window.quorum.dataDelete(typed);
    if (r?.error) { setError(r.error); setBusy(false); }
  };
  return (
    <Modal titleId="data-confirm-title" title="Delete your data on this Mac?" className="type-confirm" role="alertdialog" onClose={onClose} locked={busy}>
      <p>{dataBody(info, false)}</p>
      <p className="type-confirm-ask">Type <strong>{phrase}</strong> to confirm.</p>
      <label className="set-field wide">
        <input autoFocus value={typed} placeholder={phrase} aria-label={`Type ${phrase}`} disabled={busy} spellCheck={false} autoCapitalize="off"
          onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      </label>
      {error && <p className="set-error" role="alert">{error}</p>}
      <ModalActions>
        <button className="pill" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pill danger-pill" disabled={!ok || busy} onClick={go}>{busy ? 'Deleting…' : 'Delete my data'}</button>
      </ModalActions>
    </Modal>
  );
}

export function DeleteDataRow({ hosted, onOpen }: { hosted: boolean; onOpen: () => void }) {
  return (
    <Row icon={<IconTrash width={18} height={18} />} title="Delete my data"
      desc={hosted ? 'Removes your synced data and everything Quorum keeps on this Mac. Your account, plan and vault folder stay' : 'Removes everything Quorum keeps on this Mac and starts setup again. Your vault folder stays'}>
      <button className="pill danger-pill" onClick={onOpen}>Delete my data</button>
    </Row>
  );
}

// Settings, Preferences, Danger zone when no Cloud account is signed in: Delete my data alone
export function LocalDataZone() {
  const info = useDataResetInfo();
  const [open, setOpen] = useState(false);
  return (
    <>
      <h3>Danger zone</h3>
      <div className="set-card danger">
        <DeleteDataRow hosted={false} onOpen={() => setOpen(true)} />
      </div>
      {open && <PhraseConfirm info={info} onClose={() => setOpen(false)} />}
    </>
  );
}
