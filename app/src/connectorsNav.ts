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
