import type { AccessCode, AccountState, Billing, Member, MemberInvite, PlatformWorkspace, Result, Role, WorkspaceConnector, WorkspaceVoice } from '../../src/quorum';

export type AccountApi = Pick<Window['quorum'], 'accountStatus' | 'accountSendCode' | 'accountVerifyCode' | 'accountSignOut' | 'orgCreate' | 'orgJoin' | 'orgSwitch' | 'membersList' | 'memberInvite' | 'memberRemove' | 'inviteRevoke' | 'syncSet' | 'syncNow' | 'onAccount'>;
export type ConnectorsApi = Pick<Window['quorum'], 'connectorsList' | 'connectorSet' | 'connectorRemove' | 'connectorTest'>;
export type VoiceApi = Pick<Window['quorum'], 'workspaceUsage' | 'workspaceVoiceGet' | 'workspaceVoiceSet'>;
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
export type PlatformApi = Pick<Window['quorum'], 'platformWorkspaces' | 'platformMembers' | 'platformUsage' | 'platformSetPlan' | 'platformAccessCodes' | 'platformIssueAccessCode' | 'platformRevokeAccessCode'>;

// the platform owner's page: two example workspaces, plans kept in memory
let platformMock: PlatformApi | null = null;
export function platformApi(): PlatformApi {
  if ((window.quorum as Partial<Window['quorum']>).platformWorkspaces) return window.quorum;
  if (platformMock) return platformMock;
  let list: PlatformWorkspace[] = [
    { id: 'ws_1', name: 'Example Co', domain: 'example.com', plan: 'cloud', seatsIncluded: 5, notes: null, members: 3, createdAt: iso(-90 * DAY), lastActivity: iso(-2 * 3600000) },
    { id: 'ws_acme', name: 'Acme Health', domain: null, plan: 'free', seatsIncluded: 0, notes: 'Trial from the launch list', members: 1, createdAt: iso(-10 * DAY), lastActivity: null },
  ];
  let codes: AccessCode[] = [
    { id: 'ac_1', email: 'dana@example.com', code: 'K7PQ2MX9', note: 'Launch list', issuedAt: iso(-3 * DAY), expiresAt: iso(27 * DAY), claimedAt: null, redeemedAt: iso(-2 * DAY), revokedAt: null, redeemedEmail: 'dana@example.com', status: 'redeemed' },
    { id: 'ac_2', email: 'lee@example.com', code: 'W4HN8TBC', note: null, issuedAt: iso(-DAY), expiresAt: iso(29 * DAY), claimedAt: null, redeemedAt: null, revokedAt: null, redeemedEmail: null, status: 'open' },
  ];
  return (platformMock = {
    platformWorkspaces: async () => ({ workspaces: list }),
    platformAccessCodes: async () => ({ codes }),
    platformIssueAccessCode: async (email, note) => { await delay(300); const c: AccessCode = { id: `ac_${Date.now()}`, email: email.toLowerCase(), code: 'ABCD2345', note: note || null, issuedAt: iso(0), expiresAt: iso(30 * DAY), claimedAt: null, redeemedAt: null, revokedAt: null, redeemedEmail: null, status: 'open' }; codes = [c, ...codes.map((x) => (x.email === c.email && x.status === 'open' ? { ...x, revokedAt: iso(0), status: 'revoked' as const } : x))]; return { code: c }; },
    platformRevokeAccessCode: async (id) => { codes = codes.map((x) => (x.id === id ? { ...x, revokedAt: iso(0), status: 'revoked' as const } : x)); return { ok: true }; },
    platformMembers: async (id) => ({ members: id === 'ws_1'
      ? [{ userId: 'u_me', email: 'you@example.com', name: 'Alex Rivera', role: 'owner', joinedAt: iso(-90 * DAY) }, { userId: 'u_2', email: 'dana@example.com', name: 'Dana Whitfield', role: 'admin', joinedAt: iso(-12 * DAY) }, { userId: 'u_3', email: 'sam@example.com', name: null, role: 'member', joinedAt: iso(-2 * DAY) }]
      : [{ userId: 'u_9', email: 'lee@example.com', name: 'Lee Park', role: 'owner', joinedAt: iso(-10 * DAY) }] }),
    platformUsage: async (id) => ({ usage: id === 'ws_1'
      ? { period: iso(0), hours: 6.5, managedHours: 4.25, calls: 9, steps: [{ role: 'notes', calls: 4, hours: 0, managedHours: 0 }, { role: 'speech', calls: 7, hours: 6.5, managedHours: 4.25 }, { role: 'summary', calls: 5, hours: 0, managedHours: 0 }] }
      : { period: iso(0), hours: 0, managedHours: 0, calls: 0, steps: [] } }),
    platformSetPlan: async (id, d) => { await delay(300); list = list.map((w) => (w.id === id ? { ...w, plan: d.plan, seatsIncluded: d.seatsIncluded, notes: d.notes || null } : w)); return { plan: { ...d, notes: d.notes || null } }; },
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
const blank = (): AccountState => ({ signedIn: false, email: null, userId: null, platformOwner: false, workspace: null, workspaces: [], invites: [], domainMatches: [], sync: false, lastSyncAt: null, syncError: null });

function makeMock(): AccountApi {
  let state = blank();
  let members: Member[] = [];
  let invites: MemberInvite[] = [];
  const subs = new Set<(s: AccountState) => void>();
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
    platformOwner: (email = 'you@example.com') => { signedIn(email); inOrg('Example Co', 'example.com', true, 'owner'); set({ platformOwner: true }); },
  };
  return {
    accountStatus: async () => state,
    accountSendCode: async (email, accessCode) => (!EMAIL.test(email) ? { error: 'Enter a valid email address' } : email.toLowerCase().startsWith('new') && !accessCode ? { needsCode: true, email } : ok),
    accountVerifyCode: async (email, code) => { await delay(400); if (!/^\d{6}$/.test(code)) return { error: 'That code did not match. Check the email and try again.' }; signedIn(email); return ok; },
    accountSignOut: async () => set(blank()),
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
