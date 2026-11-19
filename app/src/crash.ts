// a view that fails again within REPEAT_MS of Reload view fails on every draw, so the crash page stops advising a reload
export const REPEAT_MS = 5000;
export const failsEveryTime = (reloadedAt: number | null, errorAt: number) => reloadedAt != null && errorAt >= reloadedAt && errorAt - reloadedAt < REPEAT_MS;

// the one case the app can name: its own files changed underneath an open window (an update, or a rebuild in
// development). React.lazy keeps the failed load, so it fails again on every draw until the window reloads
export const STALE_BUNDLE = /dynamically imported module|Loading chunk|Importing a module script failed/i;

// which crash page to show. A stale bundle stays stale even when it repeats, because a window reload fixes it
// a page that could not reach something it needs over the network: the fix is the connection, and a retry
export const NETWORK = /fetch failed|Failed to fetch|NetworkError|network request failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|could not be reached|did not answer/i;

// which crash page to show. A stale bundle stays stale even when it repeats, because a window reload fixes it; a
// network failure comes next, since a retry can fix it too
export type CrashKind = 'stale' | 'network' | 'repeat' | 'once';
export const crashKind = (message: string, reloadedAt: number | null, errorAt: number): CrashKind =>
  STALE_BUNDLE.test(message) ? 'stale' : NETWORK.test(message) ? 'network' : failsEveryTime(reloadedAt, errorAt) ? 'repeat' : 'once';

// the name a person knows a view by, from the error boundary's view id (main/home, settings/connectors, root)
const PAGES: Record<string, string> = {
  'main/home': 'Home', 'main/memory': 'Memory', 'main/knowledge': 'Knowledge', 'main/chat': 'Chat', 'main/note': 'This note', 'main/live': 'The call view',
  'main/notes': 'Live notes', 'main/mine': 'Your notes', notifications: 'Notifications', popup: 'The mini window', preview: 'The preview', root: 'Quorum',
  'settings/general': 'General settings', 'settings/organization': 'Organization settings', 'settings/teams': 'Teams', 'settings/billing': 'Billing',
  'settings/memory': 'Memory settings', 'settings/members': 'Members', 'settings/org-connectors': 'Workspace connectors', 'settings/org-voice': 'Workspace voice',
  'settings/org-guardrails': 'Workspace guardrails', 'settings/guardrails': 'Guardrails', 'settings/calendar': 'Calendar settings', 'settings/meetings': 'Meeting settings',
  'settings/developers': 'AI tools', 'settings/notifications': 'Notification settings', 'settings/connectors': 'Connectors', 'settings/voice': 'Voice typing',
  'settings/preferences': 'Preferences',
};
export function pageName(view: string): string {
  if (PAGES[view]) return PAGES[view];
  if (view.startsWith('lazy/')) return view.slice(5).replace(/^./, (c) => c.toUpperCase());
  const last = view.split('/').pop() ?? '';
  return last ? last.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'This page';
}

// the crash page's words: the title names the page and what happened, the body what to do, the button the one step
// that can help. reports: whether error reports are on (Settings, General)
export function crashCopy(view: string, kind: CrashKind, { whole = false, reports = true } = {}) {
  const page = pageName(view);
  const sent = reports ? 'Quorum sent a report of this error so it can be fixed.' : 'Error reports are off, so this error was not sent.';
  const away = whole ? '' : ' Go to another page, or';
  if (kind === 'stale') return { title: `Reload to open ${page.replace(/^The /, 'the ')}`, body: "Quorum's files changed while this window was open, so part of the page could not load. Reloading picks up the new version.", action: 'Reload Quorum', window: true };
  if (kind === 'network') return { title: `${page} couldn't connect`, body: 'A connection Quorum needed for this page failed. Check your internet connection, then try again.', action: whole ? 'Reload Quorum' : 'Try again', window: whole };
  if (kind === 'repeat') return { title: `${page} won't open`, body: `It failed again right after reloading, so this is a bug in Quorum. ${sent}${away ? `${away} reload Quorum to try once more.` : ' Reload Quorum to try once more.'}`, action: 'Reload Quorum', window: true };
  return { title: `${page} couldn't open`, body: `Part of this page failed while it was drawing. ${sent} Reloading draws it again from the start.`, action: whole ? 'Reload Quorum' : 'Reload view', window: whole };
}
