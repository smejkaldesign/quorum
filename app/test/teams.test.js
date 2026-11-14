// Teams inside a workspace (ee/teams.js, ee/src/teamList.ts): the shapes the renderer gets and the RPC each handler
// calls. The server's rights are tested in supabase/tests/teams.sql; here a fake client records calls.
import { describe, expect, it } from 'vitest';
import { checkTeamName, createTeams, shapeTeam } from '../ee/teams.js';
import { addableMembers, sortTeams, teamSummary } from '../ee/src/teamList';

const ROW = {
  id: 'T1', workspace_id: 'W', name: 'Design', my_role: 'lead', can_manage: true, can_manage_members: false, meetings_kb_id: 'KB9',
  members: [{ user_id: 'u1', role: 'lead', email: 'ana@example.com', name: 'Ana' }, { user_id: 'u2', role: 'odd', email: 'bo@example.com', name: null }],
};

function fakeAccount({ answers = {}, signedIn = true, role = 'member' } = {}) {
  const calls = [];
  const client = {
    rpc: async (name, args) => { calls.push([name, args]); const a = answers[name]; return a instanceof Error ? { data: null, error: { message: a.message, code: 'P0001' } } : { data: a ?? null, error: null }; },
  };
  const state = { signedIn, userId: 'me', workspace: { id: 'W', role } };
  return { calls, account: { client: () => client, state: () => state } };
}

describe('what the renderer gets', () => {
  it('shapes a team row defensively', () => {
    expect(shapeTeam(ROW)).toEqual({
      id: 'T1', name: 'Design', myRole: 'lead', canManage: true, canManageMembers: false, meetingsKbId: 'KB9',
      members: [{ userId: 'u1', role: 'lead', email: 'ana@example.com', name: 'Ana' }, { userId: 'u2', role: 'member', email: 'bo@example.com', name: null }],
    });
    expect(shapeTeam({ id: 'T2', name: 'x', my_role: 'owner' })).toMatchObject({ myRole: null, canManage: false, canManageMembers: false, meetingsKbId: null, members: [] });
  });

  it('checks names before the server sees them', () => {
    expect(checkTeamName('  Design ')).toEqual({ name: 'Design' });
    expect(checkTeamName('').error).toMatch(/needs a name/);
    expect(checkTeamName('x'.repeat(81)).error).toMatch(/too long/);
  });

  it('summarizes, sorts and offers the members still to add', () => {
    const team = shapeTeam(ROW);
    expect(teamSummary(team)).toBe('2 people · Lead: Ana');
    expect(teamSummary({ members: [] })).toBe('Nobody yet');
    expect(sortTeams([{ name: 'ops' }, { name: 'Design' }]).map((t) => t.name)).toEqual(['Design', 'ops']);
    const members = [{ userId: 'u3', email: 'cy@example.com', name: 'Cy' }, { userId: 'u1', email: 'ana@example.com', name: 'Ana' }, { userId: 'u4', email: 'al@example.com', name: null }];
    expect(addableMembers(team, members).map((m) => m.userId)).toEqual(['u4', 'u3']);
  });
});

describe('the IPC handlers', () => {
  it('stop before the server when signed out or the input is wrong', async () => {
    expect((await createTeams(fakeAccount({ signedIn: false })).handlers['team-list']()).error).toMatch(/Sign in/);
    const f = fakeAccount();
    const h = createTeams(f).handlers;
    expect((await h['team-create'](' ')).error).toMatch(/needs a name/);
    expect((await h['team-member-set']({ teamId: 'T1', userId: 'u1', role: 'owner' })).error).toMatch(/lead or member/);
    expect((await h['team-rename'](null, 'X')).error).toMatch(/Pick the team/);
    expect((await h['team-member-remove']({ teamId: 'T1' })).error).toMatch(/Pick the person/);
    expect(f.calls).toEqual([]);
  });

  it('leave rights to the server, so a team lead who is a plain member reaches it', async () => {
    const f = fakeAccount({ answers: { team_list: [ROW], team_create: ROW, team_rename: ROW, team_member_set: ROW, team_member_remove: ROW } });
    const h = createTeams(f).handlers;
    expect((await h['team-list']()).teams[0].name).toBe('Design');
    expect((await h['team-create'](' Design ')).team.id).toBe('T1');
    await h['team-rename']('T1', 'Design');
    expect(await h['team-delete']('T1')).toEqual({ ok: true });
    await h['team-member-set']({ teamId: 'T1', userId: 'u2' });
    await h['team-member-set']({ teamId: 'T1', userId: 'u2', role: 'lead' });
    await h['team-member-remove']({ teamId: 'T1', userId: 'u2' });
    expect(f.calls).toEqual([
      ['team_list', { workspace_id: 'W' }],
      ['team_create', { workspace_id: 'W', name: 'Design' }],
      ['team_rename', { team_id: 'T1', name: 'Design' }],
      ['team_delete', { team_id: 'T1' }],
      ['team_member_set', { team_id: 'T1', user_id: 'u2', role: 'member' }],
      ['team_member_set', { team_id: 'T1', user_id: 'u2', role: 'lead' }],
      ['team_member_remove', { team_id: 'T1', user_id: 'u2' }],
    ]);
  });

  it('passes the server refusal through as a sentence', async () => {
    const f = fakeAccount({ answers: { team_member_set: new Error('Only owners, admins and the team\'s leads can change its members') } });
    expect((await createTeams(f).handlers['team-member-set']({ teamId: 'T1', userId: 'u2' })).error).toMatch(/team's leads can change its members/);
  });
});
