// Workspace approval of connectors (docs/specs/workspace-knowledge.md, "Two connector modes"; migration 0030). A team
// admin can switch on "Members may only use approved connectors". With it on, a member's Connections page lists only
// the connectors the workspace enabled, plus anything the member already connected, which shows as not approved with
// Disconnect. Shared by the renderer (Settings > Connections, Admin > Workspace > Connectors) and the tests.
//
// The switch governs connectors that reach an outside account: the personal OAuth connectors, meeting-notes sources
// over MCP, and a meeting app's cloud import. What runs on this Mac alone is never governed: the Calendar app
// permission, the quorum MCP server in a coding tool, and listening to calls on this Mac.

export function isGoverned(x) {
  if (!x || x.status !== 'available') return false;
  if (x.kind === 'oauth' || x.kind === 'mcp-source') return true;
  if (x.kind === 'meeting-app') return x.listen === false;
  return false;
}

// the connectors an admin can enable for the workspace, in library order
export const workspaceEligible = (list) => list.filter(isGoverned);

// the policy as the main process reports it, or null in the local edition, on a solo workspace or before it loads
export function policyOf(raw) {
  if (!raw || typeof raw !== 'object' || raw.approvedOnly !== true) return null;
  const enabled = Array.isArray(raw.enabled) ? raw.enabled.map((e) => String(e?.provider ?? e ?? '')).filter(Boolean) : [];
  return { approvedOnly: true, enabled };
}

// what a member's Connections page does with one connector:
//   open        no policy applies; the page behaves as it always has
//   approved    the workspace enabled it
//   unapproved  the workspace did not enable it and the member already connected it: shown with Disconnect only
//   blocked     not enabled and not connected: hidden from the list, Connect refused on its page
export function approvalOf(x, policy, connected) {
  if (!policy || !isGoverned(x)) return 'open';
  if (policy.enabled.includes(x.id)) return 'approved';
  return connected ? 'unapproved' : 'blocked';
}

export const BLOCKED_SENTENCE = 'Your workspace allows only connectors an admin approved. Ask an owner or admin to enable this one.';
export const UNAPPROVED_LABEL = 'Not approved by your workspace';

// the workspace state of one library connector for the admin list: off, org or personal, and whether it is on
export function workspaceStateOf(id, rows) {
  const r = (rows ?? []).find((x) => x.provider === id);
  if (!r) return { state: 'off', row: null };
  return { state: r.enabled ? r.mode : 'off', row: r };
}
