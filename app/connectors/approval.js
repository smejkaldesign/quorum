// Workspace approval of connectors (docs/specs/workspace-knowledge.md, "Two connector modes"; migration 0030). A team
// admin can switch on "Members may only use approved connectors". With it on, a member's Connections page lists only
// the connectors the workspace enabled, plus anything the member already connected, which shows as not approved with
// Disconnect. A connector the workspace runs in org mode has one shared identity, so members get no personal Connect
// for it. Shared by the renderer (Settings > Connections, Admin > Workspace > Connectors), the main process's connect
// guard (connectors/connectGuard.js) and the tests.
//
// The switch governs connectors that reach an outside account: the personal OAuth connectors, meeting-notes sources
// over MCP, and a meeting app's cloud import. What runs on this Mac alone is never governed: the Calendar app
// permission, the quorum MCP server in a coding tool, and listening to calls on this Mac.
import { CONNECTORS, connectorsFor } from './library.js';

// the meeting apps with a cloud import built (Zoom today), whichever copy of the library the caller holds
const CLOUD_IMPORTS = new Set(connectorsFor({ meetingCapture: false }).filter((x) => x.kind === 'meeting-app' && x.status === 'available').map((x) => x.id));

export function isGoverned(x) {
  if (!x) return false;
  if (x.kind === 'meeting-app') return CLOUD_IMPORTS.has(x.id);
  if (x.status !== 'available') return false;
  return x.kind === 'oauth' || x.kind === 'mcp-source';
}

// a meeting app's row also listens on this Mac when meeting capture is on; that part is never governed, so the row
// stays listed and only its cloud import is refused
export const hasLocalPart = (x) => x?.kind === 'meeting-app' && x.listen !== false;

// the connectors an admin can enable for the workspace, in library order: one list for the admin page, the form checks
// and the member filter
export const ELIGIBLE_IDS = CONNECTORS.filter(isGoverned).map((x) => x.id);

// the policy as the main process reports it (ee/integrations.js policyRow). null in the local edition, before it
// loads, and on a workspace without a team, so the page shows the full library. org lists the connectors the workspace
// runs with a shared identity, which apply whether or not the switch is on.
export function policyOf(raw) {
  if (!raw || typeof raw !== 'object' || raw.teamEnabled !== true) return null;
  const rows = Array.isArray(raw.enabled) ? raw.enabled.filter((e) => e && typeof e.provider === 'string') : [];
  const enabled = rows.map((e) => e.provider);
  const org = rows.filter((e) => e.mode === 'org').map((e) => e.provider);
  const approvedOnly = raw.approvedOnly === true;
  if (!approvedOnly && !org.length) return null;
  return { approvedOnly, enabled, org };
}

// what a member's Connections page does with one connector:
//   open        no policy applies; the page behaves as it always has
//   org         the workspace runs it with a shared identity: shown as connected for the workspace, no personal Connect
//   approved    the workspace enabled it for each member's own account
//   unapproved  the workspace did not enable it and the member already connected it: shown with Disconnect
//   blocked     not enabled and not connected: hidden from the list, Connect refused on its page and in the main process
export function approvalOf(x, policy, connected) {
  if (!policy || !isGoverned(x)) return 'open';
  if (policy.org.includes(x.id)) return 'org';
  if (!policy.approvedOnly) return 'open';
  if (policy.enabled.includes(x.id)) return 'approved';
  return connected ? 'unapproved' : 'blocked';
}

// whether the member may start a personal connection (or a reconnect) for a connector in this state
export const canConnect = (approval) => approval === 'open' || approval === 'approved';
// whether the Connections list leaves the row out: blocked, unless the row also listens on this Mac
export const hiddenFromList = (x, approval) => approval === 'blocked' && !hasLocalPart(x);

export const BLOCKED_SENTENCE = 'Your workspace allows only connectors an admin approved. Ask an owner or admin to enable this one.';
export const UNAPPROVED_LABEL = 'Not approved by your workspace';
export const ORG_LABEL = 'Connected for your workspace';
export const ORG_SENTENCE = (name) => `Your workspace connects ${name} for everyone with one shared identity, so there is no personal account to connect.`;

// the workspace state of one library connector for the admin list: off, org or personal, and the row
export function workspaceStateOf(id, rows) {
  const r = (rows ?? []).find((x) => x.provider === id);
  if (!r) return { state: 'off', row: null };
  return { state: r.enabled ? r.mode : 'off', row: r };
}

// the renderer event the admin page sends after it changes a connector or the switch, so Connections reloads the policy
export const POLICY_CHANGED = 'quorum:connector-policy-changed';
