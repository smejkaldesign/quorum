// Settings, Account management, Export your notes: one zip with every markdown note in the vault, the meeting notes
// kept outside it (a meetings folder chosen elsewhere, folders of other apps added by hand) and Quorum's chats, which
// live in Quorum's own folder and nowhere in the vault. The zip is written here with node:zlib, so the export works the
// same in both editions and needs no extra dependency. It refuses what a plain zip cannot hold (more than 65,535
// files, or 4 GB) with a sentence instead of writing a broken archive.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { walk } from './vault.js';

const deflateRaw = promisify(zlib.deflateRaw);
export const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// a zip's dates are MS-DOS local time with two-second steps, and nothing before 1980
function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const inside = (dir, abs) => { const r = path.relative(dir, abs); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// the files of one folder as archive entries under `prefix`, markdown only, skipping hidden folders as the vault tree does
function folderEntries(dir, prefix) {
  if (!dir || !existsSync(dir)) return [];
  return walk(dir, '', () => false, []).map((rel) => ({ abs: path.join(dir, ...rel.split('/')), name: `${prefix}/${rel}` }));
}

// what goes in the archive, each entry an absolute path and its name inside the zip. Notes holds the whole vault, which
// already includes the meetings folder when it sits inside it; Meetings holds only what the vault does not
export function collectExport({ vault = null, meetingsDir = null, meetingSources = [], chatsDir = null, root = 'Quorum export' } = {}) {
  const entries = [];
  if (vault) entries.push(...folderEntries(vault, `${root}/Notes`));
  const outside = (p) => !vault || !inside(vault, p);
  if (meetingsDir && outside(meetingsDir)) entries.push(...folderEntries(meetingsDir, `${root}/Meetings`));
  for (const s of meetingSources) {
    const p = typeof s === 'string' ? s : s?.path;
    if (!p || !outside(p) || (meetingsDir && inside(meetingsDir, p))) continue;
    entries.push(...folderEntries(p, `${root}/Meetings/${path.basename(p)}`));
  }
  if (chatsDir && existsSync(chatsDir)) {
    for (const f of readdirSync(chatsDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const abs = path.join(chatsDir, f);
      try { if (statSync(abs).isFile()) entries.push({ abs, name: `${root}/Chats/${f}` }); } catch {}
    }
  }
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

// writes the entries into a zip at `out`. A file that can no longer be read is skipped and counted. onProgress gets
// { done, total } after every file
export async function writeZip(entries, out, { onProgress = () => {} } = {}) {
  if (entries.length > MAX_ENTRIES) throw new Error(`That is more than ${MAX_ENTRIES.toLocaleString('en-US')} files, more than one archive can hold.`);
  const fh = await open(out, 'w');
  const central = [];
  let offset = 0, skipped = 0, done = 0;
  const write = async (buf) => { await fh.write(buf); offset += buf.length; };
  try {
    for (const e of entries) {
      let data, mtime;
      try { data = await readFile(e.abs); mtime = statSync(e.abs).mtime; } catch { skipped++; onProgress({ done: ++done, total: entries.length }); continue; }
      const crc = crc32(data);
      const packed = data.length ? await deflateRaw(data) : data;
      const deflated = packed.length < data.length;
      const body = deflated ? packed : data;
      const name = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(mtime);
      if (offset + 30 + name.length + body.length > MAX_BYTES) throw new Error('The notes add up to more than 4 GB, more than one archive can hold.');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(deflated ? 8 : 0, 8);
      local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      await write(local); await write(name); await write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(deflated ? 8 : 0, 10);
      c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name]));
      onProgress({ done: ++done, total: entries.length });
    }
    const start = offset;
    for (const c of central) await write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
    await fh.close();
    return { files: central.length, skipped, bytes: offset };
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(out, { force: true }).catch(() => {});
    throw err;
  }
}

// the name the save dialog offers: Quorum notes 2026-11-15.zip
export const exportFileName = (now = new Date()) => `Quorum notes ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.zip`;
