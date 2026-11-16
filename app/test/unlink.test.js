import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unlinkTarget } from '../relink.js';

describe('unlinkTarget', () => {
  it('takes every link to the missing note out and keeps its words', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'quorum-unlink-'));
    writeFileSync(path.join(vault, 'a.md'), '- [[gone-note]] - Pod Connect\n- [[keep]] stays\nSee [[sub/gone-note#part|the old deck]].\n');
    expect(unlinkTarget({ vault, sources: ['a.md'], target: 'gone-note' })).toEqual({ files: 1, links: 1 });
    expect(unlinkTarget({ vault, sources: ['a.md'], target: 'sub/gone-note' })).toEqual({ files: 1, links: 1 });
    expect(readFileSync(path.join(vault, 'a.md'), 'utf8')).toBe('- gone-note - Pod Connect\n- [[keep]] stays\nSee the old deck.\n');
  });
});
