import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { type OwnerStatus, auth, configured, host } from './api';
import { passkey } from './passkey';
import { token } from './session';
import { SignIn } from './pages/SignIn';
import { Passkey } from './pages/Passkey';
import { Overview } from './pages/Overview';
import { Access } from './pages/Access';
import { Workspaces } from './pages/Workspaces';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';

// one page at a time, named in the hash so a reload keeps the place
const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'access', label: 'Access' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit' },
] as const;
type PageId = (typeof PAGES)[number]['id'];
const pageFromHash = (): PageId => { const h = location.hash.replace(/^#\/?/, ''); return (PAGES.some((p) => p.id === h) ? h : 'overview') as PageId; };

// sign-in is two steps: the email code gives the session, the passkey opens the owner's functions. The owner status
// RPC answers for any signed-in account (owner or not, passkeys registered, passkey session live), so the app knows
// which screen comes next without touching anything gated.
export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [status, setStatus] = useState<OwnerStatus | null | 'error'>(null);
  const [page, setPage] = useState<PageId>(pageFromHash);
  const refresh = useCallback(() => { auth.ownerStatus().then((r) => setStatus(r.ok ? r.value : 'error')); }, []);
  useEffect(() => {
    if (!configured) { setSession(null); return; }
    auth.session().then(setSession);
    return auth.onChange(setSession);
  }, []);
  useEffect(() => { if (session) refresh(); else setStatus(null); }, [session?.user.id, refresh]);
  useEffect(() => { const on = () => setPage(pageFromHash()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const signOut = async () => { await passkey.logout().catch(() => {}); await auth.signOut(); };

  if (!configured) return <Shell><p className="muted">This build has no Supabase project. Set QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY and build again.</p></Shell>;
  if (session === undefined) return <Shell />;
  if (!session) return <Shell><SignIn /></Shell>;
  const email = session.user.email ?? null;
  if (status === null) return <Shell email={email} onSignOut={signOut}><p className="muted">Checking the owner role…</p></Shell>;
  if (status === 'error') return <Shell email={email} onSignOut={signOut}><div className="card"><p>The project did not answer. It may be missing migration 0017.</p><p><button className="pill" onClick={refresh}>Try again</button></p></div></Shell>;
  if (!status.owner) return <Shell email={email} onSignOut={signOut}><div className="card"><p>This account is not the platform owner of {host}.</p><p className="muted">The role is granted with supabase/seed/platform-owner.sql. Sign in with the owner account instead.</p><p><button className="pill" onClick={signOut}>Sign out</button></p></div></Shell>;
  if (status.passkeys === 0 || !status.session || !token.get()) return <Shell email={email} onSignOut={signOut}><Passkey registered={status.passkeys} onDone={refresh} /></Shell>;

  return (
    <Shell email={email} onSignOut={signOut} nav={<nav className="nav" aria-label="Pages">{PAGES.map((p) => <a key={p.id} href={`#/${p.id}`} className={page === p.id ? 'on' : ''} aria-current={page === p.id ? 'page' : undefined}>{p.label}</a>)}</nav>}>
      {page === 'overview' && <Overview />}
      {page === 'access' && <Access />}
      {page === 'workspaces' && <Workspaces />}
      {page === 'users' && <Users />}
      {page === 'audit' && <Audit />}
    </Shell>
  );
}

function Shell({ children, email, nav, onSignOut }: { children?: React.ReactNode; email?: string | null; nav?: React.ReactNode; onSignOut?: () => void }) {
  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><img src="/favicon.svg" alt="" width="22" height="22" /><span>Quorum Admin</span>{host && <em className="host">{host}</em>}</div>
        {nav}
        <div className="me">{email && <><span className="muted">{email}</span><button className="link" onClick={onSignOut ?? (() => auth.signOut())}>Sign out</button></>}</div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
