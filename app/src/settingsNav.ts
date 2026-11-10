import type { Role } from './quorum';

// Settings has two navs in one sidebar: the account pages, and behind the Admin button the workspace pages. Which nav
// shows follows from the current page, so the one remembered page (useSession) also remembers the nav.
export type NavMode = 'account' | 'admin';
export type AccountPage = 'preferences' | 'memory' | 'calendar' | 'meetings' | 'sources' | 'notifications' | 'connectors' | 'voice';
export type WorkspacePage = 'general' | 'knowledge' | 'members' | 'org-connectors' | 'org-voice' | 'platform';
export type Page = AccountPage | WorkspacePage;

export const ACCOUNT_PAGES: readonly AccountPage[] = ['preferences', 'memory', 'calendar', 'meetings', 'sources', 'notifications', 'connectors', 'voice'];
export const WORKSPACE_PAGES: readonly WorkspacePage[] = ['general', 'knowledge', 'members', 'org-connectors', 'org-voice', 'platform'];

// who sees the Admin button: everyone in the Local edition; in Cloud, owners and admins, anyone without a workspace
// yet, since the General page holds the sign-in card, and the platform owner whatever their workspace role. A member
// sees no Admin button
export const canAdmin = (edition: 'local' | 'cloud', role: Role | null | undefined, platformOwner = false): boolean => edition === 'local' || role !== 'member' || platformOwner;

// the workspace pages a build lists; Members needs a hosted workspace to list anyone, and Platform (last) is the
// platform owner's page in a hosted Cloud build only
export const workspacePages = (edition: 'local' | 'cloud', hosted: boolean | null, platformOwner = false): WorkspacePage[] =>
  WORKSPACE_PAGES.filter((p) => (p === 'members' ? edition === 'cloud' && hosted === true : p === 'platform' ? edition === 'cloud' && hosted === true && platformOwner : true));

export const modeOf = (page: string): NavMode => ((WORKSPACE_PAGES as readonly string[]).includes(page) ? 'admin' : 'account');

// a remembered or requested page has to fit the nav allowed to show it; Profile folded into Preferences some time ago
export function resolvePage(page: string, admin: boolean, platformOwner = false): Page {
  if (page === 'profile') return 'preferences';
  if (!(ACCOUNT_PAGES as readonly string[]).includes(page) && !(WORKSPACE_PAGES as readonly string[]).includes(page)) return 'preferences';
  if (!admin && modeOf(page) === 'admin') return 'preferences';
  if (page === 'platform' && !platformOwner) return 'preferences';
  return page as Page;
}
