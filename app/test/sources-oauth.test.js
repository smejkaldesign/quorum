import { describe, expect, it } from 'vitest';
import { authorizeUrl, awaitLoopback, connect, discover, httpsOnly, metadataUrls, pkce, register } from '../sources/oauth.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const RESOURCE = { resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://auth.example.com'], scopes_supported: ['mcp'] };
const AS = { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/oauth2/authorize', token_endpoint: 'https://auth.example.com/oauth2/token', registration_endpoint: 'https://auth.example.com/oauth2/register', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'], scopes_supported: ['openid', 'offline_access'] };

const fake = (log = []) => async (url, init = {}) => {
  log.push({ url, init });
  if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') return json(RESOURCE);
  if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') return json(AS);
  if (url === AS.registration_endpoint) return json({ client_id: 'cid-1' }, 201);
  if (url === AS.token_endpoint) {
    const p = new URLSearchParams(init.body);
    if (p.get('grant_type') === 'authorization_code' && p.get('code') === 'good' && p.get('code_verifier')) return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' });
    return json({ error: 'invalid_grant' }, 400);
  }
  return new Response('nope', { status: 404 });
};

describe('oauth discovery', () => {
  it('prefers the metadata URL named by the 401, then the well-known paths', () => {
    expect(metadataUrls('https://mcp.example.com/mcp', 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"')).toEqual([
      'https://mcp.example.com/.well-known/oauth-protected-resource', 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    ]);
  });
  it('finds the authorization server and asks for a refresh token when offered', async () => {
    const meta = await discover('https://mcp.example.com/mcp', { fetchImpl: fake() });
    expect(meta.tokenEndpoint).toBe(AS.token_endpoint);
    expect(meta.scopes).toEqual(['mcp', 'offline_access', 'openid']);
  });
  it('registers as a public native client', async () => {
    const log = [];
    const meta = await discover('https://mcp.example.com/mcp', { fetchImpl: fake(log) });
    const client = await register(meta, { fetchImpl: fake(log) });
    expect(client).toMatchObject({ clientId: 'cid-1', clientSecret: null, authMethod: 'none' });
    const body = JSON.parse(log.at(-1).init.body);
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:47832/callback']);
    expect(body.grant_types).toContain('refresh_token');
  });
  it('builds a PKCE authorize URL bound to the resource', () => {
    const { challenge } = pkce();
    const u = new URL(authorizeUrl({ authorizationEndpoint: AS.authorization_endpoint, resource: RESOURCE.resource, scopes: ['mcp'] }, { clientId: 'cid-1', redirectUri: 'http://127.0.0.1:47832/callback', challenge, state: 's1' }));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(u.searchParams.get('scope')).toBe('mcp');
  });
});

describe('oauth connect', () => {
  const memClients = () => { const m = {}; return { get: async (k) => m[k] ?? null, set: async (k, v) => { m[k] = v; } }; };
  it('runs the whole flow and reuses a saved registration', async () => {
    const log = [], opened = [];
    const clients = memClients();
    let state;
    const loopback = () => new Promise((r) => setTimeout(() => r({ code: 'good', state }), 5));
    const open = async (url) => { opened.push(url); state = new URL(url).searchParams.get('state'); };
    const r = await connect({ resourceUrl: 'https://mcp.example.com/mcp', open, clients, fetchImpl: fake(log), loopback });
    expect(r.tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    expect(r.tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(log.filter((l) => l.url === AS.registration_endpoint)).toHaveLength(1);
    await connect({ resourceUrl: 'https://mcp.example.com/mcp', open, clients, fetchImpl: fake(log), loopback });
    expect(log.filter((l) => l.url === AS.registration_endpoint)).toHaveLength(1);
  });
  it('refuses a state mismatch and a browser error', async () => {
    const clients = memClients();
    await expect(connect({ resourceUrl: 'https://mcp.example.com/mcp', open: async () => {}, clients, fetchImpl: fake(), loopback: async () => ({ code: 'good', state: 'wrong' }) })).rejects.toThrow(/did not match/);
    await expect(connect({ resourceUrl: 'https://mcp.example.com/mcp', open: async () => {}, clients, fetchImpl: fake(), loopback: async () => ({ error: 'access_denied', error_description: 'User said no' }) })).rejects.toThrow('User said no');
  });
});

describe('the sign-in page address', () => {
  it('opens only https, or http on this Mac, even when discovery names something else', () => {
    expect(httpsOnly('https://auth.example.com/authorize?x=1')).toBe('https://auth.example.com/authorize?x=1');
    for (const local of ['http://127.0.0.1:9000/authorize', 'http://[::1]:9000/authorize', 'http://localhost/authorize']) {
      expect(httpsOnly(local)).toBe(local);
      expect(new URL(authorizeUrl({ authorizationEndpoint: local, resource: RESOURCE.resource, scopes: [] }, { clientId: 'c', redirectUri: 'http://127.0.0.1:47832/callback', challenge: 'x', state: 's' })).searchParams.get('state')).toBe('s');
    }
    for (const bad of ['http://auth.example.com/authorize', 'http://127.0.0.2/authorize', 'http://localhost.evil.example/authorize', 'ftp://localhost/authorize', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect(() => httpsOnly(bad)).toThrow();
      expect(() => authorizeUrl({ authorizationEndpoint: bad, resource: RESOURCE.resource, scopes: [] }, { clientId: 'c', redirectUri: 'http://127.0.0.1:47832/callback', challenge: 'x', state: 's' })).toThrow();
    }
  });
  it('refuses a connect whose metadata names an http sign-in page, before opening the browser', async () => {
    const opened = [];
    const insecure = async (url, init) => (url === 'https://auth.example.com/.well-known/oauth-authorization-server' ? json({ ...AS, authorization_endpoint: 'http://auth.example.com/authorize' }) : fake()(url, init));
    const clients = { get: async () => null, set: async () => {} };
    await expect(connect({ resourceUrl: 'https://mcp.example.com/mcp', open: async (u) => { opened.push(u); }, clients, fetchImpl: insecure, loopback: () => new Promise(() => {}) })).rejects.toThrow(/https/);
    expect(opened).toEqual([]);
  });
});

describe('the loopback wait', () => {
  it('answers a visit with another state with 400 and keeps waiting for the real answer', async () => {
    const port = 47500 + Math.floor(Math.random() * 400);
    const waiting = awaitLoopback({ port, state: 'good-state' });
    await new Promise((r) => setTimeout(r, 50));
    const forged = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=other`);
    expect(forged.status).toBe(400);
    const missing = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
    expect(missing.status).toBe(400);
    const real = fetch(`http://127.0.0.1:${port}/callback?code=c1&state=good-state`);
    const q = await waiting;
    expect(q).toMatchObject({ code: 'c1', state: 'good-state' });
    q.finish({});
    expect((await real).status).toBe(200);
  });
});
