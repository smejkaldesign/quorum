// Quorum Cloud transcription relay. Health at /healthz, audio in over the websocket at /v1/transcribe, notes at
// POST /v1/notes. Audio is forwarded to the speech engine and never stored; logs carry durations and engine names only.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { makeClients } from './lib/auth.js';
import { checkConfig, config } from './lib/config.js';
import { ENGINES } from './lib/engines/index.js';
import { log } from './lib/log.js';
import { handleConnection } from './lib/session.js';
import { handleNotes } from './summary.js';
import { handleCheckout, handlePacks, handlePortal, handleWebhook } from './billing.js';

checkConfig();
const clients = makeClients();
const deps = { clients, config, engines: ENGINES, log };

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://relay');
  if (pathname === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, engine: config.engine, notes: !!config.keys.anthropic, billing: !!(config.stripe.key && config.stripe.seatPrice) })); }
  if (pathname === '/v1/notes') return handleNotes(req, res, deps);
  if (pathname === '/v1/billing/checkout') return handleCheckout(req, res, deps);
  if (pathname === '/v1/billing/portal') return handlePortal(req, res, deps);
  if (pathname === '/v1/billing/packs') return handlePacks(req, res, deps);
  if (pathname === '/v1/billing/webhook') return handleWebhook(req, res, deps);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://relay');
  if (pathname !== '/v1/transcribe') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req, deps));
});

server.listen(config.port, () => log('listening', { port: config.port, engine: config.engine, notes: !!config.keys.anthropic }));
const stop = () => { log('stopping'); wss.clients.forEach((c) => c.close(1001, 'restart')); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
