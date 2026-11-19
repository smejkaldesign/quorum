import { useEffect, useState, type ReactNode } from 'react';
import type { AccountDeleteStatus, AccountState } from '../../src/quorum';
import { Modal, ModalActions, Row } from '../../src/controls';
import { DeleteDataRow, dataBody, useDataResetInfo } from '../../src/DeleteData';
import { IconBuilding, IconCheck, IconCopy, IconPower } from '../../src/icons';

// the tooltips on a delete that is not offered; the server decides both cases (account_delete_status, migration 0039)
export const OWNER_TIP = 'Owner must delete the org';
export const PLATFORM_TIP = 'You own Quorum bro...';

// the typed value has to be the signed-in email exactly; only spaces around a pasted value are ignored
export const typedMatches = (typed: string, email: string | null | undefined) => !!email && typed.trim() === email.trim();

type Status = AccountDeleteStatus | null;
const q = () => window.quorum as Partial<Window['quorum']>;

// the account and its delete status, re-read whenever the account changes (sign-in, a workspace made or deleted)
function useDeleteStatus(): { account: AccountState | null; status: Status } {
  const [account, setAccount] = useState<AccountState | null>(null);
  // the answer carries the account it was read for, so a stale one never shows after a switch or sign-out
  const [loaded, setLoaded] = useState<{ key: string; status: Status } | null>(null);
  useEffect(() => {
    let live = true;
    q().accountStatus?.().then((a) => { if (live) setAccount(a); }).catch(() => {});
    const off = q().onAccount?.((a) => { if (live) setAccount(a); });
    return () => { live = false; off?.(); };
  }, []);
  const key = account?.signedIn ? `${account.userId}|${account.workspaces.map((w) => `${w.id}:${w.role}`).join(',')}` : '';
  useEffect(() => {
    const read = q().accountDeleteStatus;
    if (!key || !read) return;
    let live = true;
    read().then((s) => { if (live) setLoaded({ key, status: 'error' in s ? null : s }); }).catch(() => { if (live) setLoaded({ key, status: null }); });
    return () => { live = false; };
  }, [key]);
  return { account, status: loaded && loaded.key === key ? loaded.status : null };
}

// a disabled button cannot show a tooltip of its own, so the tip sits on a wrapper
function Guarded({ tip, label, onClick }: { tip: string | null; label: string; onClick: () => void }) {
  if (!tip) return <button className="pill danger-pill" onClick={onClick}>{label}</button>;
  return <span className="guarded" data-tip={tip} data-tip-pos="left"><button className="pill danger-pill" disabled aria-label={`${label}. ${tip}`}>{label}</button></span>;
}

// the sheet both deletes use: the email shown with a copy button, a field to type it into, and the delete button that
// stays off until the two match
function TypeEmailConfirm({ title, body, action, email, onConfirm, onClose }: { title: string; body: string; action: string; email: string; onConfirm: (typed: string) => Promise<string | null>; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 5000); return () => clearTimeout(t); }, [copied]);
  const ok = typedMatches(typed, email);
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true); setError('');
    const err = await onConfirm(typed);
    if (err) { setError(err); setBusy(false); }
  };
  return (
    <Modal titleId="type-confirm-title" title={title} className="type-confirm" role="alertdialog" onClose={onClose} locked={busy}>
      <p>{body}</p>
      <p className="type-confirm-ask">Type your email address to confirm.</p>
      <label className="set-field wide copy-field">
        <input readOnly value={email} onFocus={(e) => e.target.select()} aria-label="Your email address" />
        <button type="button" className={`icon-btn copy-btn ${copied ? 'copied' : ''}`} aria-label={copied ? 'Copied' : 'Copy email address'} data-tip={copied ? 'Copied' : 'Copy'} data-tip-pos="left"
          onClick={() => { navigator.clipboard.writeText(email); setCopied(true); }}>
          <IconCopy className="ic-copy" width={16} height={16} /><IconCheck className="ic-check" width={16} height={16} />
        </button>
      </label>
      <label className="set-field wide">
        <input autoFocus value={typed} placeholder={email} aria-label="Type your email address" disabled={busy} spellCheck={false} autoCapitalize="off"
          onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      </label>
      {error && <p className="set-error" role="alert">{error}</p>}
      <ModalActions>
        <button className="pill" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pill danger-pill" disabled={!ok || busy} onClick={go}>{busy ? 'Deleting…' : action}</button>
      </ModalActions>
    </Modal>
  );
}

// Settings, Preferences, Danger zone: Delete my data (migration 0047 and this Mac) and delete the hosted account. Shown
// once signed in, else `fallback`; an owner of a workspace and the account that runs Quorum see Delete my account off,
// with the reason as its tooltip, and the account that runs Quorum sees Delete my data off too
export function DeleteAccountZone({ fallback = null }: { fallback?: ReactNode }) {
  const { account, status } = useDeleteStatus();
  const info = useDataResetInfo();
  const [open, setOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  if (!account?.signedIn || !account.email) return <>{fallback}</>;
  const tip = status?.platformOwner ? PLATFORM_TIP : status && status.owned.length ? OWNER_TIP : null;
  const owned = status?.owned ?? [];
  const desc = status?.platformOwner ? 'This account runs Quorum, so it is changed by hand, outside the app'
    : owned.length ? `You own ${owned.map((w) => w.name).join(', ')}. Delete the organization under Admin, General first`
    : 'Removes your hosted account and your private synced notes. Shared notes stay with the team. Files on this Mac stay';
  return (
    <>
      <h3>Danger zone</h3>
      <div className="set-card danger">
        {status && !status.platformOwner && <DeleteDataRow hosted onOpen={() => setDataOpen(true)} />}
        <Row icon={<IconPower width={18} height={18} />} title="Delete my account" desc={desc}>
          {status ? <Guarded tip={tip} label="Delete my account" onClick={() => setOpen(true)} /> : <button className="pill danger-pill" disabled>Delete my account</button>}
        </Row>
      </div>
      {open && (
        <TypeEmailConfirm title="Delete your Quorum account?" action="Delete my account" email={account.email}
          body={`This deletes the hosted account for ${account.email}, your private synced notes, your meetings and chats, and your place in every workspace. Notes you shared with a workspace, a team or a knowledge base stay with the team and move to the workspace owner, so everyone on them keeps access. Quorum then signs you out. The vault and every file on this Mac stay as they are. This cannot be undone.`}
          onClose={() => setOpen(false)}
          onConfirm={async (typed) => { const r = await window.quorum.accountDelete(typed); if (r?.error) return r.error; setOpen(false); return null; }} />
      )}
      {/* on success Quorum quits and starts again, so only a refusal comes back */}
      {dataOpen && (
        <TypeEmailConfirm title="Delete your data?" action="Delete my data" email={account.email} body={dataBody(info, true)}
          onClose={() => setDataOpen(false)}
          onConfirm={async (typed) => { const r = await window.quorum.dataDelete(typed); return r?.error ?? null; }} />
      )}
    </>
  );
}

// Settings, Admin, General: delete the workspace. Only its owner sees the card; the account that runs Quorum sees the
// button off
export function DeleteOrgCard() {
  const { account, status } = useDeleteStatus();
  const [open, setOpen] = useState(false);
  const ws = account?.workspace;
  if (!account?.signedIn || !account.email || !ws || ws.role !== 'owner') return null;
  const tip = status?.platformOwner ? PLATFORM_TIP : null;
  return (
    <>
      <h3>Danger zone</h3>
      <div className="set-card danger">
        <Row icon={<IconBuilding width={18} height={18} />} title="Delete organization" desc={`Removes ${ws.name} and everything synced to it. Every member loses access`}>
          {status ? <Guarded tip={tip} label="Delete organization" onClick={() => setOpen(true)} /> : <button className="pill danger-pill" disabled>Delete organization</button>}
        </Row>
      </div>
      {open && (
        <TypeEmailConfirm title={`Delete ${ws.name}?`} action="Delete organization" email={account.email}
          body={`This deletes the workspace ${ws.name} and everything synced to it: notes, meetings, chats, knowledge bases, teams, connectors and invites. Every member loses access; their own accounts and the files on their Macs stay. This cannot be undone.`}
          onClose={() => setOpen(false)}
          onConfirm={async (typed) => { const r = await window.quorum.orgDelete(ws.id, typed); if (r?.error) return r.error; setOpen(false); return null; }} />
      )}
    </>
  );
}
