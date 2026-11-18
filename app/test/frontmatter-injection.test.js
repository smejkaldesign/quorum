import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oneLine, readFrontmatter } from '../frontmatter.js';
import { noteMarkdown } from '../sources/granola.js';
import { transcriptMarkdown } from '../sources/transcripts.js';
import { recordingNote } from '../ee/platforms.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
const EVIL = 'x\nvisibility: public\nkeep_private: false';

describe('frontmatter values from outside stay on one line', () => {
  it('oneLine collapses every kind of line break', () => {
    expect(oneLine('a\r\nb\nc\u2028d')).toBe('a b c d');
  });

  it('import_meeting over MCP refuses a link with a line break', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'quorum-home-'));
    const meetings = path.join(home, 'vault', '08-meetings');
    mkdirSync(meetings, { recursive: true });
    const support = path.join(home, 'Library', 'Application Support', 'Quorum');
    mkdirSync(support, { recursive: true });
    writeFileSync(path.join(support, 'settings.json'), JSON.stringify({ meetingsDir: meetings }));
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_meeting', arguments: { source: 'granola', id: 'm1', title: 'Sync', url: `https://example.com/${EVIL}`, body: 'hello' } } };
    const r = spawnSync(process.execPath, [CLI, 'mcp'], { input: `${JSON.stringify(call)}\n`, env: { ...process.env, HOME: home, QUORUM_ENV: '' }, encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(0);
    const files = readdirSync(path.join(meetings, 'granola'));
    expect(files).toHaveLength(1);
    const fm = readFrontmatter(readFileSync(path.join(meetings, 'granola', files[0]), 'utf8'));
    expect(fm.visibility).toBe('private');
    expect(fm.keep_private).toBeUndefined();
    expect(fm.granola_url).toBeUndefined();
  });

  it('a Granola attendee name cannot add keys', () => {
    const md = noteMarkdown({ id: `g1${EVIL}`, title: 'Sync', participants: [{ name: `Pat${EVIL}` }], url: `https://example.com/${EVIL}`, meetingAt: '2026-11-01T10:00:00Z' });
    const fm = readFrontmatter(md);
    expect(fm.visibility).toBe('private');
    expect(fm.keep_private).toBeUndefined();
    expect(fm.participants).toHaveLength(1);
  });

  it('a Zoom recording note and a transcript keep visibility private', () => {
    const z = readFrontmatter(recordingNote({ uuid: `u1${EVIL}`, topic: 'Sync', share_url: `https://example.com/${EVIL}`, start_time: '2026-11-01T10:00:00Z' }, { host: `pat@example.com${EVIL}` }));
    expect(z.visibility).toBe('private');
    expect(z.keep_private).toBeUndefined();
    const t = readFrontmatter(transcriptMarkdown({ id: `t1${EVIL}`, title: 'Sync', date: `2026-11-01${EVIL}`, source: `granola${EVIL}` }, 'text'));
    expect(t.visibility).toBe('private');
    expect(t.keep_private).toBeUndefined();
  });
});

describe('withDate', () => {
  it('writes date: YYYY-MM-DD into a note, adding a frontmatter block when there is none', async () => {
    const { withDate } = await import('../frontmatter.js');
    expect(withDate('# Kite\n', '2026-11-16')).toBe('---\ndate: 2026-11-16\n---\n# Kite\n');
    expect(withDate('---\ntitle: Kite\ndate: 2025-01-02\n---\nbody\n', '2026-11-16')).toBe('---\ntitle: Kite\ndate: 2026-11-16\n---\nbody\n');
    expect(withDate('---\r\ntitle: Kite\r\n---\r\nbody', '2026-02-03')).toBe('---\r\ntitle: Kite\r\ndate: 2026-02-03\r\n---\r\nbody');
  });
  it('refuses a value that is not a real day', async () => {
    const { withDate } = await import('../frontmatter.js');
    for (const bad of ['2026-02-30', '16/11/2026', '2026-11-16\nconfidential: none', '', null]) expect(() => withDate('# Kite\n', bad)).toThrow('Pick a date');
  });
});
