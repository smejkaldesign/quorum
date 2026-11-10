// Deepgram prerecorded, nova-3 with smart_format and the item's entities as keyterms. One request per channel file;
// a single mixed file is diarized instead.
import { readFileSync } from 'node:fs';
import { expectJson, groupWords, keychain } from './shared.mjs';

export const id = 'deepgram';
export const cloud = true;
export const usdPerHour = 0.46;

async function one(key, file, channel, entities, diarize) {
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('smart_format', 'true');
  if (diarize) url.searchParams.set('diarize', 'true');
  for (const e of entities.slice(0, 100)) url.searchParams.append('keyterm', e);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: readFileSync(file) });
  const data = await expectJson(res, 'deepgram listen');
  const words = data.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  return groupWords(words.map((w) => ({ text: w.punctuated_word ?? w.word, start: w.start, end: w.end, speaker: diarize ? w.speaker : undefined })), channel);
}

export async function transcribe(item, { terms = [] } = {}) {
  const key = keychain('deepgram-quorum');
  const t0 = performance.now();
  const jobs = [one(key, item.me, 'me', terms, !item.them)];
  if (item.them) jobs.push(one(key, item.them, 'them', terms, false));
  const pieces = (await Promise.all(jobs)).flat().sort((a, b) => a.start - b.start);
  return { pieces, wallMs: performance.now() - t0 };
}
