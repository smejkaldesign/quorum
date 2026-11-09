// Deepgram Nova-3 streaming. One socket per channel; Results messages become the helper's transcript events.
// Times are seconds already; start is the message offset, end is start plus duration or the last word's end.
import WebSocket from 'ws';

export const id = 'deepgram';
export const usdPerHour = 0.46;

export function url({ sampleRate, terms, locale }) {
  const u = new URL('wss://api.deepgram.com/v1/listen');
  u.searchParams.set('model', 'nova-3');
  u.searchParams.set('encoding', 'linear16');
  u.searchParams.set('sample_rate', String(sampleRate));
  u.searchParams.set('channels', '1');
  u.searchParams.set('smart_format', 'true');
  u.searchParams.set('interim_results', 'true');
  u.searchParams.set('endpointing', '300');
  if (locale && !locale.startsWith('en')) u.searchParams.set('language', locale.split('-')[0]);
  for (const t of terms.slice(0, 100)) u.searchParams.append('keyterm', t);
  return u.href;
}

export function mapMessage(msg, channel) {
  if (!msg || msg.type !== 'Results') return null;
  const alt = msg.channel?.alternatives?.[0];
  const text = String(alt?.transcript ?? '').trim();
  if (!text) return null;
  const words = Array.isArray(alt.words) ? alt.words : [];
  const start = words.length ? words[0].start : Number(msg.start) || 0;
  const end = words.length ? words[words.length - 1].end : start + (Number(msg.duration) || 0);
  return { event: 'transcript', channel, text, isFinal: msg.is_final === true, start, end };
}

export function open({ key, sampleRate, terms, locale, channel, onEvent, onError, onClose }) {
  const ws = new WebSocket(url({ sampleRate, terms, locale }), { headers: { Authorization: `Token ${key}` } });
  const ready = new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    ws.once('error', fail);
    ws.once('unexpected-response', (_req, res) => fail(new Error(`deepgram: HTTP ${res.statusCode}`)));
    ws.once('open', () => { ws.off('error', fail); resolve(); });
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'Error') { onError?.(new Error(`deepgram: ${msg.description ?? msg.message ?? 'error'}`)); return; }
    const evt = mapMessage(msg, channel);
    if (evt) onEvent(evt);
  });
  let closedResolve = null;
  ws.on('error', (err) => onError?.(err));
  ws.on('close', (code) => { closedResolve?.(); onClose?.(code); });
  // Deepgram closes a quiet socket after about ten seconds; a keepalive every five keeps a muted side open
  const keep = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 5000);
  keep.unref();
  // CloseStream makes the engine flush the last results and close the socket; finish resolves on that close
  const finish = () => new Promise((resolve) => {
    clearInterval(keep);
    if (ws.readyState !== WebSocket.OPEN) return resolve();
    closedResolve = resolve;
    setTimeout(resolve, 4000).unref();
    try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { resolve(); }
  });
  return {
    ready,
    finish,
    send: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
    close: () => { finish().then(() => ws.terminate()); },
  };
}
