import type { AccountState, Member, MemberInvite, Result, Role } from '../../src/quorum';

export type AccountApi = Pick<Window['quorum'], 'accountStatus' | 'accountSendCode' | 'accountVerifyCode' | 'accountSignOut' | 'orgCreate' | 'orgJoin' | 'orgSwitch' | 'membersList' | 'memberInvite' | 'memberRemove' | 'inviteRevoke' | 'syncSet' | 'syncNow' | 'onAccount'>;

// preload's bridge object cannot be patched, so the UI asks here: the real API when preload exposes accountStatus, a dev stand-in otherwise
let mock: AccountApi | null = null;
export function accountApi(): AccountApi {
  if ((window.quorum as Partial<Window['quorum']>).accountStatus) return window.quorum;
  return (mock ??= makeMock());
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
  const set = (patch: Partial<AccountState>) => { state = { ...state, ...patch }; subs.forEach((cb) => cb(state)); };
  const signedIn = (email: string) => set({
    ...blank(), signedIn: true, email, userId: 'u_me',
    invites: [{ inviteId: 'inv_1', workspaceId: 'ws_acme', workspaceName: 'Acme Health', role: 'member', invitedByEmail: 'dana@acmehealth.com', expiresAt: iso(6 * DAY) }],
    domainMatches: [{ workspaceId: 'ws_open', name: 'Smejkal Studio' }],
  });
  const inOrg = (name: string, domain: string | null, domainJoin: boolean, role: Role) => {
    const at = domain ?? 'example.com';
    members = [
      { userId: 'u_me', email: state.email ?? '', name: 'Eric Smejkal', role, joinedAt: iso(-40 * DAY) },
      { userId: 'u_2', email: `dana@${at}`, name: 'Dana Whitfield', role: 'admin', joinedAt: iso(-12 * DAY) },
      { userId: 'u_3', email: `sam@${at}`, name: null, role: 'member', joinedAt: iso(-2 * DAY) },
    ];
    invites = [{ inviteId: 'inv_9', email: `lee@${at}`, role: 'member', expiresAt: iso(5 * DAY) }];
    set({ workspace: { id: 'ws_1', name, domain, domainJoin, role }, workspaces: [{ id: 'ws_1', name, role }, { id: 'ws_acme', name: 'Acme Health', role: 'member' }], invites: [], domainMatches: [], sync: true, lastSyncAt: iso(-3 * 60000), syncError: null });
  };
  // jump to a state from the console or QUORUM_EVAL
  (window as unknown as { __accountMock: unknown }).__accountMock = {
    signedOut: () => set(blank()),
    noWorkspace: (email = 'eric@smejkal.design') => signedIn(email),
    workspace: (email = 'eric@smejkal.design') => { signedIn(email); inOrg('Smejkal Design', 'smejkal.design', true, 'owner'); },
  };
  return {
    accountStatus: async () => state,
    accountSendCode: async (email) => (EMAIL.test(email) ? ok : { error: 'Enter a valid email address' }),
    accountVerifyCode: async (email, code) => { await delay(400); if (!/^\d{6}$/.test(code)) return { error: 'That code did not match. Check the email and try again.' }; signedIn(email); return ok; },
    accountSignOut: async () => set(blank()),
    orgCreate: async (name, domain, domainJoin) => { await delay(400); inOrg(name, domain, domainJoin, 'owner'); return ok; },
    orgJoin: async (t) => { await delay(400); inOrg('inviteId' in t ? 'Acme Health' : 'Smejkal Studio', null, false, 'member'); return ok; },
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
