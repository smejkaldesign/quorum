// Managed transcription (Cloud edition): the helper's 16 kHz PCM goes to the relay over one websocket and transcript
// events come back in the helper's own shape, so main.js feeds them to addFinal unchanged. Pure Node, no electron import.
// The token travels in the hello message: the WHATWG WebSocket Node and Electron ship cannot set request headers.

export const DEFAULT_RELAY = 'wss://relay.quorum.watch';
export const LOCAL_RELAY = 'ws://127.0.0.1:8787';

// QUORUM_RELAY_URL wins; a copy on the local Supabase stack talks to a relay on this Mac; everything else to Quorum's
export function relayUrl({ env = process.env, source = 'production' } = {}) {
  const u = String(env.QUORUM_RELAY_URL ?? '').trim();
  if (u) return u.replace(/\/+$/, '');
  return source === 'local' ? LOCAL_RELAY : DEFAULT_RELAY;
}

// whether this call goes through the relay. The admin's settings win: required, or speech routed to an organization
// connector. Otherwise the user's own choice (settings.transcription.engine). Default is the on-device engine.
export function speechPlan({ signedIn = false, workspace = null, voice = {}, engine = 'local' } = {}) {
  if (!signedIn || !workspace) return { managed: false, reason: 'signed out' };
  if (voice?.required === true) return { managed: true, reason: 'required by the workspace' };
  if (voice?.speech) return { managed: true, reason: 'organization connector' };
  if (engine === 'managed') return { managed: true, reason: 'your choice' };
  return { managed: false, reason: 'on-device by choice' };
}

// the plan for the signed-in account: reads the workspace voice settings with the user's own session
export async function managedPlan({ client, state, settings }) {
  if (!client || !state?.signedIn || !state.workspace) return speechPlan({});
  let voice = {};
  try {
    const { data } = await client.from('workspace_settings').select('voice').eq('workspace_id', state.workspace.id).maybeSingle();
    if (data?.voice && typeof data.voice === 'object') voice = data.voice;
  } catch {}
  return speechPlan({ signedIn: true, workspace: state.workspace, voice, engine: settings?.transcription?.engine ?? 'local' });
}

// one relay session. send(channel, pcm) frames the audio as [channel index][PCM16LE]; events arrive on onEvent exactly as
// the helper would emit them. ready resolves with the relay's ready message or rejects with the refusal.
export function openRelay({ url, token, meta, onEvent = () => {}, onError = () => {}, onClose = () => {}, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 }) {
  const channels = meta.channels ?? ['me', 'them'];
  const ws = new WebSocketImpl(`${url}/v1/transcribe`);
  ws.binaryType = 'arraybuffer';
  let settled = false, closed = false, lastError = null;
  const ready = new Promise((resolve, reject) => {
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { done(reject, new Error('the relay did not answer')); try { ws.close(); } catch {} }, timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ token, ...meta, channels })));
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event === 'ready') return done(resolve, msg);
      if (msg.event === 'error') { lastError = msg; onError(msg); return done(reject, new Error(msg.message || msg.code)); }
      if (msg.event === 'transcript') onEvent(msg);
    });
    ws.addEventListener('error', () => done(reject, new Error('the relay could not be reached')));
    ws.addEventListener('close', (e) => { closed = true; done(reject, new Error(lastError?.message || 'the relay closed the connection')); onClose({ code: e.code, reason: e.reason, error: lastError }); });
  });
  ready.catch(() => {});
  return {
    ready,
    send(channel, pcm) {
      const i = channels.indexOf(channel);
      if (i < 0 || closed || ws.readyState !== 1) return;
      const frame = new Uint8Array(1 + pcm.length);
      frame[0] = i;
      frame.set(pcm, 1);
      ws.send(frame);
    },
    // stop lets the relay finish the open turns and close; the local close is the fallback when it never does
    close() {
      if (closed) return;
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ event: 'stop' })); else ws.close(1000, 'done'); } catch {}
      setTimeout(() => { try { if (!closed) ws.close(1000, 'done'); } catch {} }, 6000).unref?.();
    },
    get open() { return !closed && ws.readyState === 1; },
  };
}
