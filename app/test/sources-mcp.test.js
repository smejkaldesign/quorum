import { describe, expect, it } from 'vitest';
import { createMcp, parseSse } from '../sources/mcp.js';

const res = (status, body, headers = {}) => new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('parseSse', () => {
  it('collects every data message', () => {
    const text = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    expect(parseSse(text).map((m) => m.id ?? m.method)).toEqual(['notifications/progress', 2]);
  });
});

describe('createMcp', () => {
  const server = ({ unauthorizedOnce = false, sse = false } = {}) => {
    const seen = [];
    let denied = !unauthorizedOnce;
    const fetchImpl = async (url, init) => {
      const msg = JSON.parse(init.body);
      seen.push({ headers: init.headers, msg });
      if (!denied) { denied = true; return res(401, { message: 'Unauthorized' }, { 'www-authenticate': 'Bearer error="invalid_token"' }); }
      if (msg.method === 'initialize') return res(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      if (msg.method === 'notifications/initialized') return res(202, null);
      if (msg.method === 'tools/list') return res(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'search_meetings' }] } }, { 'content-type': 'application/json' });
      if (msg.method === 'tools/call') {
        const body = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params.name}` }], isError: msg.params.name === 'boom' } };
        return sse ? res(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\ndata: ${JSON.stringify(body)}\n\n`, { 'content-type': 'text/event-stream' }) : res(200, body, { 'content-type': 'application/json' });
      }
      return res(404, 'no');
    };
    return { fetchImpl, seen };
  };

  it('initializes once, carries the session id, and reads JSON answers', async () => {
    const { fetchImpl, seen } = server();
    const mcp = createMcp({ url: 'https://x/mcp', token: async () => 'tok', fetchImpl });
    expect(await mcp.tools()).toEqual([{ name: 'search_meetings' }]);
    expect(await mcp.call('search_meetings', { a: 1 })).toEqual({ text: 'called search_meetings', structured: null });
    expect(seen.map((s) => s.msg.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(seen[2].headers['mcp-session-id']).toBe('sess-1');
    expect(seen[0].headers.authorization).toBe('Bearer tok');
  });
  it('reads SSE answers and turns tool errors into thrown errors', async () => {
    const { fetchImpl } = server({ sse: true });
    const mcp = createMcp({ url: 'https://x/mcp', token: async () => 'tok', fetchImpl });
    expect((await mcp.call('ok')).text).toBe('called ok');
    await expect(mcp.call('boom')).rejects.toThrow('called boom');
  });
  it('asks for a fresh token once on 401 and retries', async () => {
    const { fetchImpl, seen } = server({ unauthorizedOnce: true });
    let refreshed = 0;
    const mcp = createMcp({ url: 'https://x/mcp', token: async () => (refreshed ? 'new' : 'old'), onUnauthorized: async () => { refreshed += 1; }, fetchImpl });
    await mcp.initialize();
    expect(refreshed).toBe(1);
    expect(seen[1].headers.authorization).toBe('Bearer new');
  });
});
