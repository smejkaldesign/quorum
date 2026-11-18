import { afterEach, describe, expect, it } from 'vitest';
import { appScheme, connectorLink, connectorRoute, parseConnectorLink, setLinkScheme } from '../connectors/appLink.js';
import { CHECKABLE, installSummary } from '../connectors/oauthApps.js';
import { IDENTITY, createAccounts, tokenKey } from '../sources/accounts.js';
import { doneText, loopbackPage } from '../sources/oauth.js';

const TOKEN = 'tok-secret-123';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const store = (seed = {}) => { const m = new Map(Object.entries(seed)); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { if (v === null) m.delete(k); else m.set(k, v); return true; } }; };
// a fetch that answers by URL and records each request
const stub = (answer) => { const calls = []; const f = async (url, init = {}) => { calls.push({ url: String(url), init }); return answer(String(url), init); }; f.calls = calls; return f; };
const accountsWith = (id, fetchImpl, { tokens = { accessToken: TOKEN }, logs = [], relayFetch } = {}) => createAccounts({
  tokens: store(tokens ? { [tokenKey(id)]: tokens } : {}), clients: { google: { clientId: 'gid', clientSecret: 'gsec' }, github: { clientId: 'hid', slug: 'quorum-app' }, notion: { clientId: 'n' }, slack: { clientId: 's' } },
  relayBase: 'https://relay.example.com', relayFetch, open: async () => {}, fetchImpl, log: (...a) => logs.push(a.join(' ')),
  state: (x) => (x === id ? { connected: true, account: 'stored-label' } : null), save: () => {},
});

describe('Check connection', () => {
  it('Notion calls users/me with its version header and names the workspace', async () => {
    const f = stub(() => json({ object: 'user', type: 'bot', bot: { workspace_name: 'Acme HQ', owner: { type: 'user', user: { name: 'Eric' } } } }));
    const r = await accountsWith('notion', f).check('notion');
    expect(r).toMatchObject({ ok: true, account: 'Acme HQ' });
    expect(f.calls[0].url).toBe('https://api.notion.com/v1/users/me');
    expect(f.calls[0].init.headers['notion-version']).toBe('2022-06-28');
    expect(f.calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('Slack posts auth.test and reads user and team; a revoked token asks for a reconnect', async () => {
    const ok = await accountsWith('slack', stub(() => json({ ok: true, user: 'eric', team: 'Smejkal Design' }))).check('slack');
    expect(ok).toMatchObject({ ok: true, account: 'eric in Smejkal Design' });
    const f = stub(() => json({ ok: false, error: 'token_revoked' }));
    const bad = await accountsWith('slack', f).check('slack');
    expect(f.calls[0]).toMatchObject({ url: 'https://slack.com/api/auth.test', init: { method: 'POST' } });
    expect(bad).toMatchObject({ ok: false, reconnect: true });
    expect(bad.error).toMatch(/Reconnect Slack/);
  });
  it('GitHub reads /user; a 401 asks for a reconnect, a network failure does not', async () => {
    expect(await accountsWith('github', stub(() => json({ login: 'smejster' }))).check('github')).toMatchObject({ ok: true, account: 'smejster' });
    expect(await accountsWith('github', stub(() => json({ message: 'Bad credentials' }, 401))).check('github')).toMatchObject({ ok: false, reconnect: true });
    const offline = await accountsWith('github', stub(() => { throw new TypeError('fetch failed'); })).check('github');
    expect(offline).toMatchObject({ ok: false, reconnect: false });
    expect(offline.error).toMatch(/could not reach GitHub/);
  });
  it('refreshes an expiring token through the relay before the identity call', async () => {
    const relayFetch = async () => json({ accessToken: 'fresh-token', refreshToken: 'r2', expiresAt: Date.now() + 3600e3 });
    const f = stub(() => json({ login: 'smejster' }));
    const r = await accountsWith('github', f, { tokens: { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000 }, relayFetch }).check('github');
    expect(r.ok).toBe(true);
    expect(f.calls[0].init.headers.authorization).toBe('Bearer fresh-token');
  });
  it('no token in the Keychain is a reconnect without a network call', async () => {
    const f = stub(() => { throw new Error('no network expected'); });
    expect(await accountsWith('notion', f, { tokens: null }).check('notion')).toMatchObject({ ok: false, reconnect: true });
    expect(f.calls).toHaveLength(0);
  });
  it('never puts the token in a log line or a result', async () => {
    const logs = [];
    const r = await accountsWith('github', stub(() => json({}, 500)), { logs }).check('github');
    expect(JSON.stringify(r) + logs.join('\n')).not.toContain(TOKEN);
  });
  it('Google Calendar has no check; every checkable connector has an identity call', async () => {
    await expect(accountsWith('google-calendar', stub(() => json({}))).check('google-calendar')).rejects.toThrow(/no connection check/);
    expect(Object.keys(IDENTITY).sort()).toEqual([...CHECKABLE].sort());
  });
  it('Google Drive reads userinfo for the email, refreshing an expiring token with Google directly', async () => {
    const f = stub((url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') { expect(String(init.body)).toContain('grant_type=refresh_token'); return json({ access_token: 'g-fresh', expires_in: 3600 }); }
      return json({ sub: '1', email: 'eric@example.com' });
    });
    const relayFetch = async () => { throw new Error('Google never goes through the relay'); };
    const r = await accountsWith('google-drive', f, { tokens: { accessToken: 'g-old', refreshToken: 'g-r', expiresAt: Date.now() + 1000 }, relayFetch }).check('google-drive');
    expect(r).toMatchObject({ ok: true, account: 'eric@example.com' });
    const who = f.calls.find((c) => c.url === 'https://openidconnect.googleapis.com/v1/userinfo');
    expect(who.init.headers.authorization).toBe('Bearer g-fresh');
  });
  it('refuses an id that is not a connector, and a connector this Mac never connected asks for a connect without calling out', async () => {
    const f = stub(() => { throw new Error('no network expected'); });
    await expect(accountsWith('notion', f).check('wispr')).rejects.toThrow(/Unknown connector/);
    const never = await accountsWith('slack', f, { tokens: null }).check('slack');
    expect(never).toMatchObject({ ok: false, reconnect: true });
    expect(never.error).toMatch(/Slack is not connected on this Mac/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('GitHub installations', () => {
  const answer = (installs, counts) => stub((url) => {
    if (url.startsWith('https://api.github.com/user/installations?')) return json({ total_count: installs.length, installations: installs });
    const id = /installations\/(\d+)\/repositories/.exec(url)?.[1];
    return json({ total_count: counts[id], repositories: [] });
  });
  it('none: no summary, so the step stays Choose repositories', async () => {
    const r = await accountsWith('github', answer([], {})).githubInstallations();
    expect(r.installations).toEqual([]);
    expect(installSummary(r)).toBeNull();
  });
  it('one: counts the repositories with per_page=1 and names the owner', async () => {
    const f = answer([{ id: 7, account: { login: 'smejster' }, repository_selection: 'selected' }], { 7: 3 });
    const r = await accountsWith('github', f).githubInstallations();
    expect(f.calls.map((c) => c.url)).toContain('https://api.github.com/user/installations/7/repositories?per_page=1');
    expect(installSummary(r)).toBe('Installed on 3 repositories (smejster)');
  });
  it('many: adds the counts across owners', async () => {
    const f = answer([{ id: 1, account: { login: 'smejster' } }, { id: 2, account: { login: 'smejkaldesign' } }], { 1: 1, 2: 40 });
    expect(installSummary(await accountsWith('github', f).githubInstallations())).toBe('Installed on 41 repositories (smejster, smejkaldesign)');
    expect(installSummary({ installations: [{ owner: 'a', repositories: 1 }] })).toBe('Installed on 1 repository (a)');
  });
  it('an installation with no repositories picked has no summary, so the step stays Choose repositories', async () => {
    const r = await accountsWith('github', answer([{ id: 3, account: { login: 'smejster' }, repository_selection: 'selected' }], { 3: 0 })).githubInstallations();
    expect(r.installations).toHaveLength(1);
    expect(installSummary(r)).toBeNull();
  });
  it('a rate limit keeps the last answer and marks it stale', async () => {
    let limited = false;
    const f = stub((url) => {
      if (limited) return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
      return url.includes('/repositories') ? json({ total_count: 5 }) : json({ installations: [{ id: 9, account: { login: 'smejster' } }] });
    });
    const accounts = accountsWith('github', f);
    await accounts.githubInstallations();
    limited = true;
    const r = await accounts.githubInstallations();
    expect(r.stale).toBe(true);
    expect(r.error).toMatch(/GitHub is limiting requests right now/);
    expect(installSummary(r)).toBe('Installed on 5 repositories (smejster)');
  });
  it('a rate limit before any answer is stale with nothing to show', async () => {
    const r = await accountsWith('github', stub(() => json({}, 429))).githubInstallations();
    expect(r).toMatchObject({ installations: [], stale: true, checkedAt: null });
  });
  it('a secondary rate limit (403 with retry-after, calls left) is busy, and a plain 403 is not', async () => {
    const secondary = await accountsWith('github', stub(() => json({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '60', 'x-ratelimit-remaining': '4000' }))).check('github');
    expect(secondary.error).toMatch(/limiting requests/);
    const forbidden = await accountsWith('github', stub(() => json({ message: 'Resource not accessible' }, 403, { 'x-ratelimit-remaining': '4000' }))).check('github');
    expect(forbidden.error).toMatch(/answered with an error \(403\)/);
  });
});

describe('the page a sign-in ends on', () => {
  afterEach(() => setLinkScheme('quorum'));
  it('says what happens next for each kind of connector', () => {
    expect(doneText('granola', 'Granola')).toBe('Quorum is importing your Granola meetings now. You can close this tab.');
    expect(doneText('notion', 'Notion')).toBe('Quorum is connected to Notion. You can close this tab.');
    expect(doneText('slack', 'Slack')).not.toMatch(/meetings/);
    expect(doneText('github', 'GitHub')).toBe('Quorum is connected to GitHub. Quorum reads only the repositories you choose. You can close this tab.');
    expect(doneText('google-calendar', 'Google Calendar')).toMatch(/upcoming meetings show on Home/);
  });
  it('Back to Quorum opens the app on that connector, in the scheme this copy registered', () => {
    expect(loopbackPage({ name: 'Notion', connector: 'notion' })).toContain('<a class="btn" href="quorum://connectors/notion">Back to Quorum</a>');
    setLinkScheme(appScheme(false));
    expect(loopbackPage({ name: 'GitHub', connector: 'github' })).toContain('href="quorum-dev://connectors/github"');
    expect(loopbackPage({ name: 'GitHub', connector: 'github' })).not.toContain('Go to Quorum.watch');
  });
  it('a failure links back too; an unknown connector links to the Connectors list', () => {
    const failed = loopbackPage({ name: 'Slack', connector: 'slack', failed: 'Slack sign-in was cancelled.' });
    expect(failed).toContain('href="quorum://connectors/slack"');
    expect(failed).not.toContain('You can close this tab');
    const unknown = loopbackPage({ name: 'X', connector: 'evil"><script>' });
    expect(unknown).toContain('<a class="btn" href="quorum://connectors">Back to Quorum</a>');
    expect(unknown).not.toContain('<script>');
  });
  it('the 45 second fallback, which knows no connector, links to the list in this copy\'s scheme', () => {
    setLinkScheme('quorum-dev');
    expect(loopbackPage({ pending: true })).toContain('<a class="btn" href="quorum-dev://connectors">Back to Quorum</a>');
  });
  it('escapes the interpolated name', () => {
    const page = loopbackPage({ name: '<img src=x onerror=alert(1)>' });
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('connector links', () => {
  it('the installed app uses quorum://, a development copy quorum-dev://', () => {
    expect(appScheme(true)).toBe('quorum');
    expect(appScheme(false)).toBe('quorum-dev');
    expect(connectorLink('google-drive', 'quorum')).toBe('quorum://connectors/google-drive');
  });
  it('reads the connector id from a link in this copy\'s scheme', () => {
    expect(parseConnectorLink('quorum://connectors/github', 'quorum')).toBe('github');
    expect(parseConnectorLink('quorum://connectors/github/', 'quorum')).toBe('github');
    expect(parseConnectorLink('quorum-dev://connectors/notion?from=signin', 'quorum-dev')).toBe('notion');
  });
  it('ignores other schemes, other routes and ids the library does not know', () => {
    expect(parseConnectorLink('quorum://connectors/github', 'quorum-dev')).toBeNull();
    expect(parseConnectorLink('quorum://note/github', 'quorum')).toBeNull();
    expect(parseConnectorLink('quorum://connectors/not-a-connector', 'quorum')).toBeNull();
    expect(parseConnectorLink('quorum://connectors/__proto__', 'quorum')).toBeNull();
    expect(parseConnectorLink('quorum://connectors/%E0%A4%A', 'quorum')).toBeNull();
    expect(parseConnectorLink('quorum://connectors/github/extra', 'quorum')).toBeNull();
  });
  it('a bare connectors link opens the list', () => {
    expect(connectorLink(null, 'quorum-dev')).toBe('quorum-dev://connectors');
    expect(connectorRoute('quorum://connectors', 'quorum')).toEqual({ id: null });
    expect(connectorRoute('quorum://connectors/', 'quorum')).toEqual({ id: null });
    expect(connectorRoute('quorum-dev://connectors?from=signin', 'quorum-dev')).toEqual({ id: null });
    expect(connectorRoute('quorum://connectors/github', 'quorum')).toEqual({ id: 'github' });
    expect(connectorRoute('quorum://connectors', 'quorum-dev')).toBeNull();
    expect(connectorRoute('quorum://connectorsx', 'quorum')).toBeNull();
    expect(connectorRoute('quorum://connectors/nope', 'quorum')).toBeNull();
  });
});
