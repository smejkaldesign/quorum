import type { AccountState, TeamImport, TeamSource } from './quorum';

// The top tabs. Home and Memory (the person's own Agent OS: folder tree, link graph, search) are in every build.
// Knowledge, the workspace's team knowledge, exists only in the Cloud edition and only once the person is signed in to
// a workspace; the Local edition never lists it.
export type MainTab = 'home' | 'memory' | 'knowledge';
export const MAIN_TAB_LABEL: Record<MainTab, string> = { home: 'Home', memory: 'Memory', knowledge: 'Knowledge' };

type AccountLike = Pick<AccountState, 'signedIn' | 'workspace'> | null | undefined;

export const showsKnowledge = (edition: 'local' | 'cloud', account: AccountLike): boolean => edition === 'cloud' && account?.signedIn === true && !!account.workspace;

export const mainTabs = (edition: 'local' | 'cloud', account: AccountLike): MainTab[] => (showsKnowledge(edition, account) ? ['home', 'memory', 'knowledge'] : ['home', 'memory']);

// which remembered tab a build can reopen: Knowledge only in Cloud (the account check happens once it has loaded)
export const keepTab = (edition: 'local' | 'cloud') => (t: string): boolean => t === 'home' || t === 'memory' || (t === 'knowledge' && edition === 'cloud');

// the shared notes a search leaves in: title or path, case-insensitive, every word of the query somewhere
export const matchesQuery = (note: { title: string; rel: string }, query: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${note.title} ${note.rel}`.toLowerCase();
  return words.every((w) => hay.includes(w));
};

// whether the workspace has a team switched on (Settings › Admin › Teams, migration 0019): the flag rides on the
// workspace in every account status, and a status without it means no team yet, so the tab never opens on a guess
export const teamEnabledOf = (account: AccountLike): boolean => account?.workspace?.teamEnabled === true;

// what the Knowledge tab shows, in order: the sign-in card, the plan card, the "enable a team" card, or the knowledge.
// An unknown plan (still loading, or the project did not answer) keeps the gate closed
export type TeamGate = 'account' | 'plan' | 'team' | 'open';
export const teamGate = (account: AccountLike, hasService: boolean | null, teamEnabled: boolean): TeamGate => {
  if (!account?.signedIn || !account.workspace) return 'account';
  if (hasService !== true) return 'plan';
  if (!teamEnabled) return 'team';
  return 'open';
};

// one line for the tab's head and the source card
export const describeSource = (s: (Pick<TeamSource, 'kind' | 'url' | 'path'> & { imported?: TeamImport | null }) | null | undefined): string => {
  if (s?.imported?.kind === 'github') return s.imported.url ? `Imported from ${s.imported.url.replace(/^https?:\/\//, '')}` : 'Imported from GitHub';
  if (s?.imported?.kind === 'zip') return s.imported.name ? `Imported from ${s.imported.name}` : 'Imported from a zip';
  if (!s || s.kind === 'sync') return 'Notes members share through Quorum';
  if (s.kind === 'git') return s.url ? `Repository ${s.url.replace(/^https?:\/\//, '').replace(/\.git$/, '')}` : 'A git repository';
  return s.path ? `Folder ${s.path.replace(/^\/Users\/[^/]+/, '~')}` : 'A folder on each Mac';
};
