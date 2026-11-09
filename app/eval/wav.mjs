// Minimal PCM16 WAV read and write. The corpus is 16 kHz mono, so this is all the harness needs.
import { readFileSync, writeFileSync } from 'node:fs';

export function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let pos = 12, sampleRate = 0, channels = 0, bits = 0, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(pos + 10); sampleRate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + size); break; }
    pos += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`${path}: expected 16-bit PCM data`);
  const samples = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
  return { sampleRate, channels, samples };
}

export function writeWav(path, samples, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]));
}

export const wavSeconds = (path) => { const w = readWav(path); return w.samples.length / w.channels / w.sampleRate; };
