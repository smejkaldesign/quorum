import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { type OwnerStatus, auth, configured, host } from './api';
import { passkey } from './passkey';
import { token } from './session';
import { Button, Card, Centered, IconBuilding, IconHistory, IconHome, IconKey, IconPeople, type NavItem, Shell, ToastProvider } from './ui';
import { SignIn } from './pages/SignIn';
import { Passkey } from './pages/Passkey';
import { Overview } from './pages/Overview';
import { Access } from './pages/Access';
import { Workspaces } from './pages/Workspaces';
import { Users } from './pages/Users';
import { Audit } from './pages/Audit';

// one page at a time, named in the hash so a reload keeps the place
const PAGES: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: IconHome },
  { id: 'access', label: 'Access', icon: IconKey },
  { id: 'workspaces', label: 'Workspaces', icon: IconBuilding },
  { id: 'users', label: 'Users', icon: IconPeople },
  { id: 'audit', label: 'Audit', icon: IconHistory },
];
type PageId = 'overview' | 'access' | 'workspaces' | 'users' | 'audit';
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

  if (!configured) return <Centered><Card form><p className="muted">This build has no Supabase project. Set QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY and build again.</p></Card></Centered>;
  if (session === undefined) return <Centered />;
  if (!session) return <Centered><SignIn /></Centered>;
  const email = session.user.email ?? null;
  if (status === null) return <Centered><p className="muted">Checking the owner role…</p></Centered>;
  if (status === 'error') return <Centered><Card form><h1>No answer</h1><p className="muted lede">The project did not answer. It may be missing migration 0017.</p><div className="actions"><Button variant="primary" onClick={refresh}>Try again</Button><Button variant="link" onClick={signOut}>Sign out</Button></div></Card></Centered>;
  if (!status.owner) return <Centered><Card form><h1>Owner only</h1><p className="muted lede">This account is not the platform owner of {host}. The role is granted with supabase/seed/platform-owner.sql. Sign in with the owner account instead.</p><div className="actions"><Button variant="primary" onClick={signOut}>Sign out</Button></div></Card></Centered>;
  if (status.passkeys === 0 || !status.session || !token.get()) return <Centered><Passkey registered={status.passkeys} onDone={refresh} /></Centered>;

  return (
    <ToastProvider>
      <Shell items={PAGES} current={page} email={email} onSignOut={signOut}>
        {page === 'overview' && <Overview />}
        {page === 'access' && <Access />}
        {page === 'workspaces' && <Workspaces />}
        {page === 'users' && <Users />}
        {page === 'audit' && <Audit />}
      </Shell>
    </ToastProvider>
  );
}
