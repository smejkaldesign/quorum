// A small reader for zip archives held in memory, enough for importing a knowledge base (ee/kbImport.js). It lists
// entries from the central directory and inflates one entry at a time, so nothing from the archive touches the disk.
// It refuses an archive whose paths leave it (a ".." segment, an absolute path, a drive letter), one with more entries
// or more uncompressed bytes than the caps, and ZIP64 archives. Symbolic links and encrypted entries are listed with a
// flag so the caller skips them.
import zlib from 'node:zlib';

export const MAX_ENTRIES = 10000;
export const MAX_BYTES = 200 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(message) { super(message); this.code = 'ZIP'; }
}

// the entry's path with forward slashes and no empty or "." segments; null for a path that leaves the archive
export function safeEntryPath(raw) {
  const name = String(raw).split('\\').join('/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const segs = name.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

function findEnd(buf) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  return -1;
}

// every entry in the archive: { path, dir, symlink, encrypted, method, size, compressedSize, offset, crc }
export function listZip(buf, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('That file is not a zip archive.');
  if (buf.length > maxBytes) throw new ZipError(`The zip is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const end = findEnd(buf);
  if (end < 0) throw new ZipError('That file is not a zip archive.');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('The zip uses the ZIP64 format, which Quorum cannot read yet.');
  if (count > maxEntries) throw new ZipError(`The zip holds more than ${maxEntries.toLocaleString('en-US')} files.`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('The zip is damaged.');
  const entries = [];
  let total = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new ZipError('The zip is damaged.');
    const madeBy = buf.readUInt16LE(at + 4);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const offset = buf.readUInt32LE(at + 42);
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) throw new ZipError('The zip uses the ZIP64 format, which Quorum cannot read yet.');
    const raw = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    const p = safeEntryPath(raw);
    if (p === null) throw new ZipError('The zip has a file path that points outside it.');
    const unixMode = (madeBy >> 8) === 3 ? external >>> 16 : 0;
    const dir = raw.endsWith('/') || raw.endsWith('\\') || (external & 0x10) !== 0;
    total += size;
    if (total > maxBytes) throw new ZipError(`The zip holds more than ${Math.round(maxBytes / 1024 / 1024)} MB of files.`);
    if (!p) continue;
    entries.push({ path: p, dir, symlink: (unixMode & 0o170000) === 0o120000, encrypted: (flags & 1) === 1, method, size, compressedSize, offset, crc });
  }
  return entries;
}

// one entry's bytes, inflated and checked against its recorded size (and its CRC where node:zlib has crc32)
export function readEntry(buf, entry) {
  const at = entry.offset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new ZipError('The zip is damaged.');
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ZipError('The zip is damaged.');
  let out;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try { out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) }); } catch { throw new ZipError('The zip is damaged.'); }
  } else throw new ZipError('The zip uses a compression method Quorum cannot read.');
  if (out.length !== entry.size) throw new ZipError('The zip is damaged.');
  if (typeof zlib.crc32 === 'function' && (zlib.crc32(out) >>> 0) !== entry.crc) throw new ZipError('The zip is damaged.');
  return out;
}
