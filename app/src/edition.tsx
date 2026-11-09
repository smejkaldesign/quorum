import { lazy, Suspense, type ReactNode } from 'react';

// The renderer's edition, fixed at build time by Vite's define (vite.config.ts). Cloud-only UI lives in ee/src and is
// reached only through the dynamic imports below. Because __QUORUM_EDITION__ is a string literal in the bundle, the
// local build drops the cloud branches and never includes ee/src; scripts/check-edition-boundary.mjs verifies that.
export const EDITION: 'local' | 'cloud' = __QUORUM_EDITION__;
export const isCloud = __QUORUM_EDITION__ === 'cloud';

const CloudAccount = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.AccountSlot }))) : null;
const CloudMembers = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.MembersPage }))) : null;

// the account card for Settings › Workspace and the onboarding wizard. Cloud: the ee card, with `fallback` while the
// account status loads or when the build has no hosted account configured. Local: the `local` line.
export function AccountArea({ fallback = null, local }: { fallback?: ReactNode; local: ReactNode }) {
  if (!CloudAccount) return <>{local}</>;
  return <Suspense fallback={null}><CloudAccount fallback={fallback} /></Suspense>;
}

// the Members page; the local edition has no workspace, so it renders nothing
export function MembersArea() {
  if (!CloudMembers) return null;
  return <Suspense fallback={null}><CloudMembers /></Suspense>;
}
