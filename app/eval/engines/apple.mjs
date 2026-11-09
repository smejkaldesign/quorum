// Apple SpeechAnalyzer through the helper binary's transcribe-file command. Finals only; the helper feeds both
// channel files through the same ChannelTranscriber the app uses live.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = 'apple';
export const cloud = false;
const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultHelper = path.resolve(here, '../../../helper/.build/debug/QuorumHelper');

export async function transcribe(item, { helper = defaultHelper, terms = [] } = {}) {
  if (!existsSync(helper)) throw new Error(`helper not built at ${helper}; run swift build in helper/`);
  const args = ['transcribe-file', item.me, ...(item.them ? [item.them] : []), ...(terms.length ? ['--terms', ...terms] : [])];
  const t0 = performance.now();
  const lines = await new Promise((resolve, reject) => {
    const p = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out.split('\n')) : reject(new Error(`helper exit ${code}: ${err.trim() || out.slice(-400)}`))));
  });
  const pieces = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.event === 'error') throw new Error(`helper: ${ev.message}`);
    if (ev.event === 'transcript' && ev.isFinal) pieces.push({ channel: ev.channel, text: ev.text, start: ev.start, end: ev.end });
  }
  return { pieces, wallMs: performance.now() - t0 };
}
