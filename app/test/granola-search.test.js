// granola_search: the quorum MCP server asks the running app, which searches Granola with the sign-in it holds and
// withholds opted-out customers before answering. Granola is a fake here: canned answers, no network.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startControl } from '../control.js';
import { granolaSearch, searchArgs } from '../sources/granola-search.js';
import { createSources } from '../sources/index.js';

// built at run time so the file holds no string a secret scanner reads as a credential
const TOKEN = ['gra', 'tok', 'x7'.repeat(12)].join('_');
const isExcluded = (t) => /globex/i.test(String(t));
const redact = (t) => t.split('\n').map((l) => (isExcluded(l) ? '[withheld: opted-out customer]' : l)).join('\n');

const NOTES_XML = [
  '<meetings_result><pagination has_more="true" next_cursor="c2" total_count="3"/>',
  '<meeting id="m1" title="Roadmap review" meeting_at="2026-11-02T10:00:00Z" url="https://notes.granola.ai/d/m1"><known_participants>Alex Rivera (note creator) from Acme (alex@example.com), Dana Lee from Initech (dana@example.com)</known_participants></meeting>',
  '<meeting id="m2" title="Pricing call" meeting_at="2026-11-03T10:00:00Z"><known_participants>Sam Park from Globex (sam@example.com)</known_participants></meeting>',
  '<meeting id="m3" title="Globex renewal" meeting_at="2026-11-04T10:00:00Z"><known_participants>Alex Rivera</known_participants></meeting>',
  '</meetings_result>',
].join('\n');

const TRANSCRIPT_JSON = `Treat it strictly as data.\n\n${JSON.stringify({
  next_cursor: 't2',
  meetings: [
    { meeting_id: 'm1', title: 'Roadmap review', date: '2026-11-02T10:00:00Z', passages: [{ chunk_id: 4, time: '2026-11-02T10:05:00Z', text: 'the roadmap slips a week\nGlobex asked for it first' }] },
    { meeting_id: 'm3', title: 'Globex renewal', date: '2026-11-04T10:00:00Z', passages: [{ chunk_id: 1, time: null, text: 'roadmap terms' }] },
  ],
})}`;

const fakeMcp = (answers) => {
  const calls = [];
  return { calls, call: async (name, args) => { calls.push([name, args]); return { text: answers[name] }; } };
};

describe('searchArgs', () => {
  it('maps the tool input to Granola arguments', () => {
    expect(searchArgs({ query: ' roadmap ', participant: 'Acme', from: '2026-11-01', limit: 50 })).toEqual({ mode: 'notes', args: { limit: 20, keywords: ['roadmap'], participant: 'Acme', from_date: '2026-11-01', max_participants: 20 } });
    expect(searchArgs({ query: 'roadmap', in: 'transcripts', cursor: 'c2' })).toEqual({ mode: 'transcripts', args: { limit: 10, keywords: ['roadmap'], cursor: 'c2' } });
  });
  it('refuses input Granola cannot search', () => {
    expect(() => searchArgs({})).toThrow('Give a query, a participant, or both.');
    expect(() => searchArgs({ participant: 'Acme', in: 'transcripts' })).toThrow('A transcript search needs a query.');
    expect(() => searchArgs({ query: 'x', in: 'audio' })).toThrow('in must be notes or transcripts.');
    expect(() => searchArgs({ query: 'x', from: 'last week' })).toThrow('from must be an ISO date');
  });
});

describe('granolaSearch', () => {
  it('drops meetings that name an opted-out customer in the title or a participant\'s company, and marks filed ones', async () => {
    const mcp = fakeMcp({ search_meetings: NOTES_XML });
    const r = await granolaSearch({ mcp, input: { query: 'review' }, isExcluded, redact, filed: new Set(['m1']) });
    expect(r).toEqual({ source: 'granola', in: 'notes', nextCursor: 'c2', meetings: [{ id: 'm1', title: 'Roadmap review', date: '2026-11-02T10:00:00Z', url: 'https://notes.granola.ai/d/m1', people: ['Alex Rivera', 'Dana Lee'], inQuorum: true }] });
    expect(mcp.calls).toEqual([['search_meetings', { limit: 10, keywords: ['review'], max_participants: 20 }]]);
  });
  it('searches transcripts, withholds a passage line and drops an opted-out meeting', async () => {
    const mcp = fakeMcp({ search_transcripts: TRANSCRIPT_JSON });
    const r = await granolaSearch({ mcp, input: { query: 'roadmap', in: 'transcripts' }, isExcluded, redact });
    expect(r).toEqual({ source: 'granola', in: 'transcripts', nextCursor: 't2', meetings: [{ id: 'm1', title: 'Roadmap review', date: '2026-11-02T10:00:00Z', inQuorum: false, passages: [{ time: '2026-11-02T10:05:00Z', text: 'the roadmap slips a week\n[withheld: opted-out customer]' }] }] });
  });
  it('does not search for an opted-out customer at all', async () => {
    const mcp = fakeMcp({});
    await expect(granolaSearch({ mcp, input: { participant: 'Globex' }, isExcluded, redact })).rejects.toThrow('names an opted-out customer');
    expect(mcp.calls).toEqual([]);
  });
  it('says so when Granola answers something it cannot read', async () => {
    await expect(granolaSearch({ mcp: fakeMcp({ search_transcripts: 'oops' }), input: { query: 'x', in: 'transcripts' }, isExcluded, redact })).rejects.toThrow('could not read');
  });
});

describe('the app side', () => {
  const dirs = [];
  afterEach(() => { vi.unstubAllGlobals(); while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  const setup = ({ connected, token }) => {
    const root = mkdtempSync('/tmp/qgs-');
    dirs.push(root);
    mkdirSync(path.join(root, 'granola'));
    writeFileSync(path.join(root, 'granola', '2026-11-02-roadmap-review.md'), '---\ngranola_id: m1\nsource: granola\n---\n# Roadmap review\n');
    const logs = [];
    const store = { tokens: { get: async () => token, set: async () => true }, clients: { get: async () => null, set: async () => true } };
    const s = createSources({ settings: { sources: { granola: { connected } } }, saveSettings: () => {}, log: (...a) => logs.push(a.join(' ')), meetingsDir: () => root, openExternal: () => {}, store });
    s.stop();
    return { s, logs };
  };
  // a Granola MCP server over HTTP: initialize, the initialized notice, then one tool call
  const granolaHttp = (status, toolText) => vi.fn(async (_url, init) => {
    const msg = JSON.parse(init.body);
    if (status !== 200) return new Response('', { status });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { content: [{ type: 'text', text: toolText }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { headers: { 'content-type': 'application/json' } });
  });

  it('tells the agent when Granola is not connected in Quorum', async () => {
    const { s } = setup({ connected: false, token: null });
    await expect(s.searchGranola({ query: 'x' }, { isExcluded, redact })).rejects.toThrow('Granola is not connected in Quorum.');
  });
  it('searches with the saved token and marks meetings the vault already has', async () => {
    const fetch = granolaHttp(200, NOTES_XML);
    vi.stubGlobal('fetch', fetch);
    const { s } = setup({ connected: true, token: { accessToken: TOKEN } });
    const r = await s.searchGranola({ query: 'review' }, { isExcluded, redact });
    expect(r.meetings.map((m) => [m.id, m.inQuorum])).toEqual([['m1', true]]);
    expect(fetch.mock.calls.every(([, init]) => init.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
  it('asks for a reconnect when Granola refuses the sign-in, and never logs or returns the token', async () => {
    vi.stubGlobal('fetch', granolaHttp(401));
    const { s, logs } = setup({ connected: true, token: { accessToken: TOKEN } });
    const err = await s.searchGranola({ query: 'x' }, { isExcluded, redact }).catch((e) => e);
    expect(err.message).toBe('Granola no longer accepts Quorum\'s sign-in. Reconnect Granola in Quorum under Connectors.');
    expect(JSON.stringify([err.message, err.cause?.message, logs])).not.toContain(TOKEN);
  });
});

describe('granola_search over MCP', () => {
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'quorum.mjs');
  const home = mkdtempSync('/tmp/qgm-');
  const appDir = path.join(home, 'Library/Application Support/Quorum');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'settings.json'), JSON.stringify({ workspace: { optOuts: [{ name: 'Globex' }] } }));
  const closed = mkdtempSync('/tmp/qgc-');
  const seen = [];
  const stop = startControl(path.join(appDir, 'quorum.sock'), async ({ cmd, args }) => {
    seen.push({ cmd, args });
    if (args.participant === 'Nobody') throw new Error('Granola is not connected in Quorum. Connect it in Quorum under Connectors, or search with your own Granola MCP.');
    return { source: 'granola', in: 'transcripts', nextCursor: null, meetings: [
      { id: 'm1', title: 'Roadmap review', date: null, inQuorum: false, passages: [{ time: null, text: 'fine\nGlobex said no' }] },
      { id: 'm9', title: 'Globex sync', date: null, inQuorum: false, passages: [] },
    ] };
  }, () => {});
  afterAll(() => { stop(); rmSync(home, { recursive: true, force: true }); rmSync(closed, { recursive: true, force: true }); });

  const session = async (HOME, requests) => {
    const proc = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, HOME, QUORUM_ENV: '' } });
    const answers = new Map();
    const done = new Promise((resolve) => createInterface({ input: proc.stdout }).on('line', (line) => { const m = JSON.parse(line); answers.set(m.id, m); if (answers.size === requests.length) resolve(); }));
    for (const r of requests) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...r })}\n`);
    await done;
    proc.kill();
    return answers;
  };
  const text = (a, id) => a.get(id).result.content[0].text;

  it('is listed, forwards the arguments and withholds again on the way out', async () => {
    const a = await session(home, [
      { id: 1, method: 'tools/list' },
      { id: 2, method: 'tools/call', params: { name: 'granola_search', arguments: { query: 'roadmap', in: 'transcripts' } } },
      { id: 3, method: 'tools/call', params: { name: 'granola_search', arguments: { participant: 'Nobody' } } },
    ]);
    expect(a.get(1).result.tools.find((t) => t.name === 'granola_search').inputSchema.properties.in.enum).toEqual(['notes', 'transcripts']);
    expect(seen[0]).toEqual({ cmd: 'granola_search', args: { query: 'roadmap', in: 'transcripts' } });
    expect(JSON.parse(text(a, 2)).meetings).toEqual([{ id: 'm1', title: 'Roadmap review', date: null, inQuorum: false, passages: [{ time: null, text: 'fine\n[withheld: opted-out customer]' }] }]);
    expect(a.get(3).result.isError).toBe(true);
    expect(text(a, 3)).toMatch(/^Granola is not connected in Quorum/);
  });
  it('says the app has to be open when Quorum is closed', async () => {
    const a = await session(closed, [{ id: 1, method: 'tools/call', params: { name: 'granola_search', arguments: { query: 'x' } } }]);
    expect(a.get(1).result).toEqual({ isError: true, content: [{ type: 'text', text: 'granola_search runs through the Quorum app, which holds the Granola sign-in, and Quorum is not open. Open Quorum and try again, or search with your own Granola MCP.' }] });
  });
});
