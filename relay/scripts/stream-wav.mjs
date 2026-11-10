#!/usr/bin/env node
// Streams one or two 16 kHz mono PCM16 WAV files through a running relay and prints the finals it returns.
//   node scripts/stream-wav.mjs --url ws://127.0.0.1:8787/v1/transcribe --token <access token> --workspace <ulid> me.wav [them.wav] [--terms a,b] [--speed 4]
// Frames are 100 ms of audio, paced at --speed times real time (default 1). The engines keep up with real time only:
// at 4x, AssemblyAI returned the first half of a 26 second call and dropped the rest at Terminate. Prints a JSON summary at the end.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
if (!files.length) { console.error('usage: stream-wav.mjs --url <ws url> --token <jwt> --workspace <ulid> me.wav [them.wav]'); process.exit(2); }
const url = opt('url', 'ws://127.0.0.1:8787/v1/transcribe');
const token = opt('token', process.env.RELAY_TOKEN);
const workspaceId = opt('workspace', process.env.RELAY_WORKSPACE);
const speed = Number(opt('speed', 1));
const terms = (opt('terms', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const sampleRate = 16000;

// a WAV file's PCM payload: finds the data chunk and trusts the header to be 16 kHz mono Int16
function pcmOf(file) {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') { const rate = buf.readUInt32LE(off + 12), ch = buf.readUInt16LE(off + 10), bits = buf.readUInt16LE(off + 22); if (rate !== sampleRate || ch !== 1 || bits !== 16) throw new Error(`${file}: want 16 kHz mono 16-bit, got ${rate} Hz ${ch} ch ${bits} bit`); }
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

const channels = ['me', 'them'].slice(0, files.length);
const pcm = files.map(pcmOf);
const frameBytes = (sampleRate / 10) * 2;
const finals = [];
const t0 = Date.now();
const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
ws.on('open', () => ws.send(JSON.stringify({ workspaceId, meetingId: null, channels, sampleRate, terms, locale: 'en-US' })));
ws.on('message', async (data, isBinary) => {
  if (isBinary) return;
  const msg = JSON.parse(data.toString());
  if (msg.event === 'ready') { console.error(`ready: ${msg.engine}, counted ${msg.counted}, remaining ${msg.remainingSeconds}s`); pump().catch((e) => { console.error(e.message); process.exit(1); }); return; }
  if (msg.event === 'error') { console.error(`relay error ${msg.code}: ${msg.message}`); return; }
  if (msg.event === 'transcript' && msg.isFinal) { finals.push(msg); console.error(`${msg.channel} [${msg.start.toFixed(1)}-${msg.end.toFixed(1)}] ${msg.text}`); }
});
ws.on('close', (code) => {
  const seconds = Math.max(...pcm.map((p) => p.length / 2 / sampleRate));
  console.log(JSON.stringify({ close: code, audioSeconds: Math.round(seconds * 10) / 10, wallMs: Date.now() - t0, finals: finals.sort((a, b) => a.start - b.start).map(({ channel, text, start, end }) => ({ channel, text, start, end })) }, null, 2));
  process.exit(0);
});
ws.on('error', (err) => { console.error(err.message); process.exit(1); });

// both channels advance together, 100 ms at a time, so the two sides keep one timeline like a live call
async function pump() {
  const frames = Math.max(...pcm.map((p) => Math.ceil(p.length / frameBytes)));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < pcm.length; c++) {
      const slice = pcm[c].subarray(i * frameBytes, (i + 1) * frameBytes);
      if (slice.length) ws.send(Buffer.concat([Buffer.from([c]), slice]));
    }
    await new Promise((r) => setTimeout(r, 100 / speed));
  }
  // stop makes the relay finish the open turns on both engines before it closes, so the tail finals still arrive
  await new Promise((r) => setTimeout(r, 1000));
  ws.send(JSON.stringify({ event: 'stop' }));
}
