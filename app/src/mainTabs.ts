import type { AccountState } from './quorum';

// The top tabs. Home and Memory (the person's own Agent OS: folder tree, link graph, search) are in every build.
// Knowledge, the workspace's shared notes, exists only in the Cloud edition and only once the person is signed in to a
// workspace; the Local edition never lists it.
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
