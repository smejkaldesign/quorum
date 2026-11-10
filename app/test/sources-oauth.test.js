import { describe, expect, it } from 'vitest';
import { authorizeUrl, connect, discover, metadataUrls, pkce, register } from '../sources/oauth.js';

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
    expect(meta.scopes).toEqual(['mcp', 'offline_access']);
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
