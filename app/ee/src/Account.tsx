import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountState, Member, MemberInvite, Result, Role } from '../../src/quorum';
import { Row, Toggle, useMenu } from '../../src/controls';
import { IconBuilding, IconMore, IconPower, IconReset, IconTrash } from '../../src/icons';
import { accountApi } from './accountMock';

const api = accountApi();

// scripts/check-edition-boundary.mjs greps the built renderer for this string: it must be absent from the local
// bundle and present in the cloud bundle. The attribute below keeps the string in the output.
export const EE_MARKER = 'QUORUM_EE_MARKER';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONSUMER = new Set(['gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com']);
const GENERIC_TLD = new Set(['com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'me', 'us', 'uk', 'ca', 'de', 'fr', 'au', 'nl', 'se', 'ch', 'xyz', 'info', 'biz']);
const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

// consumer mailboxes get no domain, so no domain join and no prefilled name
export const emailDomain = (email: string) => { const d = email.split('@')[1]?.toLowerCase() ?? ''; return !d || CONSUMER.has(d) ? null : d; };
export const orgNameFor = (domain: string) => {
  const parts = domain.split('.');
  while (parts.length > 1 && GENERIC_TLD.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ').split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
};
export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const until = (iso: string) => { const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000); return d <= 0 ? 'Expired' : d === 1 ? 'Expires tomorrow' : `Expires in ${d} days`; };
const onDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

export function useAccount() {
  const [a, setA] = useState<AccountState | null>(null);
  useEffect(() => { api.accountStatus().then(setA); return api.onAccount(setA); }, []);
  return a;
}

export function AccountCard({ account }: { account: AccountState }) {
  return (
    <div data-ee={EE_MARKER}>
      <h3>Account</h3>
      {!account.signedIn ? <SignIn /> : !account.workspace ? <PickOrg account={account} /> : <OrgCard account={account} />}
    </div>
  );
}

// the card plus the state it needs, for the places (Settings, onboarding) that mount the account UI from src/edition.tsx;
// shows `fallback` while status loads or when the build has no hosted account configured
export function AccountSlot({ fallback = null }: { fallback?: ReactNode }) {
  const account = useAccount();
  return account ? <AccountCard account={account} /> : <>{fallback}</>;
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<Result>, then: () => void) => { setBusy(true); setError(''); const r = await fn(); setBusy(false); if (r.error) setError(r.error); else then(); };
  const send = () => run(() => api.accountSendCode(email.trim()), () => setSent(true));
  const verify = () => run(() => api.accountVerifyCode(email.trim(), code), () => {});
  const ok = EMAIL.test(email.trim());
  return (
    <div className="set-card form acct">
      <p className="acct-copy">Sign in to sync notes and meetings and to share a workspace with your team. Everything keeps working on this Mac without it.</p>
      {!sent ? (
        <div className="set-line">
          <label className="set-field wide"><input type="email" autoComplete="email" aria-label="Email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) send(); }} /></label>
          <div className="set-line-end"><button className="pill primary" disabled={!ok || busy} onClick={send}>{busy ? 'Sending…' : 'Send code'}</button></div>
        </div>
      ) : (
        <>
          <div className="set-line"><div className="set-label"><strong>Enter the code</strong><span>Sent to {email.trim()}. Check your inbox.</span></div></div>
          <div className="set-line">
            <CodeField value={code} onChange={setCode} onSubmit={() => { if (code.length === 6 && !busy) verify(); }} />
            <div className="set-line-end"><button className="pill primary" disabled={code.length < 6 || busy} onClick={verify}>{busy ? 'Signing in…' : 'Sign in'}</button></div>
          </div>
          <div className="set-line acct-alt"><button className="link-btn" onClick={() => { setSent(false); setCode(''); setError(''); }}>Use a different email</button></div>
        </>
      )}
      {error && <p className="set-error">{error}</p>}
    </div>
  );
}

// six boxes; typing moves on, Backspace moves back, paste fills them all, Enter submits
function CodeField({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const put = (next: string, focus: number) => { const v = next.replace(/\D/g, '').slice(0, 6); onChange(v); refs.current[Math.min(5, Math.max(0, focus))]?.focus(); };
  return (
    <div className="code-field" onPaste={(e) => { const t = e.clipboardData.getData('text').replace(/\D/g, ''); if (t) { e.preventDefault(); put(t, t.length); } }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={`Digit ${i + 1}`} value={value[i] ?? ''} autoFocus={i === 0}
          onFocus={(e) => e.target.select()}
          onChange={(e) => { const c = e.target.value.replace(/\D/g, '').slice(-1); if (!c) return; const next = value.slice(0, i) + c + value.slice(i + 1); put(next, next.length); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
            else if (e.key === 'Backspace') { e.preventDefault(); if (value[i]) put(value.slice(0, i) + value.slice(i + 1), i); else put(value.slice(0, -1), value.length - 1); }
            else if (e.key === 'ArrowLeft') refs.current[i - 1]?.focus();
            else if (e.key === 'ArrowRight') refs.current[i + 1]?.focus();
          }} />
      ))}
    </div>
  );
}

function SignOutMenu() {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label="Account options" aria-haspopup="menu" aria-expanded={open} data-tip="More options" onClick={() => setOpen((o) => !o)}><IconMore /></button>
      {open && (
        <div className="menu end" role="menu">
          <button role="menuitem" className="danger" onClick={() => { setOpen(false); api.accountSignOut(); }}><IconPower width={15} height={15} /> Sign out</button>
        </div>
      )}
    </span>
  );
}

// signed in with no organization yet: start one, or take an invitation or an open domain
function PickOrg({ account }: { account: AccountState }) {
  const email = account.email ?? '';
  const domain = emailDomain(email);
  const [name, setName] = useState(domain ? orgNameFor(domain) : '');
  const [join, setJoin] = useState(!!domain);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = async (key: string, fn: () => Promise<Result>) => { setBusy(key); setError(''); const r = await fn(); setBusy(null); if (r.error) setError(r.error); };
  const create = () => { if (name.trim() && !busy) run('create', () => api.orgCreate(name.trim(), domain, !!domain && join)); };
  const none = !account.invites.length && !account.domainMatches.length;
  return (
    <div className="set-card form acct">
      <div className="set-line">
        <div className="set-label"><strong>Signed in as {email}</strong><span>Set up an organization or join one to share a workspace with your team.</span></div>
        <SignOutMenu />
      </div>
      <div className="set-line stacked">
        <div className="set-label"><strong>Set up a new organization</strong><span>{domain ? 'Named after your email domain. You can change it.' : 'Your organization gets its own workspace for notes and members.'}</span></div>
        <div className="org-form">
          <label className="set-field wide"><input aria-label="Organization name" placeholder="Organization name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} /></label>
          {domain && <span className="org-domain" aria-label="Domain">{domain}</span>}
          <button className="pill primary" disabled={!name.trim() || busy === 'create'} onClick={create}>{busy === 'create' ? 'Creating…' : 'Create'}</button>
        </div>
        {domain && <div className="org-join"><span>Anyone with an @{domain} email can join</span><Toggle on={join} onChange={setJoin} /></div>}
      </div>
      <div className="set-line stacked">
        <div className="set-label"><strong>Join an existing organization</strong><span>Invitations for {email}{domain ? `, and organizations open to @${domain}` : ''}</span></div>
        {account.invites.map((inv) => (
          <div key={inv.inviteId} className="join-row">
            <span><strong>{inv.workspaceName}</strong><em className="muted"> · {ROLE[inv.role]}{inv.invitedByEmail ? ` · invited by ${inv.invitedByEmail}` : ''} · {until(inv.expiresAt)}</em></span>
            <button className="pill small-pill" disabled={busy === inv.inviteId} onClick={() => run(inv.inviteId, () => api.orgJoin({ inviteId: inv.inviteId }))}>{busy === inv.inviteId ? 'Joining…' : 'Join'}</button>
          </div>
        ))}
        {account.domainMatches.map((m) => (
          <div key={m.workspaceId} className="join-row">
            <span><strong>{m.name}</strong><em className="muted"> · Open to @{domain}</em></span>
            <button className="pill small-pill" disabled={busy === m.workspaceId} onClick={() => run(m.workspaceId, () => api.orgJoin({ workspaceId: m.workspaceId }))}>{busy === m.workspaceId ? 'Joining…' : 'Join'}</button>
          </div>
        ))}
        {none && <p className="acct-none">No invitations yet. Ask an admin to invite {email}.</p>}
      </div>
      {error && <p className="set-error">{error}</p>}
    </div>
  );
}

function OrgCard({ account }: { account: AccountState }) {
  const ws = account.workspace!;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(''), 6000); return () => clearTimeout(t); }, [msg]);
  const syncNow = async () => {
    setBusy(true); setErr(''); setMsg('');
    const r = await api.syncNow();
    setBusy(false);
    if (r.error) setErr(r.error);
    else if (r.pushed) {
      const pulled = r.pulled ? `Pulled ${count(r.pulled.notes, 'note')}${r.pulled.conflicts ? ` (${count(r.pulled.conflicts, 'conflict copy')})` : ''}, p` : 'P';
      setMsg(`${pulled}ushed ${count(r.pushed.notes, 'note')} and ${count(r.pushed.meetings, 'meeting')}`);
    }
  };
  const error = err || account.syncError;
  const last = `${account.lastSyncAt ? `Last synced ${ago(account.lastSyncAt)}` : 'Not synced yet'}${account.sync ? (account.live ? ' · Live' : ' · Polling') : ''}`;
  const desc = !account.sync ? 'Off. Notes and meetings stay on this Mac; nothing is pulled from the workspace'
    : <>{error ? <em className="acct-err">{error}</em> : msg ? <em className="acct-ok">{msg}</em> : null}{(error || msg) && ' · '}{last}</>;
  return (
    <div className="set-card">
      <Row icon={<IconBuilding width={18} height={18} className="ok" />} title={<>{ws.name}<em className="stub">{ROLE[ws.role]}</em></>} desc={account.email}>
        {account.workspaces.length > 1 && (
          <select className="set-select" aria-label="Switch organization" value={ws.id} onChange={(e) => api.orgSwitch(e.target.value)}>
            {account.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        )}
        <SignOutMenu />
      </Row>
      <Row icon={<IconReset width={18} height={18} className={!account.sync ? undefined : error ? 'err' : 'ok'} />} title="Sync notes and meetings" desc={desc}>
        {account.sync && <button className="pill small-pill" disabled={busy} onClick={syncNow}>{busy ? 'Syncing…' : 'Sync now'}</button>}
        <Toggle on={account.sync} onChange={(v) => api.syncSet(v)} />
      </Row>
    </div>
  );
}

export function MembersPage() {
  const account = useAccount();
  if (!account) return null;
  if (!account.signedIn || !account.workspace) return <AccountCard account={account} />;
  return <Members account={account} />;
}

function Members({ account }: { account: AccountState }) {
  const ws = account.workspace!;
  const [list, setList] = useState<{ members: Member[]; invites: MemberInvite[] } | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const load = () => api.membersList().then((r) => { if ('error' in r) setError(r.error); else setList(r); });
  useEffect(() => { load(); }, [ws.id]);
  const act = async (fn: () => Promise<Result>) => { setBusy(true); setError(''); const r = await fn(); setBusy(false); if (r.error) setError(r.error); else load(); return !r.error; };
  const invite = async () => { if (await act(() => api.memberInvite(email.trim().toLowerCase(), role))) setEmail(''); };
  const canManage = ws.role !== 'member';
  const owners = list?.members.filter((m) => m.role === 'owner').length ?? 0;
  const ok = EMAIL.test(email.trim());
  const blocked = (m: Member) => {
    if (m.userId === account.userId && m.role === 'owner' && owners <= 1) return 'You are the only owner. Make someone else an owner first.';
    if (m.role === 'owner' && ws.role !== 'owner') return 'Only an owner can remove an owner';
    return null;
  };
  return (
    <>
      <h3>Invite teammates</h3>
      <div className="set-card form acct">
        <div className="set-line">
          <label className="set-field wide"><input type="email" aria-label="Email" placeholder="name@example.com" value={email} disabled={!canManage} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) invite(); }} /></label>
          <div className="set-line-end">
            <select className="set-select" aria-label="Role" value={role} disabled={!canManage} onChange={(e) => setRole(e.target.value as Role)}><option value="member">Member</option><option value="admin">Admin</option></select>
            {canManage
              ? <button className="pill" disabled={!ok || busy} onClick={invite}>Invite</button>
              : <span data-tip="Only owners and admins can invite"><button className="pill" disabled>Invite</button></span>}
          </div>
        </div>
        {error && <p className="set-error">{error}</p>}
      </div>

      <h3>{list ? count(list.members.length, 'member') : 'Members'}</h3>
      <div className="set-card">
        {list?.members.map((m) => {
          const me = m.userId === account.userId;
          const why = blocked(m);
          return (
            <div key={m.userId} className="member-row">
              <span className="member-avatar">{(m.name || m.email)[0].toUpperCase()}</span>
              <div className="set-text"><strong>{m.name || m.email}{me && <em className="stub">You</em>}</strong><span>{m.name ? `${m.email} · ` : ''}Joined {onDate(m.joinedAt)}</span></div>
              <em className="stub">{ROLE[m.role]}</em>
              {canManage && <MemberMenu label={m.name || m.email} why={why} onRemove={() => act(() => api.memberRemove(m.userId))} />}
            </div>
          );
        })}
      </div>

      {!!list?.invites.length && (
        <>
          <h3>Pending invites</h3>
          <div className="set-card">
            {list.invites.map((inv) => (
              <div key={inv.inviteId} className="member-row">
                <span className="member-avatar pending">{inv.email[0].toUpperCase()}</span>
                <div className="set-text"><strong>{inv.email}</strong><span>{until(inv.expiresAt)}</span></div>
                <em className="stub">{ROLE[inv.role]}</em>
                {canManage && <button className="pill small-pill" disabled={busy} onClick={() => act(() => api.inviteRevoke(inv.inviteId))}>Revoke</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function MemberMenu({ label, why, onRemove }: { label: string; why: string | null; onRemove: () => void }) {
  const [open, setOpen] = useMenu();
  return (
    <span className="menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label={`${label} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><IconMore width={16} height={16} /></button>
      {open && (
        <div className="menu end" role="menu">
          {why
            ? <span data-tip={why} data-tip-pos="left"><button role="menuitem" className="danger" disabled><IconTrash width={15} height={15} /> Remove</button></span>
            : <button role="menuitem" className="danger" onClick={() => { setOpen(false); onRemove(); }}><IconTrash width={15} height={15} /> Remove</button>}
        </div>
      )}
    </span>
  );
}
