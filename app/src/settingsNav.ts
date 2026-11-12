import type { Role } from './quorum';

// Settings has two navs in one sidebar: the account pages, and behind the Admin button the workspace pages. Which nav
// shows follows from the current page, so the one remembered page (useSession) also remembers the nav.
export type NavMode = 'account' | 'admin';
export type AccountPage = 'preferences' | 'memory' | 'calendar' | 'meetings' | 'connectors' | 'notifications' | 'voice' | 'developers' | 'guardrails';
export type WorkspacePage = 'general' | 'teams' | 'billing' | 'knowledge' | 'members' | 'org-connectors' | 'org-voice' | 'org-guardrails';
export type Page = AccountPage | WorkspacePage;

export const ACCOUNT_PAGES: readonly AccountPage[] = ['preferences', 'memory', 'calendar', 'meetings', 'connectors', 'notifications', 'voice', 'developers', 'guardrails'];
export const WORKSPACE_PAGES: readonly WorkspacePage[] = ['general', 'teams', 'billing', 'knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails'];
// the pages that exist only once a team is enabled on the workspace (migration 0019)
export const TEAM_PAGES: readonly WorkspacePage[] = ['knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails'];

// who sees the Admin button: everyone in the Local edition; in Cloud, owners and admins, and anyone without a workspace
// yet, since the General page holds the sign-in card. A member sees no Admin button. The platform owner's tools live in
// the admin web app, not here
export const canAdmin = (edition: 'local' | 'cloud', role: Role | null | undefined): boolean => edition === 'local' || role !== 'member';

// the workspace pages a build lists. The Local edition has no workspace: General alone. A Cloud build adds Teams and
// Billing once it reached a hosted account, and the team-level pages only while the workspace has a team enabled
export const workspacePages = (edition: 'local' | 'cloud', hosted: boolean | null, teamEnabled = false): WorkspacePage[] =>
  WORKSPACE_PAGES.filter((p) => {
    if (p === 'general') return true;
    if (edition !== 'cloud' || hosted !== true) return false;
    if (p === 'teams' || p === 'billing') return true;
    return teamEnabled;
  });

export const modeOf = (page: string): NavMode => ((WORKSPACE_PAGES as readonly string[]).includes(page) ? 'admin' : 'account');

// a remembered or requested page has to fit the nav allowed to show it; Profile folded into Preferences some time ago,
// and the Platform page moved to the admin web app. A workspace page the build no longer lists lands on General
export function resolvePage(page: string, admin: boolean, listed?: readonly WorkspacePage[]): Page {
  if (page === 'profile') return 'preferences';
  if (page === 'sources') return 'connectors';
  if (!(ACCOUNT_PAGES as readonly string[]).includes(page) && !(WORKSPACE_PAGES as readonly string[]).includes(page)) return 'preferences';
  if (!admin && modeOf(page) === 'admin') return 'preferences';
  if (listed && modeOf(page) === 'admin' && !(listed as readonly string[]).includes(page)) return 'general';
  return page as Page;
}
