// Workspace connectors (migration 0030): the approval filter members' Connections page applies, the admin form's
// checks, and the IPC handlers' calls into the database.
import { describe, expect, it } from 'vitest';
import { CONNECTOR_BY_ID, connectorsFor } from '../connectors/library.js';
import { BLOCKED_SENTENCE, approvalOf, isGoverned, policyOf, workspaceEligible, workspaceStateOf } from '../connectors/approval.js';
import { ELIGIBLE_IDS, checkScope, cleanIntegrationDraft } from '../ee/integrationDraft.js';
import { createIntegrations, integrationRow, policyRow } from '../ee/integrations.js';

const cloudCopy = connectorsFor({ meetingCapture: false });
const byId = Object.fromEntries(cloudCopy.map((x) => [x.id, x]));

describe('which connectors the switch governs', () => {
  it('governs outside accounts and leaves what runs on this Mac alone', () => {
    for (const id of ['google-drive', 'notion', 'slack', 'github', 'google-calendar', 'granola']) expect(isGoverned(CONNECTOR_BY_ID[id])).toBe(true);
    for (const id of ['apple-calendar', 'claude-code']) expect(isGoverned(CONNECTOR_BY_ID[id])).toBe(false);
    // listening to Zoom on this Mac is local; Zoom's cloud import reaches an account
    expect(isGoverned(CONNECTOR_BY_ID.zoom)).toBe(false);
    expect(isGoverned(byId.zoom)).toBe(true);
  });
  it('never governs a connector that is not built yet', () => {
    expect(isGoverned(CONNECTOR_BY_ID.linear)).toBe(false);
    expect(workspaceEligible(cloudCopy).every((x) => x.status === 'available')).toBe(true);
  });
  it('lists the same connectors for the admin form and the filter', () => {
    expect(ELIGIBLE_IDS).toEqual(workspaceEligible(cloudCopy).map((x) => x.id));
    expect(ELIGIBLE_IDS).toContain('zoom');
  });
});

describe('the approval filter', () => {
  const policy = policyOf({ approvedOnly: true, enabled: [{ id: 'I1', provider: 'google-drive', mode: 'personal' }] });
  it('reads no policy when the switch is off, on a solo workspace or in the local edition', () => {
    expect(policyOf(null)).toBeNull();
    expect(policyOf({ approvedOnly: false, enabled: [{ provider: 'notion' }] })).toBeNull();
    expect(policyOf({ teamEnabled: false, approvedOnly: false })).toBeNull();
    expect(policy).toEqual({ approvedOnly: true, enabled: ['google-drive'] });
  });
  it('leaves the full library open without a policy', () => {
    for (const x of cloudCopy) expect(approvalOf(x, null, false)).toBe('open');
  });
  it('shows approved connectors, hides the rest, and keeps what a member already connected', () => {
    expect(approvalOf(CONNECTOR_BY_ID['google-drive'], policy, false)).toBe('approved');
    expect(approvalOf(CONNECTOR_BY_ID.notion, policy, false)).toBe('blocked');
    expect(approvalOf(CONNECTOR_BY_ID.notion, policy, true)).toBe('unapproved');
    expect(approvalOf(CONNECTOR_BY_ID.granola, policy, true)).toBe('unapproved');
  });
  it('never blocks the Calendar app permission or Claude Code', () => {
    expect(approvalOf(CONNECTOR_BY_ID['apple-calendar'], policy, false)).toBe('open');
    expect(approvalOf(CONNECTOR_BY_ID['claude-code'], policy, false)).toBe('open');
  });
  it('says why Connect is blocked in one plain sentence', () => {
    expect(BLOCKED_SENTENCE).toMatch(/^Your workspace allows only connectors an admin approved\./);
    expect(BLOCKED_SENTENCE).not.toMatch(/\u2014/);
  });
  it('reads a connector\'s workspace state from the rows', () => {
    const rows = [{ provider: 'notion', enabled: true, mode: 'org' }, { provider: 'slack', enabled: false, mode: 'personal' }];
    expect(workspaceStateOf('notion', rows).state).toBe('org');
    expect(workspaceStateOf('slack', rows).state).toBe('off');
    expect(workspaceStateOf('slack', rows).row).toBe(rows[1]);
    expect(workspaceStateOf('github', rows)).toEqual({ state: 'off', row: null });
  });
});

describe('the connector form checks', () => {
  const org = (over = {}) => ({ provider: 'notion', mode: 'org', secret: 'secret_12345678', config: { auth: 'api_key' }, ...over });
  it('accepts an org connector with a key, and keeps only the known config', () => {
    const r = cleanIntegrationDraft(org({ config: { auth: 'api_key', ownerId: 'u1', customScopes: true, scopes: ['read', 'read', ' ', 'write'], mock: false, junk: 1 } }));
    expect(r).toEqual({ provider: 'notion', mode: 'org', secret: 'secret_12345678', enabled: null, config: { scopes: ['read', 'write'], custom_scopes: true, mock: false, auth: 'api_key', owner_id: 'u1' } });
  });
  it('refuses a connector outside the library or not built yet', () => {
    expect(cleanIntegrationDraft(org({ provider: 'linear' })).error).toMatch(/cannot be enabled/);
    expect(cleanIntegrationDraft(org({ provider: 'apple-calendar' })).error).toMatch(/cannot be enabled/);
  });
  it('asks for an identity mode', () => {
    expect(cleanIntegrationDraft(org({ mode: 'shared' })).error).toMatch(/org or personal/);
  });
  it('needs a secret for a new org connector unless mock mode is on', () => {
    expect(cleanIntegrationDraft(org({ secret: '' })).error).toMatch(/Paste the API key/);
    expect(cleanIntegrationDraft(org({ secret: '', config: { auth: 'oauth_client', clientId: 'abc' } })).error).toMatch(/client secret/);
    expect(cleanIntegrationDraft(org({ secret: '', config: { mock: true } })).secret).toBeNull();
  });
  it('keeps a stored secret when the field is left blank', () => {
    const r = cleanIntegrationDraft(org({ secret: '' }), { mode: 'org', secretSet: true });
    expect(r.error).toBeUndefined();
    expect(r.secret).toBeNull();
  });
  it('refuses a short secret, an OAuth client without its id, and a personal secret', () => {
    expect(cleanIntegrationDraft(org({ secret: 'short' })).error).toMatch(/whole API key/);
    expect(cleanIntegrationDraft(org({ config: { auth: 'oauth_client' } })).error).toMatch(/client id/);
    expect(cleanIntegrationDraft({ provider: 'slack', mode: 'personal', secret: 'secret_12345678', config: {} }).error).toMatch(/no shared secret/);
  });
  it('drops org-only settings from a personal connector', () => {
    const r = cleanIntegrationDraft({ provider: 'slack', mode: 'personal', config: { mock: true, auth: 'oauth_client', clientId: 'abc' } });
    expect(r.config).toEqual({ scopes: [], custom_scopes: false, mock: false, auth: 'api_key' });
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
function fakeAccount({ signedIn = true, answers = {} } = {}) {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push([name, args]); const a = answers[name]; return typeof a === 'function' ? a(args) : a ?? { data: null, error: null }; } };
  return { calls, account: { client: () => client, state: () => ({ signedIn, workspace: signedIn ? { id: 'WS1' } : null }) } };
}
const adminRow = { id: 'I1', workspace_id: 'WS1', provider: 'notion', mode: 'org', enabled: true, config: { scopes: ['read'], custom_scopes: true, owner_id: 'u1', mock: false, auth: 'api_key' }, secret_set: true, secret_last4: '1234', connections: 1, created_by: 'u1', created_at: 't', updated_at: 't' };

describe('the IPC handlers', () => {
  it('maps the admin row without any secret value', () => {
    const r = integrationRow({ ...adminRow, secret_id: 'should-not-pass' });
    expect(r).toMatchObject({ provider: 'notion', mode: 'org', secretSet: true, secretLast4: '1234', connections: 1, config: { ownerId: 'u1', customScopes: true, scopes: ['read'] } });
    expect(JSON.stringify(r)).not.toMatch(/should-not-pass/);
  });
  it('reads the policy as off unless the team and the switch are both on', () => {
    expect(policyRow({ team_enabled: false, approved_connectors_only: true, approved_only: false, enabled: [] }).approvedOnly).toBe(false);
    expect(policyRow({ team_enabled: true, approved_connectors_only: true, approved_only: true, enabled: [{ id: 'I1', provider: 'notion', mode: 'org' }] })).toEqual({ teamEnabled: true, approvedConnectorsOnly: true, approvedOnly: true, enabled: [{ id: 'I1', provider: 'notion', mode: 'org' }] });
  });
  it('checks a draft before it calls the save RPC, against the stored row', async () => {
    const { calls, account } = fakeAccount({ answers: { workspace_integrations_admin: { data: [adminRow], error: null }, workspace_integration_save: { data: adminRow, error: null } } });
    const { handlers } = createIntegrations({ account });
    // the stored secret lets an edit leave the field blank
    const ok = await handlers['integration-save']({ provider: 'notion', mode: 'org', secret: '', config: { auth: 'api_key' } });
    expect(ok.integration.secretSet).toBe(true);
    expect(calls.at(-1)).toEqual(['workspace_integration_save', { workspace_id: 'WS1', provider: 'notion', mode: 'org', config: { scopes: [], custom_scopes: false, mock: false, auth: 'api_key' }, secret: null, enabled: null }]);
    const bad = await handlers['integration-save']({ provider: 'slack', mode: 'org', secret: '', config: {} });
    expect(bad.error).toMatch(/Paste the API key/);
    expect(calls.filter(([n]) => n === 'workspace_integration_save')).toHaveLength(1);
  });
  it('reports no policy when signed out, and on a database error', async () => {
    expect(await createIntegrations(fakeAccount({ signedIn: false })).handlers['connector-policy']()).toEqual({ policy: null });
    const failing = fakeAccount({ answers: { workspace_connector_policy: { data: null, error: { message: 'boom' } } } });
    expect(await createIntegrations(failing).handlers['connector-policy']()).toEqual({ policy: null });
  });
  it('sends only well-formed connector ids to member_integrations_sync', async () => {
    const { calls, account } = fakeAccount();
    await createIntegrations({ account }).handlers['member-integrations-sync'](['google-drive', 'Bad Id', 'notion', 7]);
    expect(calls).toEqual([['member_integrations_sync', { workspace_id: 'WS1', connected: ['google-drive', 'notion', '7'] }]]);
  });
});
