import type { AccountState, Member, MemberInvite, Result, Role } from './quorum';

// dev stand-in for the main-process account API, installed only when preload does not expose accountStatus
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 86400000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok: Result = { ok: true };
const blank = (): AccountState => ({ signedIn: false, email: null, userId: null, workspace: null, workspaces: [], invites: [], domainMatches: [], sync: false, lastSyncAt: null, syncError: null });

export function installAccountMock() {
  if ((window.quorum as Partial<Window['quorum']>).accountStatus) return;
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
  Object.assign(window.quorum, {
    accountStatus: async () => state,
    accountSendCode: async (email: string) => (EMAIL.test(email) ? ok : { error: 'Enter a valid email address' }),
    accountVerifyCode: async (email: string, code: string) => { await delay(400); if (!/^\d{6}$/.test(code)) return { error: 'That code did not match. Check the email and try again.' }; signedIn(email); return ok; },
    accountSignOut: async () => set(blank()),
    orgCreate: async (name: string, domain: string | null, domainJoin: boolean) => { await delay(400); inOrg(name, domain, domainJoin, 'owner'); return ok; },
    orgJoin: async (t: { inviteId: string } | { workspaceId: string }) => { await delay(400); inOrg('inviteId' in t ? 'Acme Health' : 'Smejkal Studio', null, false, 'member'); return ok; },
    orgSwitch: async (id: string) => { const w = state.workspaces.find((x) => x.id === id); if (w && state.workspace) set({ workspace: { ...state.workspace, id: w.id, name: w.name, role: w.role } }); return ok; },
    membersList: async () => ({ members, invites }),
    memberInvite: async (email: string, role: Role) => { if (!EMAIL.test(email)) return { error: 'Enter a valid email address' }; invites = [...invites, { inviteId: `inv_${Date.now()}`, email, role, expiresAt: iso(7 * DAY) }]; return ok; },
    memberRemove: async (userId: string) => { members = members.filter((m) => m.userId !== userId); return ok; },
    inviteRevoke: async (inviteId: string) => { invites = invites.filter((i) => i.inviteId !== inviteId); return ok; },
    syncSet: async (on: boolean) => { set({ sync: on }); return ok; },
    syncNow: async () => { await delay(700); set({ lastSyncAt: iso(0), syncError: null }); return { pushed: { notes: 3, meetings: 1 } }; },
    onAccount: (cb: (s: AccountState) => void) => { subs.add(cb); return () => { subs.delete(cb); }; },
  });
  // jump to a state from the console or QUORUM_EVAL
  (window as unknown as { __accountMock: unknown }).__accountMock = {
    signedOut: () => set(blank()),
    noWorkspace: (email = 'eric@smejkal.design') => signedIn(email),
    workspace: (email = 'eric@smejkal.design') => { signedIn(email); inOrg('Smejkal Design', 'smejkal.design', true, 'owner'); },
  };
}
