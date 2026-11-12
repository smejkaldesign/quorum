import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

// The renderer's edition, fixed at build time by Vite's define (vite.config.ts). Cloud-only UI lives in ee/src and is
// reached only through the dynamic imports below. Because __QUORUM_EDITION__ is a string literal in the bundle, the
// local build drops the cloud branches and never includes ee/src; scripts/check-edition-boundary.mjs verifies that.
export const EDITION: 'local' | 'cloud' = __QUORUM_EDITION__;
export const isCloud = __QUORUM_EDITION__ === 'cloud';

const CloudAccount = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.AccountSlot }))) : null;
const CloudMembers = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Account').then((m) => ({ default: m.MembersPage }))) : null;
const CloudConnectors = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/WorkspaceConnectors').then((m) => ({ default: m.WorkspaceConnectorsPage }))) : null;
const CloudVoice = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/WorkspaceVoice').then((m) => ({ default: m.WorkspaceVoicePage }))) : null;
const CloudGuardrails = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/WorkspaceGuardrails').then((m) => ({ default: m.WorkspaceGuardrailsPage }))) : null;
const CloudBilling = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Billing').then((m) => ({ default: m.BillingPage }))) : null;
const CloudTeams = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Teams').then((m) => ({ default: m.TeamsPage }))) : null;
const CloudKnowledge = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/Knowledge').then((m) => ({ default: m.KnowledgePage }))) : null;
const CloudKnowledgeTab = __QUORUM_EDITION__ === 'cloud' ? lazy(() => import('../ee/src/KnowledgeTab').then((m) => ({ default: m.KnowledgeTab }))) : null;

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

// a Workspace page that exists only with a hosted workspace: the ee page in Cloud, `local` in the Local edition
function CloudPage({ Page, local }: { Page: ReturnType<typeof lazy> | null; local: ReactNode }) {
  const hosted = useHostedAccounts();
  if (!Page) return <>{local}</>;
  if (hosted === null) return null;
  if (!hosted) return NOT_SET_UP;
  return <Suspense fallback={null}><Page /></Suspense>;
}

// Settings › Admin › Billing: the plan, seats, hours, the card and the upgrade; the Local edition has nothing to bill
export const BillingArea = () => <CloudPage Page={CloudBilling} local={null} />;
// Settings › Admin › Teams: the "Enable a team" switch, with the company card (a core settings form) shown once it is on
export function TeamsArea({ company }: { company: ReactNode }) {
  const hosted = useHostedAccounts();
  if (!CloudTeams) return null;
  if (hosted === null) return null;
  if (!hosted) return NOT_SET_UP;
  return <Suspense fallback={null}><CloudTeams company={company} /></Suspense>;
}
// the Knowledge top tab: the workspace's shared notes and the admin review queue; the Local edition has no such tab
export const KnowledgeTabArea = () => <CloudPage Page={CloudKnowledgeTab} local={null} />;
// Settings › Knowledge: auto-include and what each member shared; the Local edition shows its own zero state
export const KnowledgeQueueArea = ({ local }: { local: ReactNode }) => <CloudPage Page={CloudKnowledge} local={local} />;
// Settings › Admin › Connectors: organization providers an admin manages for everyone
export const WorkspaceConnectorsArea = ({ local }: { local: ReactNode }) => <CloudPage Page={CloudConnectors} local={local} />;
// Settings › Admin › Voice typing: the managed pipeline, its usage, and which connector handles each step
export const WorkspaceVoiceArea = ({ local }: { local: ReactNode }) => <CloudPage Page={CloudVoice} local={local} />;
export const WorkspaceGuardrailsArea = ({ local }: { local: ReactNode }) => <CloudPage Page={CloudGuardrails} local={local} />;
