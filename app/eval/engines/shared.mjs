// Shared pieces for the cloud adapters: Keychain keys read in-process and never printed, and word lists grouped
// into pieces the way the helper emits finals (a new piece on a speaker change or a pause).
import { execFileSync } from 'node:child_process';

export function keychain(service) {
  try { return execFileSync('security', ['find-generic-password', '-a', 'quorum', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error(`no Keychain item for account quorum, service ${service}`); }
}

// words: [{ text, start, end, speaker? }] in seconds. channel labels a whole file; speaker (diarized) splits it.
export function groupWords(words, channel, pause = 0.8) {
  const pieces = [];
  for (const w of words) {
    const last = pieces[pieces.length - 1];
    const label = w.speaker != null ? `${channel}:${w.speaker}` : channel;
    if (last && last.channel === label && w.start - last.end < pause) { last.text += ` ${w.text}`; last.end = w.end; }
    else pieces.push({ channel: label, text: w.text, start: w.start, end: w.end });
  }
  return pieces;
}

export const hours = (seconds) => seconds / 3600;
export const money = (n) => `$${n.toFixed(3)}`;

export async function expectJson(res, what) {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
