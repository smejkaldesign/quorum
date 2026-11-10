// A small MCP client over Streamable HTTP: JSON-RPC requests by POST, answers as JSON or as a server-sent event
// stream, the session id header carried between calls, and a bearer token the caller supplies (and refreshes on 401).
export const PROTOCOL = '2025-06-18';

// every JSON-RPC message in an SSE body, in order
export function parseSse(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch {}
  }
  return out;
}

export function createMcp({ url, token, onUnauthorized = null, fetchImpl = fetch, clientInfo = { name: 'Quorum', version: '0' } }) {
  let sessionId = null;
  let seq = 0;
  let ready = null;

  const post = async (message, retried = false) => {
    const t = await token();
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (t) headers.authorization = `Bearer ${t}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(120000) });
    if (r.status === 401 && onUnauthorized && !retried) { await onUnauthorized(r.headers.get('www-authenticate') ?? ''); return post(message, true); }
    if (r.status === 401 || r.status === 403) { const e = new Error('The service no longer accepts this connection. Connect again.'); e.code = 'unauthorized'; throw e; }
    if (r.status === 404 && sessionId) { sessionId = null; ready = null; const e = new Error('The session expired.'); e.code = 'session'; throw e; }
    const sid = r.headers.get('mcp-session-id'); if (sid) sessionId = sid;
    if (r.status === 202 || r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) throw new Error(`The service answered ${r.status}.`);
    const ct = r.headers.get('content-type') ?? '';
    const messages = ct.includes('text/event-stream') ? parseSse(text) : (() => { try { return [JSON.parse(text)]; } catch { return []; } })();
    if (message.id === undefined) return null;
    const reply = messages.find((m) => m && m.id === message.id);
    if (!reply) throw new Error('The service did not answer the request.');
    if (reply.error) { const e = new Error(reply.error.message || 'The service refused the request.'); e.code = reply.error.code; e.data = reply.error.data; throw e; }
    return reply.result;
  };

  const request = (method, params) => post({ jsonrpc: '2.0', id: ++seq, method, params });
  const notify = (method, params) => post({ jsonrpc: '2.0', method, params });

  const init = () => {
    ready ??= (async () => {
      const r = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo });
      await notify('notifications/initialized', {});
      return r;
    })().catch((err) => { ready = null; throw err; });
    return ready;
  };

  const withSession = async (fn) => {
    await init();
    try { return await fn(); }
    catch (err) { if (err.code !== 'session') throw err; await init(); return fn(); }
  };

  return {
    initialize: init,
    tools: () => withSession(async () => {
      const out = [];
      let cursor;
      do { const r = await request('tools/list', cursor ? { cursor } : {}); out.push(...(r.tools ?? [])); cursor = r.nextCursor; } while (cursor);
      return out;
    }),
    // the text of the tool's answer; a tool-level error becomes a thrown Error so callers handle one shape
    call: (name, args = {}) => withSession(async () => {
      const r = await request('tools/call', { name, arguments: args });
      const text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) { const e = new Error(text || `${name} failed.`); e.code = 'tool'; throw e; }
      return { text, structured: r.structuredContent ?? null };
    }),
    sessionId: () => sessionId,
  };
}
