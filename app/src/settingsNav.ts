import type { Role } from './quorum';

// Settings has two navs in one sidebar: the account pages, and behind the Admin button the workspace pages. Which nav
// shows follows from the current page, so the one remembered page (useSession) also remembers the nav.
export type NavMode = 'account' | 'admin';
export type AccountPage = 'preferences' | 'memory' | 'calendar' | 'meetings' | 'notifications' | 'connectors' | 'voice';
export type WorkspacePage = 'general' | 'knowledge' | 'members' | 'org-connectors' | 'org-voice';
export type Page = AccountPage | WorkspacePage;

export const ACCOUNT_PAGES: readonly AccountPage[] = ['preferences', 'memory', 'calendar', 'meetings', 'notifications', 'connectors', 'voice'];
export const WORKSPACE_PAGES: readonly WorkspacePage[] = ['general', 'knowledge', 'members', 'org-connectors', 'org-voice'];

// who sees the Admin button: everyone in the Local edition; in Cloud, owners and admins, and anyone without a workspace
// yet, since the General page holds the sign-in card. A member sees no Admin button
export const canAdmin = (edition: 'local' | 'cloud', role: Role | null | undefined): boolean => edition === 'local' || role !== 'member';

// the workspace pages a build lists; Members needs a hosted workspace to list anyone
export const workspacePages = (edition: 'local' | 'cloud', hosted: boolean | null): WorkspacePage[] =>
  WORKSPACE_PAGES.filter((p) => p !== 'members' || (edition === 'cloud' && hosted === true));

export const modeOf = (page: string): NavMode => ((WORKSPACE_PAGES as readonly string[]).includes(page) ? 'admin' : 'account');

// a remembered or requested page has to fit the nav allowed to show it; Profile folded into Preferences some time ago
export function resolvePage(page: string, admin: boolean): Page {
  if (page === 'profile') return 'preferences';
  if (!(ACCOUNT_PAGES as readonly string[]).includes(page) && !(WORKSPACE_PAGES as readonly string[]).includes(page)) return 'preferences';
  if (!admin && modeOf(page) === 'admin') return 'preferences';
  return page as Page;
}
