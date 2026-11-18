import type { Role } from './quorum';

// Settings has two navs in one sidebar: the core pages about the person's notes, and behind the Admin button the admin
// pages: General, Notifications, AI settings, Guardrails and Connectors for the person, then under a Workspace heading
// the team and workspace pages. Which nav
// shows follows from the current page, so the one remembered page (useSession) also remembers the nav.
export type NavMode = 'account' | 'admin';
export type AccountPage = 'preferences' | 'memory' | 'calendar' | 'meetings' | 'voice';
export type WorkspacePage = 'general' | 'notifications' | 'developers' | 'guardrails' | 'connectors' | 'teams' | 'billing' | 'knowledge' | 'members' | 'org-connectors' | 'org-voice' | 'org-guardrails';
export type Page = AccountPage | WorkspacePage;

export const ACCOUNT_PAGES: readonly AccountPage[] = ['preferences', 'memory', 'calendar', 'meetings', 'voice'];
export const WORKSPACE_PAGES: readonly WorkspacePage[] = ['general', 'notifications', 'developers', 'guardrails', 'connectors', 'teams', 'billing', 'knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails'];
// the admin pages every build lists for everyone, above the Workspace heading: General (sign-in and the workspace
// basics), Notifications, AI settings, Guardrails, and Connectors last
export const TOP_ADMIN_PAGES: readonly WorkspacePage[] = ['general', 'notifications', 'developers', 'guardrails', 'connectors'];
// the pages that exist only once a team is enabled on the workspace (migration 0019)
export const TEAM_PAGES: readonly WorkspacePage[] = ['knowledge', 'members', 'org-connectors', 'org-voice', 'org-guardrails'];

// who sees the Admin button: everyone, since it holds each person's own AI settings, Guardrails and Connectors. A Cloud
// member sees only those pages there; the workspace pages are for owners and admins (workspacePages). The platform
// owner's tools live in the admin web app, not here
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const canAdmin = (_edition: 'local' | 'cloud', _role: Role | null | undefined): boolean => true;

// the admin pages a build lists. The Local edition has no workspace: the top pages alone. A Cloud build adds Teams and
// Billing for owners and admins once it reached a hosted account, and the team-level pages only while the workspace
// has a team enabled. A member gets the top pages alone
export const workspacePages = (edition: 'local' | 'cloud', hosted: boolean | null, teamEnabled = false, role?: Role | null): WorkspacePage[] =>
  WORKSPACE_PAGES.filter((p) => {
    if (TOP_ADMIN_PAGES.includes(p)) return true;
    if (edition !== 'cloud' || hosted !== true || role === 'member') return false;
    return TEAM_PAGES.includes(p) ? teamEnabled : true;
  });

export const modeOf = (page: string): NavMode => ((WORKSPACE_PAGES as readonly string[]).includes(page) ? 'admin' : 'account');

// the account Voice typing page by flag: the whole page with dictation on; with dictation off and listening on, only its
// Language and Dictionary, which meeting transcripts use too, under the name Dictionary; with both off, no page
export type VoiceMode = 'voice' | 'dictionary' | null;
export const voiceMode = (dictation: boolean, manualListen: boolean): VoiceMode => (dictation ? 'voice' : manualListen ? 'dictionary' : null);
// the pages a build's flags take out of the navs; resolvePage sends a remembered one elsewhere. The guardrails flag
// hides only the Guardrails page; the built-in guards run either way
// the workspace's Guardrails page holds only organization and team rules, so it goes with the custom rules flag
export const flagHiddenPages = (mode: VoiceMode, guardrails = true, custom = true): Page[] => [...(mode ? [] : ['voice' as const]), ...(guardrails ? [] : ['guardrails' as const]), ...(guardrails && custom ? [] : ['org-guardrails' as const])];

// a remembered or requested page has to fit the nav allowed to show it; a page the flags hide lands on the first page
// of its own nav (Preferences, or General for an admin page); Profile folded into Preferences some time ago,
// and the Platform page moved to the admin web app. A workspace page the build no longer lists lands on General
export function resolvePage(page: string, admin: boolean, listed?: readonly WorkspacePage[], hidden: readonly Page[] = []): Page {
  if ((hidden as readonly string[]).includes(page)) return admin && modeOf(page) === 'admin' ? 'general' : 'preferences';
  if (page === 'profile') return 'preferences';
  if (page === 'sources') return 'connectors';
  if (!(ACCOUNT_PAGES as readonly string[]).includes(page) && !(WORKSPACE_PAGES as readonly string[]).includes(page)) return 'preferences';
  if (!admin && modeOf(page) === 'admin') return 'preferences';
  if (listed && modeOf(page) === 'admin' && !(listed as readonly string[]).includes(page)) return 'general';
  return page as Page;
}
