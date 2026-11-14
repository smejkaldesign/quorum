import type { Member, Team } from '../../src/quorum';

// Pure helpers for Settings › Admin › Teams: the one-line summary of a team, the order teams list in, and the
// workspace members who can still be added to one.

// "3 people · Lead: Ana" or "Nobody yet"
export function teamSummary(team: Pick<Team, 'members'>): string {
  const n = team.members.length;
  if (!n) return 'Nobody yet';
  const leads = team.members.filter((m) => m.role === 'lead').map((m) => m.name || m.email || 'Someone');
  const parts = [`${n} ${n === 1 ? 'person' : 'people'}`];
  if (leads.length) parts.push(`${leads.length === 1 ? 'Lead' : 'Leads'}: ${leads.join(', ')}`);
  return parts.join(' · ');
}

export const sortTeams = (teams: Team[]): Team[] => [...teams].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

// workspace members not yet in the team, by name
export function addableMembers(team: Pick<Team, 'members'>, members: Member[]): Member[] {
  const inTeam = new Set(team.members.map((m) => m.userId));
  return members.filter((m) => !inTeam.has(m.userId)).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}
