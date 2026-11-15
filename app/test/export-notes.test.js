import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { collectExport, crc32, exportFileName, writeZip } from '../exportNotes.js';
import { listZip, readEntry as readZipEntry } from '../ee/zipRead.js';

const put = (root, rel, text = `# ${rel}\n`) => { const abs = path.join(root, ...rel.split('/')); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); return abs; };
const tmp = () => mkdtempSync(path.join(tmpdir(), 'quorum-export-'));

describe('collectExport', () => {
  it('takes the vault notes, meeting folders outside the vault and the chats, without hidden folders or other files', () => {
    const root = tmp();
    const vault = path.join(root, 'vault'), outside = path.join(root, 'elsewhere'), manual = path.join(root, 'granola-export'), chats = path.join(root, 'chats');
    put(vault, 'Ideas/plan.md'); put(vault, '08-meetings/quorum/standup.md'); put(vault, '.obsidian/workspace.md'); put(vault, 'image.png', 'x');
    put(outside, 'quorum/review.md'); put(manual, 'call.md');
    put(chats, '01CHAT.json', '{"id":"01CHAT"}'); put(chats, 'notes.txt', 'x');
    const names = collectExport({ vault, meetingsDir: outside, meetingSources: [{ path: manual }, { path: path.join(outside, 'quorum') }, { path: path.join(vault, '08-meetings') }], chatsDir: chats }).map((e) => e.name).sort();
    expect(names).toEqual([
      'Quorum export/Chats/01CHAT.json',
      'Quorum export/Meetings/granola-export/call.md',
      'Quorum export/Meetings/quorum/review.md',
      'Quorum export/Notes/08-meetings/quorum/standup.md',
      'Quorum export/Notes/Ideas/plan.md',
    ]);
  });
  it('a meetings folder inside the vault is not taken twice, and nothing connected gives nothing', () => {
    const vault = tmp();
    put(vault, '08-meetings/a.md');
    expect(collectExport({ vault, meetingsDir: path.join(vault, '08-meetings') }).map((e) => e.name)).toEqual(['Quorum export/Notes/08-meetings/a.md']);
    expect(collectExport({})).toEqual([]);
  });
});

describe('writeZip', () => {
  it('writes an archive that reads back with the same names and bytes, and reports progress', async () => {
    const dir = tmp();
    const big = '# Long note\n\n' + 'The same line again. '.repeat(400);
    const entries = [
      { abs: put(dir, 'a.md', big), name: 'Quorum export/Notes/a.md' },
      { abs: put(dir, 'é.md', '# Café\n'), name: 'Quorum export/Notes/Café é.md' },
      { abs: put(dir, 'empty.md', ''), name: 'Quorum export/Notes/empty.md' },
      { abs: path.join(dir, 'gone.md'), name: 'Quorum export/Notes/gone.md' },
    ];
    const seen = [];
    const out = path.join(dir, 'out.zip');
    const r = await writeZip(entries, out, { onProgress: (p) => seen.push(p) });
    expect(r).toMatchObject({ files: 3, skipped: 1 });
    expect(seen.at(-1)).toEqual({ done: 4, total: 4 });
    const buf = readFileSync(out);
    const listed = listZip(buf);
    expect(listed.map((e) => e.path)).toEqual(['Quorum export/Notes/a.md', 'Quorum export/Notes/Café é.md', 'Quorum export/Notes/empty.md']);
    expect(readZipEntry(buf, listed[0]).toString('utf8')).toBe(big);
    expect(readZipEntry(buf, listed[1]).toString('utf8')).toBe('# Café\n');
    expect(readZipEntry(buf, listed[2]).length).toBe(0);
    // the long note was compressed, the short ones stored
    expect(buf.length).toBeLessThan(big.length);
  });
  it('refuses more files than a plain zip holds, before writing anything', async () => {
    const dir = tmp();
    const many = Array.from({ length: 70000 }, (_, i) => ({ abs: '/nope', name: `n${i}.md` }));
    await expect(writeZip(many, path.join(dir, 'x.zip'))).rejects.toThrow(/more than one archive can hold/);
  });
});

it('crc32 matches node:zlib', () => {
  const b = Buffer.from('Quorum export');
  if (typeof zlib.crc32 === 'function') expect(crc32(b)).toBe(zlib.crc32(b));
  expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
});

it('names the file by the day', () => {
  expect(exportFileName(new Date(2026, 10, 5))).toBe('Quorum notes 2026-11-05.zip');
});
