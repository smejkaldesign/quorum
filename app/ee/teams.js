// Teams inside a workspace (Cloud edition; migration 0035, docs/specs/workspace-knowledge.md "Access"). A workspace
// member can be in many teams, as lead or member. Workspace owners and admins create, rename and delete teams; they
// and the team's leads rename it and change its members; a member can leave a team. Each team has a meetings
// knowledge base, readable by that team until its lead or a workspace admin grants other teams read access in
// Admin > Knowledge. The server decides every right and refuses with a sentence the app shows as is.
//
// IPC API (preload exposes each as window.quorum.<camelName>); every handler resolves to { error } on a refusal:
//   team-list          ()                              -> { teams: Team[] }
//   team-create        (name)                          -> { team: Team }      owners and admins only
//   team-rename        (teamId, name)                  -> { team: Team }
//   team-delete        (teamId)                        -> { ok: true }        owners and admins only
//   team-member-set    ({ teamId, userId, role? })     -> { team: Team }      adds a person, or changes their role
//   team-member-remove ({ teamId, userId })            -> { team: Team }
//
//   Team       { id, name, myRole: 'lead' | 'member' | null, canManage, meetingsKbId, members: TeamMember[] }
//   TeamMember { userId, role: 'lead' | 'member', email, name }
import { kbSession } from './knowledgeBases.js';

export const TEAM_ROLES = ['lead', 'member'];

export function checkTeamName(name) {
  const n = String(name ?? '').trim();
  if (!n) return { error: 'A team needs a name.' };
  if (n.length > 80) return { error: 'That name is too long.' };
  return { name: n };
}

export const shapeTeam = (t) => ({
  id: t.id, name: t.name, myRole: TEAM_ROLES.includes(t.my_role) ? t.my_role : null, canManage: t.can_manage === true, meetingsKbId: t.meetings_kb_id ?? null,
  members: (Array.isArray(t.members) ? t.members : []).map((m) => ({ userId: m.user_id, role: m.role === 'lead' ? 'lead' : 'member', email: m.email ?? null, name: m.name ?? null })),
});

export function createTeams({ account, log = () => {} }) {
  const { ws, rpc, call } = kbSession({ account, log, tag: 'teams' });
  const need = (v, what) => { if (!v || typeof v !== 'string') throw Object.assign(new Error(`Pick the ${what} first.`), { code: 'P0001' }); return v; };
  const handlers = {
    'team-list': call(false, 'The teams could not be read.', async () => ({ teams: ((await rpc('team_list', { workspace_id: ws() })) ?? []).map(shapeTeam) })),
    'team-create': call(false, 'The team could not be created.', async (name) => {
      const n = checkTeamName(name); if (n.error) return n;
      return { team: shapeTeam(await rpc('team_create', { workspace_id: ws(), name: n.name })) };
    }),
    'team-rename': call(false, 'The team could not be renamed.', async (teamId, name) => {
      const n = checkTeamName(name); if (n.error) return n;
      return { team: shapeTeam(await rpc('team_rename', { team_id: need(teamId, 'team'), name: n.name })) };
    }),
    'team-delete': call(false, 'The team could not be deleted.', async (teamId) => { await rpc('team_delete', { team_id: need(teamId, 'team') }); return { ok: true }; }),
    'team-member-set': call(false, 'The team could not be changed.', async (draft = {}) => {
      const role = draft.role ?? 'member';
      if (!TEAM_ROLES.includes(role)) return { error: 'A team role is lead or member.' };
      return { team: shapeTeam(await rpc('team_member_set', { team_id: need(draft.teamId, 'team'), user_id: need(draft.userId, 'person'), role })) };
    }),
    'team-member-remove': call(false, 'The team could not be changed.', async (draft = {}) => (
      { team: shapeTeam(await rpc('team_member_remove', { team_id: need(draft.teamId, 'team'), user_id: need(draft.userId, 'person') })) }
    )),
  };
  return { handlers };
}

export function registerTeams({ ipcMain, account, log }) {
  const teams = createTeams({ account, log });
  for (const [name, fn] of Object.entries(teams.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return teams;
}
