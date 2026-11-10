import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTranscript, transcript } from '../sources/granola.js';
import { notesWithout, syncTranscripts, transcriptMarkdown } from '../sources/transcripts.js';
import { ADAPTERS, EXTRAS, adapterFor } from '../sources/adapters.js';
import { SOURCES } from '../sources/catalog.js';

const page = (text, { truncated = false, next_offset = null, total = 10 } = {}) => ({ text: JSON.stringify({ content_advisory: 'data', meetings: [{ meeting_id: 'm1', truncated, next_offset, offset: 0, total_chars: total, recording_context: { recorder: { name: 'Alex Rivera' } }, transcript: text }] }) });

describe('granola transcripts', () => {
  it('reads one page of the transcript tool', () => {
    const r = parseTranscript(page('[0:00] Microphone: Hi.\n', { truncated: true, next_offset: 22, total: 900 }).text);
    expect(r).toMatchObject({ id: 'm1', truncated: true, nextOffset: 22, totalChars: 900, recorder: 'Alex Rivera' });
    expect(r.text).toContain('Hi.');
    expect(parseTranscript('not json')).toBeNull();
  });
  it('follows next_offset until the last page and keeps the recorder', async () => {
    const calls = [];
    const mcp = { call: async (name, args) => { calls.push(args.offset); return args.offset === 0 ? page('one ', { truncated: true, next_offset: 4 }) : page('two', { truncated: false }); } };
    const r = await transcript(mcp, 'm1');
    expect(r).toEqual({ text: 'one two', recorder: 'Alex Rivera' });
    expect(calls).toEqual([0, 4]);
  });
  it('reports a missing transcript as pending or final', async () => {
    const un = (reason) => ({ call: async () => ({ text: JSON.stringify({ meetings: [{ meeting_id: 'm1', transcript: null, transcript_unavailable: { reason } }] }) }) });
    expect(await transcript(un('transcript_pending'), 'm1')).toEqual({ text: null, unavailable: 'pending' });
    expect(await transcript(un('no_transcript'), 'm1')).toEqual({ text: null, unavailable: 'final' });
  });
});

describe('transcripts extra', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'quorum-transcripts-'));
    writeFileSync(path.join(dir, '2026-11-09-regroup.md'), '---\ngranola_id: m1\nsource_id: m1\ntitle: "Regroup"\ndate: 2026-11-09T13:00:00.000-08:00\nsource: granola\n---\n\n# Regroup\n');
    writeFileSync(path.join(dir, '2026-11-05-one-on-one.md'), '---\nsource_id: m2\ntitle: "1:1"\nsource: granola\n---\n\n# 1:1\n');
    writeFileSync(path.join(dir, '2026-11-01-done.md'), '---\nsource_id: m3\ntitle: "Done"\ntranscript: transcripts/2026-11-01-done.md\n---\n');
    writeFileSync(path.join(dir, 'README.md'), '# notes\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the notes without a transcript line', () => {
    expect(notesWithout(dir).map((n) => n.id).sort()).toEqual(['m1', 'm2']);
  });
  it('writes a sidecar per note, links it from the note, marks the ones the source will never have', async () => {
    const adapter = { sync: async () => {}, transcript: async (_mcp, id) => (id === 'm1' ? { text: '[0:00] Microphone: Hi.', recorder: 'Alex Rivera' } : { text: null, unavailable: 'final' }) };
    const progress = [];
    const written = [];
    const r = await syncTranscripts({ adapter, mcp: {}, dir, source: 'granola', progress: (p) => progress.push(p), afterWrite: (f) => written.push(path.basename(f)) });
    expect(r).toEqual({ checked: 2, saved: 1, failed: [] });
    const side = readFileSync(path.join(dir, 'transcripts', '2026-11-09-regroup.md'), 'utf8');
    expect(side).toContain('type: transcript');
    expect(side).toContain('transcript_of: m1');
    expect(side).toContain('title: "Regroup (transcript)"');
    expect(side).toContain('recorder: "Alex Rivera"');
    expect(side).toContain('# Regroup · Transcript');
    expect(readFileSync(path.join(dir, '2026-11-09-regroup.md'), 'utf8')).toMatch(/\ntranscript: transcripts\/2026-11-09-regroup\.md\n---/);
    expect(readFileSync(path.join(dir, '2026-11-05-one-on-one.md'), 'utf8')).toMatch(/\ntranscript: none\n---/);
    expect(existsSync(path.join(dir, 'transcripts', '2026-11-05-one-on-one.md'))).toBe(false);
    expect(written.sort()).toEqual(['2026-11-05-one-on-one.md', '2026-11-09-regroup.md', '2026-11-09-regroup.md']);
    expect(progress[0]).toMatchObject({ phase: 'transcripts', total: 2, done: 0 });
    expect(progress.at(-1)).toMatchObject({ done: 2 });
    // a second run has nothing left to ask for
    expect(notesWithout(dir)).toEqual([]);
  });
  it('keeps going when one transcript fails and reports it', async () => {
    const d2 = mkdtempSync(path.join(tmpdir(), 'quorum-transcripts-'));
    writeFileSync(path.join(d2, 'a.md'), '---\nsource_id: a\ntitle: "A"\n---\n');
    writeFileSync(path.join(d2, 'b.md'), '---\nsource_id: b\ntitle: "B"\n---\n');
    const adapter = { sync: async () => {}, transcript: async (_m, id) => { if (id === 'a') throw new Error('rate limited'); return { text: 'ok', recorder: null }; } };
    const r = await syncTranscripts({ adapter, mcp: {}, dir: d2, source: 'granola' });
    expect(r.saved).toBe(1);
    expect(r.failed).toEqual([{ id: 'a', title: 'A', error: 'rate limited' }]);
    rmSync(d2, { recursive: true, force: true });
  });
  it('renders a transcript note without a recorder or date', () => {
    const md = transcriptMarkdown({ id: 'x', title: null, date: null, source: 'wispr', recorder: null }, 'hello\n');
    expect(md).toContain('title: "Untitled meeting (transcript)"');
    expect(md).not.toContain('recorder:');
    expect(md).not.toContain('date:');
  });
});

describe('adapter contract', () => {
  it('every source in the catalog has an adapter with sync(), and one for each extra it lists', () => {
    for (const src of SOURCES) {
      const a = adapterFor(src);
      expect(typeof a.sync).toBe('function');
      for (const x of src.extras ?? []) expect(typeof a[EXTRAS[x].method], `${src.id} ${x}`).toBe('function');
    }
    expect(Object.keys(ADAPTERS)).toContain('granola');
  });
  it('refuses a source whose adapter is missing or cannot provide a listed extra', () => {
    expect(() => adapterFor({ id: 'nope', adapter: 'nope' })).toThrow(/No adapter/);
    expect(() => adapterFor({ id: 'half', adapter: 'granola', extras: ['attachments'] })).toThrow(/attachments/);
  });
});
