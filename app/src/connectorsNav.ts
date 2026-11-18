// One way into Connectors from anywhere in the window. The event reaches App, which opens Settings on the page asked
// for; a connector id opens that connector's detail page. `library` names the group a surface was pointing at, and the
// Connectors page scrolls to it. Surfaces outside Settings (Home, onboarding) and pages inside it use this instead of threading
// callbacks through every component between them and SettingsView.
export type ConnectorsTarget = { connector?: string; library?: string | true };
export type SettingsPageId = 'preferences' | 'memory' | 'connectors' | 'guardrails';
export type OpenSettingsDetail = SettingsPageId | ({ page: SettingsPageId } & ConnectorsTarget);

export function openConnectors(target: ConnectorsTarget = {}) {
  window.dispatchEvent(new CustomEvent<OpenSettingsDetail>('quorum-open-settings', { detail: { page: 'connectors', ...target } }));
}

// The scroll of Settings' content pane when the Connectors view changes. view is 'connectors:list',
// 'connectors:library', 'connectors:detail:<id>' or another page's id. A detail page opens at the top; going back to
// the list or the library returns to where it was. Changes to or from another page are left alone (top: null)
export function connectorsScroll(prev: string, next: string, top: number, saved: Record<string, number>): { top: number | null; saved: Record<string, number> } {
  if (prev === next) return { top: null, saved };
  const keep = { ...saved };
  if (prev === 'connectors:list' || prev === 'connectors:library') keep[prev] = top;
  if (next.startsWith('connectors:detail:')) return { top: 0, saved: keep };
  if (!prev.startsWith('connectors:') || !next.startsWith('connectors:')) return { top: null, saved: {} };
  const back = keep[next] ?? 0;
  delete keep[next];
  return { top: back, saved: keep };
}

// the app was brought forward by a connector link (Back to Quorum after a sign-in); detail is the connector id, and
// its page reads the provider again
export const CONNECTOR_RETURN = 'quorum:connector-return';
// a connector link from the OS opens that connector's page, then tells it to refresh; without an id, the list
export function openConnectorLink(id: string | null) {
  if (!id) { openConnectors(); return; }
  openConnectors({ connector: id });
  window.dispatchEvent(new CustomEvent<string>(CONNECTOR_RETURN, { detail: id }));
}
