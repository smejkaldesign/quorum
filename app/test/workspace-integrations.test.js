// Workspace connectors (migration 0030): the approval filter members' Connections page applies, the main process's
// connect guard, the admin form's checks, and the IPC handlers' calls into the database.
import { describe, expect, it } from 'vitest';
import { CONNECTORS, CONNECTOR_BY_ID, connectorsFor } from '../connectors/library.js';
import { BLOCKED_SENTENCE, ELIGIBLE_IDS, ORG_SENTENCE, approvalOf, canConnect, hiddenFromList, isGoverned, policyOf, workspaceStateOf } from '../connectors/approval.js';
import { CONNECT_CHANNELS, createConnectGuard, guardIpc } from '../connectors/connectGuard.js';
import { ELIGIBLE_IDS as FORM_IDS, checkScope, cleanIntegrationDraft, keepsSecret } from '../ee/integrationDraft.js';
import { createIntegrations, integrationRow, policyRow } from '../ee/integrations.js';
import { createReporter } from '../src/connectorReport.ts';

const captureOff = connectorsFor({ meetingCapture: false });
const captureOn = connectorsFor({ meetingCapture: true });
const offById = Object.fromEntries(captureOff.map((x) => [x.id, x]));
const team = (enabled, approvedOnly = true) => policyOf({ teamEnabled: true, approvedOnly, enabled });

describe('which connectors the switch governs', () => {
  it('governs outside accounts and leaves what runs on this Mac alone', () => {
    for (const id of ['google-drive', 'notion', 'slack', 'github', 'google-calendar', 'granola']) expect(isGoverned(CONNECTOR_BY_ID[id])).toBe(true);
    for (const id of ['apple-calendar', 'claude-code', 'google-meet', 'teams']) expect(isGoverned(CONNECTOR_BY_ID[id])).toBe(false);
  });
  it('governs Zoom\'s cloud import with meeting capture on or off', () => {
    expect(isGoverned(captureOn.find((x) => x.id === 'zoom'))).toBe(true);
    expect(isGoverned(offById.zoom)).toBe(true);
  });
  it('never governs a connector that is not built yet', () => {
    expect(isGoverned(CONNECTOR_BY_ID.linear)).toBe(false);
  });
  it('uses one list for admin eligibility, the form and the member filter, whatever the capture flag', () => {
    expect(FORM_IDS).toBe(ELIGIBLE_IDS);
    expect(captureOn.filter(isGoverned).map((x) => x.id)).toEqual([...ELIGIBLE_IDS]);
    expect(captureOff.filter(isGoverned).map((x) => x.id)).toEqual([...ELIGIBLE_IDS]);
    expect(CONNECTORS.filter(isGoverned).map((x) => x.id)).toEqual([...ELIGIBLE_IDS]);
    expect(ELIGIBLE_IDS).toContain('zoom');
  });
});

describe('the approval filter', () => {
  const policy = team([{ id: 'I1', provider: 'google-drive', mode: 'personal' }, { id: 'I2', provider: 'slack', mode: 'org' }]);
  it('reads no policy in the local edition, on a solo workspace, or with the switch off and no org connector', () => {
    expect(policyOf(null)).toBeNull();
    expect(policyOf({ teamEnabled: false, approvedOnly: true, enabled: [{ provider: 'notion', mode: 'personal' }] })).toBeNull();
    expect(team([{ provider: 'notion', mode: 'personal' }], false)).toBeNull();
    expect(policy).toEqual({ approvedOnly: true, enabled: ['google-drive', 'slack'], org: ['slack'] });
  });
  it('leaves the full library open without a policy', () => {
    for (const x of captureOff) expect(approvalOf(x, null, false)).toBe('open');
  });
  it('shows approved connectors, hides the rest, and keeps what a member already connected', () => {
    expect(approvalOf(CONNECTOR_BY_ID['google-drive'], policy, false)).toBe('approved');
    expect(approvalOf(CONNECTOR_BY_ID.notion, policy, false)).toBe('blocked');
    expect(approvalOf(CONNECTOR_BY_ID.notion, policy, true)).toBe('unapproved');
    expect(approvalOf(CONNECTOR_BY_ID.granola, policy, true)).toBe('unapproved');
  });
  it('gives an org connector no personal Connect, with the switch on or off', () => {
    expect(approvalOf(CONNECTOR_BY_ID.slack, policy, false)).toBe('org');
    expect(approvalOf(CONNECTOR_BY_ID.slack, team([{ provider: 'slack', mode: 'org' }], false), false)).toBe('org');
    expect(approvalOf(CONNECTOR_BY_ID.notion, team([{ provider: 'slack', mode: 'org' }], false), false)).toBe('open');
    expect(canConnect('org')).toBe(false);
    expect(canConnect('blocked')).toBe(false);
    expect(canConnect('unapproved')).toBe(false);
    expect(canConnect('approved')).toBe(true);
    expect(canConnect('open')).toBe(true);
  });
  it('never blocks the Calendar app permission or Claude Code', () => {
    expect(approvalOf(CONNECTOR_BY_ID['apple-calendar'], policy, false)).toBe('open');
    expect(approvalOf(CONNECTOR_BY_ID['claude-code'], policy, false)).toBe('open');
  });
  it('keeps a listening Zoom row in the list while its cloud import is blocked', () => {
    const zoomOn = captureOn.find((x) => x.id === 'zoom');
    expect(approvalOf(zoomOn, policy, false)).toBe('blocked');
    expect(hiddenFromList(zoomOn, 'blocked')).toBe(false);
    expect(hiddenFromList(offById.zoom, 'blocked')).toBe(true);
    expect(hiddenFromList(CONNECTOR_BY_ID.notion, 'blocked')).toBe(true);
  });
  it('says why Connect is refused in one plain sentence', () => {
    expect(BLOCKED_SENTENCE).toMatch(/^Your workspace allows only connectors an admin approved\./);
    expect(ORG_SENTENCE('Slack')).toMatch(/^Your workspace connects Slack for everyone/);
    expect(BLOCKED_SENTENCE + ORG_SENTENCE('x')).not.toMatch(/\u2014/);
  });
  it('reads a connector\'s workspace state from the rows', () => {
    const rows = [{ provider: 'notion', enabled: true, mode: 'org' }, { provider: 'slack', enabled: false, mode: 'personal' }];
    expect(workspaceStateOf('notion', rows).state).toBe('org');
    expect(workspaceStateOf('slack', rows).state).toBe('off');
    expect(workspaceStateOf('slack', rows).row).toBe(rows[1]);
    expect(workspaceStateOf('github', rows)).toEqual({ state: 'off', row: null });
  });
});

describe('the connect guard in the main process', () => {
  const policy = team([{ provider: 'google-drive', mode: 'personal' }, { provider: 'slack', mode: 'org' }]);
  const guard = createConnectGuard();
  guard.setPolicy(async () => policy);
  it('covers every connect channel', () => {
    expect([...CONNECT_CHANNELS].sort()).toEqual(['oauth-connect', 'platform-connect', 'source-connect']);
  });
  it('refuses a blocked connector on every channel, Onboarding\'s Granola connect included', async () => {
    expect(await guard.refusal('oauth-connect', 'notion')).toBe(BLOCKED_SENTENCE);
    expect(await guard.refusal('source-connect', 'granola')).toBe(BLOCKED_SENTENCE);
    expect(await guard.refusal('platform-connect', 'zoom')).toBe(BLOCKED_SENTENCE);
  });
  it('refuses a personal connect to an org connector, and lets approved and ungoverned ones through', async () => {
    expect(await guard.refusal('oauth-connect', 'slack')).toBe(ORG_SENTENCE('Slack'));
    expect(await guard.refusal('oauth-connect', 'google-drive')).toBeNull();
    expect(await guard.refusal('calendar-connect', 'anything')).toBeNull();
  });
  it('lets everything through with no policy, and when the policy read throws', async () => {
    const open = createConnectGuard();
    expect(await open.refusal('oauth-connect', 'notion')).toBeNull();
    open.setPolicy(async () => { throw new Error('offline'); });
    expect(await open.refusal('oauth-connect', 'notion')).toBeNull();
  });
  it('wraps only the connect channels of ipcMain', async () => {
    const registered = {};
    const ipc = guardIpc({ handle: (name, fn) => { registered[name] = fn; } }, guard);
    let ran = 0;
    ipc.handle('oauth-connect', () => { ran += 1; return { connected: true }; });
    ipc.handle('oauth-disconnect', () => { ran += 1; return { ok: true }; });
    expect(await registered['oauth-connect']({}, 'notion')).toEqual({ error: BLOCKED_SENTENCE });
    expect(ran).toBe(0);
    expect(await registered['oauth-connect']({}, 'google-drive')).toEqual({ connected: true });
    expect(await registered['oauth-disconnect']({}, 'notion')).toEqual({ ok: true });
    expect(ran).toBe(2);
  });
});

describe('the connector form checks', () => {
  const org = (over = {}) => ({ provider: 'notion', mode: 'org', secret: 'secret_12345678', config: { auth: 'api_key' }, ...over });
  it('accepts an org connector with a key, and keeps only the known config', () => {
    const r = cleanIntegrationDraft(org({ config: { auth: 'api_key', ownerId: 'u1', customScopes: true, scopes: ['read', 'read', ' ', 'write'], mock: true, junk: 1 } }));
    expect(r).toEqual({ provider: 'notion', mode: 'org', secret: 'secret_12345678', enabled: null, config: { scopes: ['read', 'write'], custom_scopes: true, auth: 'api_key', owner_id: 'u1' } });
  });
  it('refuses a connector outside the library or not built yet', () => {
    expect(cleanIntegrationDraft(org({ provider: 'linear' })).error).toMatch(/cannot be enabled/);
    expect(cleanIntegrationDraft(org({ provider: 'apple-calendar' })).error).toMatch(/cannot be enabled/);
  });
  it('asks for an identity mode', () => {
    expect(cleanIntegrationDraft(org({ mode: 'shared' })).error).toMatch(/org or personal/);
  });
  it('needs a secret for a new org connector; mock mode is not offered', () => {
    expect(cleanIntegrationDraft(org({ secret: '' })).error).toMatch(/Paste the API key/);
    expect(cleanIntegrationDraft(org({ secret: '', config: { auth: 'oauth_client', clientId: 'abc' } })).error).toMatch(/client secret/);
    expect(cleanIntegrationDraft(org({ secret: '', config: { mock: true } })).error).toMatch(/Paste the API key/);
  });
  it('keeps a stored secret only under the same auth method', () => {
    const stored = { mode: 'org', secretSet: true, config: { auth: 'api_key' } };
    expect(keepsSecret(stored, 'api_key')).toBe(true);
    expect(keepsSecret(stored, 'oauth_client')).toBe(false);
    const r = cleanIntegrationDraft(org({ secret: '' }), stored);
    expect(r.error).toBeUndefined();
    expect(r.secret).toBeNull();
    expect(cleanIntegrationDraft(org({ secret: '', config: { auth: 'oauth_client', clientId: 'abc' } }), stored).error).toMatch(/new auth method/);
  });
  it('refuses a short secret and an OAuth client without its id', () => {
    expect(cleanIntegrationDraft(org({ secret: 'short' })).error).toMatch(/whole API key/);
    expect(cleanIntegrationDraft(org({ config: { auth: 'oauth_client' } })).error).toMatch(/client id/);
  });
  it('never sends a secret or org settings with a personal connector', () => {
    const r = cleanIntegrationDraft({ provider: 'slack', mode: 'personal', secret: 'secret_12345678', config: { auth: 'oauth_client', clientId: 'abc' } });
    expect(r.secret).toBeNull();
    expect(r.config).toEqual({ scopes: [], custom_scopes: false, auth: 'api_key' });
  });
  it('checks scopes and the domain', () => {
    expect(checkScope(' chat:write ')).toEqual({ scope: 'chat:write' });
    expect(checkScope('chat write').error).toMatch(/is not a scope/);
    expect(checkScope('').error).toMatch(/Type a scope/);
    expect(cleanIntegrationDraft(org({ config: { customScopes: true, scopes: ['bad scope'] } })).error).toMatch(/is not a scope/);
    // a scope list with custom scopes off is not sent
    expect(cleanIntegrationDraft(org({ config: { customScopes: false, scopes: ['read'] } })).config.scopes).toEqual([]);
    expect(cleanIntegrationDraft(org({ config: { domain: 'not a domain' } })).error).toMatch(/domain/);
    expect(cleanIntegrationDraft(org({ config: { domain: 'Example.COM' } })).config.domain).toBe('example.com');
  });
});

// a client that records each RPC and answers from a table of canned results
function fakeAccount({ signedIn = true, answers = {}, workspace = 'WS1' } = {}) {
  const calls = [];
  const state = { signedIn, workspace: signedIn ? { id: workspace } : null };
  const client = { rpc: async (name, args) => { calls.push([name, args]); const a = answers[name]; return typeof a === 'function' ? a(args) : a ?? { data: null, error: null }; } };
  return { calls, state, account: { client: () => client, state: () => state } };
}
const adminRow = { id: 'I1', workspace_id: 'WS1', provider: 'notion', mode: 'org', enabled: true, config: { scopes: ['read'], custom_scopes: true, owner_id: 'u1', auth: 'api_key' }, secret_set: true, secret_last4: '1234', connections: 1, created_by: 'u1', created_at: 't', updated_at: 't' };
const policyData = { team_enabled: true, approved_connectors_only: true, approved_only: true, enabled: [{ id: 'I1', provider: 'google-drive', mode: 'personal' }] };

describe('the IPC handlers', () => {
  it('maps the admin row without any secret value', () => {
    const r = integrationRow({ ...adminRow, secret_id: 'should-not-pass' });
    expect(r).toMatchObject({ provider: 'notion', mode: 'org', secretSet: true, secretLast4: '1234', connections: 1, config: { ownerId: 'u1', customScopes: true, scopes: ['read'], auth: 'api_key' } });
    expect(JSON.stringify(r)).not.toMatch(/should-not-pass/);
  });
  it('reads the policy as off unless the team and the switch are both on', () => {
    expect(policyRow({ team_enabled: false, approved_connectors_only: true, approved_only: false, enabled: [] }).approvedOnly).toBe(false);
    expect(policyRow(policyData)).toEqual({ teamEnabled: true, approvedConnectorsOnly: true, approvedOnly: true, enabled: [{ id: 'I1', provider: 'google-drive', mode: 'personal' }] });
  });
  it('checks a draft before it calls the save RPC, against the stored row', async () => {
    const { calls, account } = fakeAccount({ answers: { workspace_integrations_admin: { data: [adminRow], error: null }, workspace_integration_save: { data: adminRow, error: null } } });
    const { handlers } = createIntegrations({ account });
    const ok = await handlers['integration-save']({ provider: 'notion', mode: 'org', secret: '', config: { auth: 'api_key' } });
    expect(ok.integration.secretSet).toBe(true);
    expect(calls.at(-1)).toEqual(['workspace_integration_save', { workspace_id: 'WS1', provider: 'notion', mode: 'org', config: { scopes: [], custom_scopes: false, auth: 'api_key' }, secret: null, enabled: null }]);
    // the stored key does not carry over to a new auth method
    const switched = await handlers['integration-save']({ provider: 'notion', mode: 'org', secret: '', config: { auth: 'oauth_client', clientId: 'abc' } });
    expect(switched.error).toMatch(/new auth method/);
    expect(calls.filter(([n]) => n === 'workspace_integration_save')).toHaveLength(1);
  });
  it('reports no policy when signed out, and the last known one on a failed read', async () => {
    expect(await createIntegrations(fakeAccount({ signedIn: false })).handlers['connector-policy']()).toEqual({ policy: null });
    let fail = false;
    const f = fakeAccount({ answers: { workspace_connector_policy: () => (fail ? { data: null, error: { message: 'offline' } } : { data: policyData, error: null }) } });
    const it = createIntegrations(f);
    expect((await it.handlers['connector-policy']()).policy.approvedOnly).toBe(true);
    fail = true;
    expect((await it.handlers['connector-policy']()).policy.approvedOnly).toBe(true);
    expect(await it.guardPolicy()).toEqual({ approvedOnly: true, enabled: ['google-drive'], org: [] });
    // another workspace has no last known policy
    f.state.workspace = { id: 'WS2' };
    expect((await it.handlers['connector-policy']()).policy).toBeNull();
  });
  it('sends only well-formed connector ids to member_integrations_sync and says whether it landed', async () => {
    const { calls, account } = fakeAccount();
    const r = await createIntegrations({ account }).handlers['member-integrations-sync'](['google-drive', 'Bad Id', 'notion', 7]);
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([['member_integrations_sync', { workspace_id: 'WS1', connected: ['google-drive', 'notion', '7'] }]]);
    const failing = fakeAccount({ answers: { member_integrations_sync: { data: null, error: { message: 'boom' } } } });
    expect(await createIntegrations(failing).handlers['member-integrations-sync'](['notion'])).toEqual({ ok: false });
  });
});

describe('the member connection report', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  it('records a list as sent only after the workspace accepted it, and retries a failure', async () => {
    const sends = [];
    let answer = { ok: false };
    const r = createReporter(async (ids) => { sends.push(ids); return answer; });
    r.report(['notion']); await settle();
    r.flush(); await settle();
    expect(sends).toHaveLength(2);
    answer = { ok: true };
    r.flush(); await settle();
    r.flush(); await settle();
    r.report(['notion']); await settle();
    expect(sends).toHaveLength(3);
  });
  it('treats a thrown send as a failure', async () => {
    let n = 0;
    const r = createReporter(async () => { n += 1; if (n === 1) throw new Error('offline'); return { ok: true }; });
    r.report(['slack']); await settle();
    r.flush(); await settle();
    r.flush(); await settle();
    expect(n).toBe(2);
  });
  it('sends again after a workspace switch, and sends a changed list', async () => {
    const sends = [];
    const r = createReporter(async (ids) => { sends.push(ids); return { ok: true }; });
    r.report(['notion']); await settle();
    r.reset(); await settle();
    r.report(['notion', 'slack']); await settle();
    expect(sends).toEqual([['notion'], ['notion'], ['notion', 'slack']]);
  });
});
