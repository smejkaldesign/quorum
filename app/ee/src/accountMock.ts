import type { AccountState, Billing, ContributionMine, Member, MemberInvite, Result, Role, WorkspaceConnector, WorkspaceVoice } from '../../src/quorum';

export type AccountApi = Pick<Window['quorum'], 'accountStatus' | 'accountSendCode' | 'accountVerifyCode' | 'accountSignOut' | 'accountGoogle' | 'onAccountOAuth' | 'orgCreate' | 'orgJoin' | 'orgSwitch' | 'membersList' | 'memberInvite' | 'memberRemove' | 'inviteRevoke' | 'syncSet' | 'syncNow' | 'onAccount'>;
export type ConnectorsApi = Pick<Window['quorum'], 'connectorsList' | 'connectorSet' | 'connectorRemove' | 'connectorTest'>;
export type VoiceApi = Pick<Window['quorum'], 'workspaceUsage' | 'workspaceVoiceGet' | 'workspaceVoiceSet'>;
export type KnowledgeApi = Pick<Window['quorum'], 'knowledgeStatus' | 'knowledgeQueue' | 'knowledgeReview' | 'knowledgeAutoIncludeSet' | 'knowledgeList' | 'knowledgeRead'>;
let knowledgeMock: KnowledgeApi | null = null;
export function knowledgeApi(): KnowledgeApi {
  if ((window.quorum as Partial<Window['quorum']>).knowledgeQueue) return window.quorum;
  if (knowledgeMock) return knowledgeMock;
  let auto = false;
  let queue = [{ id: 'q1', noteId: 'n1', path: '08-meetings/quorum/2026-11-08 Roadmap review.md', title: 'Roadmap review', authorEmail: 'dana@example.com', authorName: 'Dana Whitfield', createdAt: iso(-DAY), updatedAt: iso(-DAY) }];
  const mine: ContributionMine[] = [{ noteId: 'n2', path: '05-knowledge/onboarding.md', status: 'included', reviewedAt: iso(-3 * DAY), createdAt: iso(-4 * DAY) }];
  return (knowledgeMock = {
    knowledgeStatus: async () => ({ autoInclude: auto, mine }),
    knowledgeQueue: async () => ({ queue }),
    knowledgeReview: async (id, decision) => { await delay(200); queue = queue.filter((q) => q.id !== id); return { status: decision === 'include' ? 'included' : 'declined' }; },
    knowledgeAutoIncludeSet: async (on) => { auto = on; return { autoInclude: on }; },
    knowledgeList: async () => ({ root: '~/Documents/Quorum Team/Example Co', notes: [
      { rel: '05-knowledge/onboarding.md', title: 'Onboarding', pulledAt: iso(-3 * DAY), behind: false, item: 't1' },
      { rel: '08-meetings/2026-11-08 Roadmap review.md', title: 'Roadmap review', pulledAt: iso(-DAY), behind: true, item: 't2' },
    ] }),
    knowledgeRead: async (rel) => ({ doc: { rel, title: rel.replace(/^.*\//, '').replace(/\.md$/, ''), body: 'A shared note from a teammate.\n\n- One point\n- Another point', pulledAt: iso(-DAY), behind: false } }),
  });
}
export type BillingApi = Pick<Window['quorum'], 'billingStatus' | 'billingCheckout' | 'billingPortal' | 'billingPacks'>;
// billing: a subscribed workspace with one pack, kept in memory; Stripe pages are not opened in the mock
let billingMock: BillingApi | null = null;
export function billingApi(): BillingApi {
  if ((window.quorum as Partial<Window['quorum']>).billingStatus) return window.quorum;
  if (billingMock) return billingMock;
  let b: Billing = { plan: 'paid', seats: 3, seatsIncluded: 3, hourPacks: 1, members: 3, status: 'active', periodEnd: iso(21 * DAY), subscribed: true };
  return (billingMock = {
    billingStatus: async () => ({ billing: b }),
    billingCheckout: async () => { await delay(300); b = { ...b, plan: 'paid', subscribed: true, status: 'active' }; return ok; },
    billingPortal: async () => { await delay(300); return ok; },
    billingPacks: async (packs) => { await delay(300); b = { ...b, hourPacks: packs }; return { packs, remainingSeconds: (b.seats + packs) * 20 * 3600 }; },
  });
}
// organization voice: no usage yet (the relay is not written), overrides kept in memory
let voiceMock: VoiceApi | null = null;
export function voiceApi(): VoiceApi {
  if ((window.quorum as Partial<Window['quorum']>).workspaceVoiceGet) return window.quorum;
  if (voiceMock) return voiceMock;
  let voice: WorkspaceVoice = {};
  return (voiceMock = {
    workspaceUsage: async () => ({ usage: { period: iso(0), hours: 0, managedHours: 0, seats: [] } }),
    workspaceVoiceGet: async () => ({ voice }),
    workspaceVoiceSet: async (v) => { voice = { ...v }; return { voice }; },
  });
}

// preload's bridge object cannot be patched, so the UI asks here: the real API when preload exposes accountStatus, a dev stand-in otherwise
let mock: AccountApi | null = null;
export function accountApi(): AccountApi {
  if ((window.quorum as Partial<Window['quorum']>).accountStatus) return window.quorum;
  return (mock ??= makeMock());
}

// the same stand-in for workspace connectors: an in-memory list, every key accepted
let connectorsMock: ConnectorsApi | null = null;
export function connectorsApi(): ConnectorsApi {
  if ((window.quorum as Partial<Window['quorum']>).connectorsList) return window.quorum;
  if (connectorsMock) return connectorsMock;
  let list: WorkspaceConnector[] = [];
  return (connectorsMock = {
    connectorsList: async () => ({ connectors: list }),
    connectorSet: async (d) => {
      await delay(300);
      const now = iso(0);
      const at = list.findIndex((c) => c.provider === d.provider && c.label.toLowerCase() === d.label.toLowerCase());
      const c: WorkspaceConnector = { id: at >= 0 ? list[at].id : `con_${Date.now()}`, workspaceId: 'ws_1', provider: d.provider, label: d.label, baseUrl: d.baseUrl, roles: d.roles, createdBy: 'u_me', createdAt: at >= 0 ? list[at].createdAt : now, updatedAt: now };
      list = at >= 0 ? list.map((x, i) => (i === at ? c : x)) : [...list, c];
      return { connector: c };
    },
    connectorRemove: async (id) => { list = list.filter((c) => c.id !== id); return ok; },
    connectorTest: async (p) => { await delay(500); return p.secret.trim().length >= 8 ? ok : { error: 'That key looks too short.' }; },
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 86400000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok: Result = { ok: true };
const blank = (): AccountState => ({ signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [], sync: false, lastSyncAt: null, syncError: null });

function makeMock(): AccountApi {
  let state = blank();
  let members: Member[] = [];
  let invites: MemberInvite[] = [];
  const subs = new Set<(s: AccountState) => void>();
  const oauthSubs = new Set<(r: Result) => void>();
  const set = (patch: Partial<AccountState>) => { state = { ...state, ...patch }; subs.forEach((cb) => cb(state)); };
  const signedIn = (email: string) => set({
    ...blank(), signedIn: true, email, userId: 'u_me',
    invites: [{ inviteId: 'inv_1', workspaceId: 'ws_acme', workspaceName: 'Acme Health', role: 'member', invitedByEmail: 'dana@example.com', expiresAt: iso(6 * DAY) }],
    domainMatches: [{ workspaceId: 'ws_open', name: 'Example Studio' }],
  });
  const inOrg = (name: string, domain: string | null, domainJoin: boolean, role: Role) => {
    const at = domain ?? 'example.com';
    members = [
      { userId: 'u_me', email: state.email ?? '', name: 'Alex Rivera', role, joinedAt: iso(-40 * DAY) },
      { userId: 'u_2', email: `dana@${at}`, name: 'Dana Whitfield', role: 'admin', joinedAt: iso(-12 * DAY) },
      { userId: 'u_3', email: `sam@${at}`, name: null, role: 'member', joinedAt: iso(-2 * DAY) },
    ];
    invites = [{ inviteId: 'inv_9', email: `lee@${at}`, role: 'member', expiresAt: iso(5 * DAY) }];
    set({ workspace: { id: 'ws_1', name, domain, domainJoin, role }, workspaces: [{ id: 'ws_1', name, role }, { id: 'ws_acme', name: 'Acme Health', role: 'member' }], invites: [], domainMatches: [], sync: true, lastSyncAt: iso(-3 * 60000), syncError: null });
  };
  // jump to a state from the console or QUORUM_EVAL
  (window as unknown as { __accountMock: unknown }).__accountMock = {
    signedOut: () => set(blank()),
    noWorkspace: (email = 'you@example.com') => signedIn(email),
    workspace: (email = 'you@example.com') => { signedIn(email); inOrg('Example Co', 'example.com', true, 'owner'); },
  };
  return {
    accountStatus: async () => state,
    accountSendCode: async (email, accessCode) => (!EMAIL.test(email) ? { error: 'Enter a valid email address' } : email.toLowerCase().startsWith('new') && !accessCode ? { needsCode: true, email } : ok),
    accountVerifyCode: async (email, code) => { await delay(400); if (!/^\d{6}$/.test(code)) return { error: 'That code did not match. Check the email and try again.' }; signedIn(email); return ok; },
    accountSignOut: async () => set(blank()),
    accountGoogle: async () => { await delay(300); setTimeout(() => { signedIn('you@gmail.com'); oauthSubs.forEach((cb) => cb(ok)); }, 1200); return ok; },
    onAccountOAuth: (cb) => { oauthSubs.add(cb); return () => { oauthSubs.delete(cb); }; },
    orgCreate: async (name, domain, domainJoin) => { await delay(400); inOrg(name, domain, domainJoin, 'owner'); return ok; },
    orgJoin: async (t) => { await delay(400); inOrg('inviteId' in t ? 'Acme Health' : 'Example Studio', null, false, 'member'); return ok; },
    orgSwitch: async (id) => { const w = state.workspaces.find((x) => x.id === id); if (w && state.workspace) set({ workspace: { ...state.workspace, id: w.id, name: w.name, role: w.role } }); return ok; },
    membersList: async () => ({ members, invites }),
    memberInvite: async (email, role) => { if (!EMAIL.test(email)) return { error: 'Enter a valid email address' }; invites = [...invites, { inviteId: `inv_${Date.now()}`, email, role, expiresAt: iso(7 * DAY) }]; return ok; },
    memberRemove: async (userId) => { members = members.filter((m) => m.userId !== userId); return ok; },
    inviteRevoke: async (inviteId) => { invites = invites.filter((i) => i.inviteId !== inviteId); return ok; },
    syncSet: async (on) => { set({ sync: on }); return ok; },
    syncNow: async () => { await delay(700); set({ lastSyncAt: iso(0), syncError: null }); return { pushed: { notes: 3, meetings: 1 } }; },
    onAccount: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  };
}
