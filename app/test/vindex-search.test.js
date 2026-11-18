// vindex.js search keeps no lowercased copy of the notes; it must answer exactly as the version that searched a
// lowercased copy of each note's path and text (reference below)
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXOTIC, createVaultIndex } from '../vindex.js';

let vault;
afterEach(() => { if (vault) rmSync(vault, { recursive: true, force: true }); vault = null; });

// the search as it was, over the same notes
function reference(notes, q, limit = 30) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = [];
  for (const { rel, text, title: t } of notes) {
    const title = t.toLowerCase();
    const hay = `${rel.toLowerCase()}\n${text.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w) || title.includes(w))) continue;
    let score = 0;
    for (const w of words) { if (title.includes(w)) score += 10; if (rel.toLowerCase().includes(w)) score += 4; }
    const lines = text.split('\n');
    const n = lines.findIndex((l) => words.some((w) => l.toLowerCase().includes(w)));
    score += Math.min(5, words.reduce((s, w) => s + (hay.split(w).length - 1), 0) / 4);
    hits.push({ rel, title: t, score, line: n, snippet: n >= 0 ? lines[n].trim().slice(0, 200) : '' });
  }
  return hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel)).slice(0, limit);
}

const FIXTURE = {
  'Projects/Alpha Plan.md': '---\ntitle: Alpha\n---\n# Alpha Plan\n\nThe ALPHA plan covers the alpha launch.\nSee [[Beta]] and the the the.\n',
  'projects/beta.md': '# Beta\r\nBeta notes with CRLF lines\r\nand a café visit \u2014 then more.\r\n',
  'notes/kelvin.md': '# Kelvin\n\nTemperature in Kelvin and İstanbul trips.\nkelvin again\n',
  'notes/greek.md': '# Greek\n\nΟΔΟΣ and ΣΊΣΥΦΟΣ, odos.\nσ ς Σ\n',
  'notes/emoji.md': '# Emoji 🎉\n\nParty 🎉 time. C++ and (x) and a.b.c regex chars [x] $1 ^\n',
  'notes/aaa.md': '# Repeats\n\naaaa aaaa aaa\n' + 'the '.repeat(200) + '\n',
  'deep/folder/Title Only.md': '---\ntitle: Zebra Crossing\n---\nnothing here\n',
  'deep/folder/empty.md': '',
  'big.md': Array.from({ length: 3000 }, (_, i) => `Line ${i} with word${i % 7} and Mixed CASE text`).join('\n'),
  'unicode/ẞharp.md': '# Straße\n\nSTRASSE Straße ẞ ß\nDotless ı and I and i\n',
};
const QUERIES = ['alpha', 'ALPHA plan', 'the', 'the the', 'beta', 'crlf', 'café', 'CAFÉ', '\u2014', 'kelvin', 'k', 'i', 'istanbul', 'i̇stanbul', 'σ', 'οδος', 'ς', 'odos',
  '🎉', 'party', 'c++', '(x)', 'a.b.c', '[x]', '$1', '^', 'aa', 'aaa', 'zebra', 'crossing', 'projects', 'folder', 'word3', 'line 29', 'mixed case', 'straße', 'strasse', 'ß', 'ı', 'nothing',
  'missingword', '', '   ', 'md', '.md', '/'];

describe('search without a lowercased copy', () => {
  it('lists only U+0130 and U+212A as characters whose lowercase holds ASCII', () => {
    const found = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      const low = c.toLowerCase();
      for (let i = 0; i < low.length; i++) if (low.charCodeAt(i) < 0x80) { found.push(cp); break; }
    }
    expect(found).toEqual([0x130, 0x212a]);
    expect(found.every((cp) => EXOTIC.test(String.fromCodePoint(cp)))).toBe(true);
  });
  it('answers every query exactly as the lowercased search did', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-search-'));
    for (const [rel, text] of Object.entries(FIXTURE)) { mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); writeFileSync(path.join(vault, rel), text); }
    const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    index.sync();
    const notes = index.snapshot().map(({ rel, text, note }) => ({ rel, text, title: note.title }));
    expect(notes.length).toBe(Object.keys(FIXTURE).length);
    for (const q of QUERIES) {
      for (const limit of [30, 1000]) expect(index.search(q, limit), q).toEqual(reference(notes, q, limit));
    }
    expect(index.search('the', 1000).find((h) => h.rel === 'notes/aaa.md').score).toBe(reference(notes, 'the', 1000).find((h) => h.rel === 'notes/aaa.md').score);
  });
  it('takes backlink lines from the note text', () => {
    vault = mkdtempSync(path.join(tmpdir(), 'vindex-search-'));
    writeFileSync(path.join(vault, 'a.md'), '# A\n\nfirst\n  see [[b]] here  \nlast');
    writeFileSync(path.join(vault, 'b.md'), '# B');
    const index = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
    index.sync();
    expect(index.backlinks('b.md')).toEqual([{ rel: 'a.md', title: 'A', line: 3, context: 'see [[b]] here' }]);
  });
});
