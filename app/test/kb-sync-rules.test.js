import { describe, expect, it } from 'vitest';
// the relay's sync worker writes KB notes with its own copy of the app's note rules (relay/kbSync/rules.js); these
// checks keep the two giving the same results
const relay = await import('../../relay/kbSync/rules.js');
const { dropFalseConfidential, fmValue, isConfidential, keyOf, safeSeg, sharedText } = await import('../ee/kbImport.js');
const { driveNoteText, noteFileName } = await import('../ee/kbDrive.js');
const { parseFrontmatter } = await import('../ee/sync.js');
const { setFrontmatterKey } = await import('../frontmatter.js');

const TEXTS = [
  '# Plan\n\nBody',
  '---\ntitle: "Quarterly plan"\nconfidential: false\n---\n# Plan',
  '---\r\nowner: ops\r\n---\r\nWindows lines',
  '---\nconfidential: finance\n---\nPay bands',
  '---\n---\nEmpty block',
  '',
];

describe('the relay keeps the app\'s KB note rules', () => {
  it('shares, names the source and reads confidential the same way', () => {
    for (const t of TEXTS) {
      expect(relay.sharedText(t, 'google-drive:abc')).toBe(sharedText(t, 'google-drive:abc'));
      expect(relay.dropFalseConfidential(t)).toBe(dropFalseConfidential(t));
      expect(relay.parseFrontmatter(t)).toEqual(parseFrontmatter(t));
      expect(relay.setFrontmatterKey(t, 'kb_source', 'x')).toBe(setFrontmatterKey(t, 'kb_source', 'x'));
      expect(relay.isConfidential(relay.parseFrontmatter(t))).toBe(isConfidential(parseFrontmatter(t)));
    }
    for (const v of ['plain', 'has: colon', 'https://github.com/o/r/blob/main/a b.md', 'quote"d', 'line\nbreak']) expect(relay.fmValue(v)).toBe(fmValue(v));
    for (const s of ['a/b:c', '  ', 'Plan.md', 'x'.repeat(100)]) {
      expect(relay.safeSeg(s)).toBe(safeSeg(s));
      expect(relay.noteFileName(s)).toBe(noteFileName(s));
    }
    expect(relay.keyOf(['A ', 'b'])).toBe(keyOf(['A ', 'b']));
  });

  it('writes a synced Drive note as kbDrive does, plus the attachment it belongs to', () => {
    const meta = { id: 'f1', name: 'Leave policy', url: 'https://drive.google.com/file/d/f1', modifiedTime: '2026-11-12T00:00:00.000Z' };
    for (const text of TEXTS) {
      const app = dropFalseConfidential(driveNoteText({ text, meta, syncedAt: '2026-11-13T00:00:00.000Z' }));
      const synced = relay.syncedNoteText({ text, source: 'google-drive:f1', attachmentId: '01JD00000000000000000000A1', name: meta.name, url: meta.url, syncedAt: '2026-11-13T00:00:00.000Z', modified: meta.modifiedTime, where: 'Google Drive' });
      expect(synced.replace(/\r?\nkb_attachment: 01JD00000000000000000000A1/, '')).toBe(app);
      expect(relay.parseFrontmatter(synced).kb_attachment).toBe('01JD00000000000000000000A1');
    }
  });
});
