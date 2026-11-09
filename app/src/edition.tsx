import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

// The renderer's edition, fixed at build time by Vite's define (vite.config.ts). Cloud-only UI lives in ee/src and is
// reached only through the dynamic imports below. Because __QUORUM_EDITION__ is a string literal in the bundle, the
// local build drops the cloud branches and never includes ee/src; scripts/check-edition-boundary.mjs verifies that.
export const EDITION: 'local' | 'cloud' = __QUORUM_EDITION__;
export const isCloud = __QUORUM_EDITION__ === 'cloud';

const CloudAccount = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.AccountSlot }))) : null;
const CloudMembers = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.MembersPage }))) : null;

// whether this build can reach a hosted account at runtime: the cloud edition without QUORUM_SUPABASE_URL and the anon key
// reports configured: false from account-status. Local is always false; null while the cloud answer is on its way
export function useHostedAccounts(): boolean | null {
  const [hosted, setHosted] = useState<boolean | null>(isCloud ? null : false);
  useEffect(() => {
    if (!isCloud) return;
    let live = true;
    window.quorum.accountStatus().then((s) => { if (live) setHosted(s.configured !== false); }).catch(() => { if (live) setHosted(false); });
    return () => { live = false; };
  }, []);
  return hosted;
}

const NOT_SET_UP = <p className="muted">Hosted accounts are not set up in this build</p>;

// the account card for Settings › Workspace and the onboarding wizard. Cloud: the ee card, with `fallback` while the
// account status loads and `unconfigured` when the build has no hosted account configured. Local: the `local` line.
export function AccountArea({ fallback = null, local, unconfigured = NOT_SET_UP }: { fallback?: ReactNode; local: ReactNode; unconfigured?: ReactNode }) {
  const hosted = useHostedAccounts();
  if (!CloudAccount) return <>{local}</>;
  if (hosted === null) return <>{fallback}</>;
  if (!hosted) return <>{unconfigured}</>;
  return <Suspense fallback={null}><CloudAccount fallback={fallback} /></Suspense>;
}

// the Members page; the local edition has no workspace, and an unconfigured cloud build has no account to list members for
export function MembersArea() {
  const hosted = useHostedAccounts();
  if (!CloudMembers || !hosted) return null;
  return <Suspense fallback={null}><CloudMembers /></Suspense>;
}
