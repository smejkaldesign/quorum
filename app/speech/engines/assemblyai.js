// AssemblyAI Universal-Streaming v3. One socket per channel; Turn messages become the helper's transcript events.
// Words carry millisecond offsets; the app wants seconds from the start of the segment.
import WebSocket from 'ws';

export const id = 'assemblyai';
export const usdPerHour = 0.15;

export function url({ sampleRate, terms }) {
  const u = new URL('wss://streaming.assemblyai.com/v3/ws');
  u.searchParams.set('sample_rate', String(sampleRate));
  u.searchParams.set('encoding', 'pcm_s16le');
  u.searchParams.set('format_turns', 'true');
  if (terms.length) u.searchParams.set('keyterms_prompt', JSON.stringify(terms));
  return u.href;
}

// a Turn with text: partial while the turn runs, final once end_of_turn arrives formatted. The unformatted end_of_turn
// is skipped because the formatted copy follows with the same words; without format_turns it is the final.
export function mapMessage(msg, channel, { formatTurns = true } = {}) {
  if (!msg || msg.type !== 'Turn') return null;
  const text = String(msg.transcript ?? '').trim();
  if (!text) return null;
  const words = Array.isArray(msg.words) ? msg.words : [];
  const start = words.length ? words[0].start / 1000 : 0;
  const end = words.length ? words[words.length - 1].end / 1000 : start;
  const isFinal = msg.end_of_turn === true && (!formatTurns || msg.turn_is_formatted === true);
  if (msg.end_of_turn === true && !isFinal) return null;
  return { event: 'transcript', channel, text, isFinal, start, end };
}

export function open({ key, sampleRate, terms, channel, onEvent, onError, onClose }) {
  const ws = new WebSocket(url({ sampleRate, terms }), { headers: { Authorization: key } });
  let terminated = null;
  const ready = new Promise((resolve, reject) => {
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));
    ws.once('error', fail);
    ws.once('unexpected-response', (req, res) => { fail(new Error(`assemblyai: HTTP ${res.statusCode}`)); try { req.destroy(); } catch {} });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'Begin') { ws.off('error', fail); resolve(); return; }
      if (msg.type === 'Termination') { terminated?.(); return; }
      if (msg.error) { onError?.(new Error(`assemblyai: ${msg.error}`)); return; }
      const evt = mapMessage(msg, channel);
      if (evt) onEvent(evt);
    });
  });
  ws.on('error', (err) => onError?.(err));
  ws.on('close', (code) => { terminated?.(); onClose?.(code); });
  // Terminate makes the engine finish the open turn and answer with Termination; finish resolves on that answer
  const finish = () => new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) return resolve();
    terminated = resolve;
    setTimeout(resolve, 4000).unref();
    try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { resolve(); }
  });
  return {
    ready,
    finish,
    send: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
    close: () => { finish().then(() => ws.terminate()); },
  };
}
