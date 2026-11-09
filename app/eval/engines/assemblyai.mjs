// AssemblyAI prerecorded: upload each channel file, create a transcript, poll, use the word timings. Entities go in
// as word_boost; the request is retried without it when the model rejects the field.
import { readFileSync } from 'node:fs';
import { expectJson, groupWords, keychain } from './shared.mjs';

export const id = 'assemblyai';
export const cloud = true;
export const usdPerHour = 0.15;
const API = 'https://api.assemblyai.com/v2';

async function one(key, file, channel, entities, diarize) {
  const headers = { authorization: key };
  const { upload_url } = await expectJson(await fetch(`${API}/upload`, { method: 'POST', headers, body: readFileSync(file) }), 'upload');
  const body = { audio_url: upload_url, speech_models: ['universal-2'], speaker_labels: diarize };
  if (entities.length) body.word_boost = entities.slice(0, 1000);
  let res = await fetch(`${API}/transcript`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 400 && body.word_boost) {
    delete body.word_boost;
    res = await fetch(`${API}/transcript`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  const { id: tid } = await expectJson(res, 'create transcript');
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = await expectJson(await fetch(`${API}/transcript/${tid}`, { headers }), 'poll');
    if (t.status === 'completed') return groupWords((t.words ?? []).map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000, speaker: diarize ? w.speaker : undefined })), channel);
    if (t.status === 'error') throw new Error(`assemblyai: ${t.error}`);
  }
}

export async function transcribe(item, { terms = [] } = {}) {
  const key = keychain('assemblyai-quorum');
  const t0 = performance.now();
  const jobs = [one(key, item.me, 'me', terms, !item.them)];
  if (item.them) jobs.push(one(key, item.them, 'them', terms, false));
  const pieces = (await Promise.all(jobs)).flat().sort((a, b) => a.start - b.start);
  return { pieces, wallMs: performance.now() - t0 };
}
