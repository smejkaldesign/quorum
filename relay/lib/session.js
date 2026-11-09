// one websocket from the app: hello, then binary audio frames in, transcript events out, one usage row at the end.
// The relay keeps no audio: a frame is forwarded to the engine's socket and dropped.
import { sessionBudget } from './allowance.js';
import { allowance, authorize, bearer, connectorSecret, RelayError } from './auth.js';
import { cleanHello, demux, pcmSeconds } from './frames.js';
import { usageEvent, writeUsage } from './usage.js';

export const CLOSE = { client: 1000, idle: 4000, unauthorized: 4001, forbidden: 4001, allowance: 4002, cap: 4003, engine: 4004, connector: 4004, bad_request: 4005, server: 4006 };
const codeFor = (code) => CLOSE[code] ?? CLOSE.server;

export function handleConnection(ws, req, { clients, config, engines, log = () => {}, now = () => Date.now() }) {
  const headerToken = bearer(req.headers?.authorization);
  const s = { phase: 'hello', hello: null, user: null, engine: null, engineName: null, connectorId: null, counted: true, budget: 0, sessions: new Map(), bytes: {}, startedAt: now(), closed: false, reason: null };
  const timers = { hello: null, idle: null };
  const send = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const seconds = () => Math.max(0, ...Object.values(s.bytes).map((b) => pcmSeconds(b, s.hello?.sampleRate ?? 16000)));

  const close = (code, message) => {
    if (s.closed) return;
    s.reason = code;
    if (message) send({ event: 'error', code, message });
    try { ws.close(codeFor(code), String(code)); } catch {}
    setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
  };

  const armIdle = () => {
    clearTimeout(timers.idle);
    timers.idle = setTimeout(() => close('idle', 'No audio for 20 seconds.'), config.idleMs);
    timers.idle.unref?.();
  };

  async function begin(raw) {
    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch { return close('bad_request', 'The first message must be JSON.'); }
    const hello = cleanHello(parsed);
    s.hello = hello;
    const token = hello.token ?? headerToken;
    const user = await authorize(clients, { token, workspaceId: hello.workspaceId });
    s.user = user;
    // the admin's speech override routes to the organization's connector and its hours never count; otherwise Quorum's key
    let key;
    if (user.voice.speech) {
      const c = await connectorSecret(clients.db, user.voice.speech, 'speech');
      if (!engines[c.provider]) throw new RelayError('connector', `The organization's speech connector (${c.provider}) is not a streaming engine the relay can use.`, 400);
      s.engineName = c.provider; s.connectorId = user.voice.speech; s.counted = false; key = c.secret;
    } else {
      s.engineName = config.engine; key = config.keys[config.engine];
    }
    const a = await allowance(clients.db, hello.workspaceId, new Date(now()));
    if (s.counted && a.remaining <= 0) throw new RelayError('allowance', 'This workspace has used its managed transcription hours for the month.', 402);
    s.budget = sessionBudget({ counted: s.counted, remaining: a.remaining, maxSessionSeconds: config.maxSessionSeconds });
    s.engine = engines[s.engineName];
    for (const channel of hello.channels) {
      s.bytes[channel] = 0;
      const es = s.engine.open({
        key, sampleRate: hello.sampleRate, terms: hello.terms, locale: hello.locale, channel,
        onEvent: (evt) => send(evt),
        onError: (err) => { log('engine_error', { engine: s.engineName, channel, message: err.message }); close('engine', 'The speech engine dropped the connection.'); },
        onClose: () => { if (s.phase === 'streaming' && !s.closed) close('engine', 'The speech engine closed the connection.'); },
      });
      s.sessions.set(channel, es);
    }
    await Promise.race([
      Promise.all([...s.sessions.values()].map((es) => es.ready)),
      new Promise((_, reject) => setTimeout(() => reject(new RelayError('engine', 'The speech engine did not answer in time.', 504)), 15000).unref()),
    ]);
    key = null;
    s.phase = 'streaming';
    send({ event: 'ready', engine: s.engineName, counted: s.counted, remainingSeconds: s.counted ? a.remaining : null, budgetSeconds: s.budget });
    log('session_start', { workspace: hello.workspaceId, engine: s.engineName, counted: s.counted, channels: hello.channels.length, terms: hello.terms.length });
    armIdle();
  }

  async function finish() {
    if (s.closed) return;
    s.closed = true;
    clearTimeout(timers.hello); clearTimeout(timers.idle);
    for (const es of s.sessions.values()) { try { es.close(); } catch {} }
    const secs = seconds();
    const row = s.user && (s.phase === 'streaming' || s.phase === 'draining') && secs > 0
      ? usageEvent({ workspaceId: s.hello.workspaceId, userId: s.user.userId, role: 'speech', seconds: secs, engine: s.engineName, connectorId: s.connectorId, meetingId: s.hello.meetingId, now: now() })
      : null;
    if (row) { try { await writeUsage(clients.db, row); } catch (err) { log('usage_write_failed', { message: err.message }); } }
    log('session_end', { workspace: s.hello?.workspaceId ?? null, engine: s.engineName, seconds: Math.round(secs), counted: s.counted, reason: s.reason ?? 'client', wallMs: now() - s.startedAt, usage: !!row });
  }

  // a clean stop: the engines finish the open turns and those finals still reach the app before the socket closes
  async function drain() {
    s.phase = 'draining';
    clearTimeout(timers.idle);
    await Promise.all([...s.sessions.values()].map((es) => (es.finish ? es.finish() : Promise.resolve()).catch(() => {})));
    close('client');
  }

  timers.hello = setTimeout(() => close('bad_request', 'No hello within 10 seconds.'), config.helloMs);
  timers.hello.unref?.();

  ws.on('message', (data, isBinary) => {
    if (s.phase === 'hello') {
      if (isBinary) return close('bad_request', 'Send the hello before audio.');
      s.phase = 'auth';
      clearTimeout(timers.hello);
      begin(data).catch((err) => {
        const code = err instanceof RelayError ? err.code : 'server';
        log('session_refused', { code, message: err.message });
        close(code, err instanceof RelayError ? err.message : 'The relay hit an error.');
      });
      return;
    }
    if (s.phase !== 'streaming' || s.reason) return;
    if (!isBinary) {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.event === 'stop') drain();
      return;
    }
    const f = demux(data, s.hello.channels);
    if (!f) return;
    s.bytes[f.channel] += f.pcm.length;
    if (seconds() > s.budget) return close('cap', s.counted ? 'The managed transcription hours for this month are used up.' : 'This session reached the 4 hour limit.');
    s.sessions.get(f.channel)?.send(f.pcm);
    armIdle();
  });
  ws.on('close', () => { finish().catch(() => {}); });
  ws.on('error', (err) => { log('socket_error', { message: err.message }); finish().catch(() => {}); });

  return { state: s };
}
