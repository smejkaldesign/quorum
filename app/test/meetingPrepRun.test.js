import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PASS_CAP, backoffMs, createPrepCache, createPrepRunner } from '../meetingPrepRun.js';
import { prepRel } from '../meetingPrep.js';

const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' };
const sam = { name: 'Sam Lee', email: 'sam@example.com' };
const kim = { name: 'Kim Park', email: 'kim@example.com' };
const T0 = Date.now();
const soon = (h = 1) => new Date(T0 + h * 3600000).toISOString();
const event = (over = {}) => ({ id: 'e1', title: 'Acme roadmap review', start: soon(1), end: soon(2), attendees: [jane, sam, kim], url: 'https://zoom.us/j/85012345678?pwd=FAKEpw1', notes: '', ...over });
const REPLY = JSON.stringify({ people: [{ name: 'Jane Doe', summary: 'Leads the roadmap.', refs: [1] }], talking: [{ text: 'Confirm the launch date.', refs: [1] }], watch: [] });

let dir, vault;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'quorum-prep-'));
  vault = path.join(dir, 'vault');
  mkdirSync(path.join(vault, 'Daily'), { recursive: true });
  writeFileSync(path.join(vault, 'Jane notes.md'), 'Jane Doe owns the Acme roadmap. Launch date is open.\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// a runner on the temp vault with a fake model and calendar; counts what it calls
function setup({ on = true, reply = REPLY, events = [event()], conf = { enabled: true, ahead: 24, minInvitees: 3, orNew: true }, now } = {}) {
  const seen = { model: 0, calendar: 0, prompts: [] };
  const d = {
    on: () => on,
    conf: () => conf,
    brain: () => ({ vault, agentDoc: () => '' }),
    snapshot: () => readdirSync(vault).filter((f) => f.endsWith('.md')).map((f) => ({ rel: f, note: { title: f.replace(/\.md$/, '') }, text: readFileSync(path.join(vault, f), 'utf8') })),
    search: () => [],
    meetings: () => [],
    isMe: (a) => a.self === true,
    mentionsOptOut: (t) => /globex/i.test(String(t ?? '')),
    onNeverList: () => false,
    isExcluded: () => false,
    redact: (t) => t,
    modelReady: () => true,
    async runModel(prompt) { seen.model += 1; seen.prompts.push(prompt); await new Promise((r) => setTimeout(r, 5)); return typeof reply === 'function' ? reply() : reply; },
    async events() { seen.calendar += 1; return { events: typeof events === 'function' ? events() : events }; },
    listed: (_e, platform) => !!platform,
    folders: () => ({ daily: 'Daily', meetings: null }),
    owner: () => 'Alex',
    about: () => '',
    write: (abs, text) => writeFileSync(abs, text),
    cache: createPrepCache(path.join(dir, 'meeting-preps.json')),
    ...(now ? { now } : {}),
  };
  return { run: createPrepRunner(d), seen, d };
}
const prepFiles = () => (existsSync(path.join(vault, 'Daily/prep')) ? readdirSync(path.join(vault, 'Daily/prep')).sort() : []);

describe('off', () => {
  it('reads no calendar and calls no model while off', async () => {
    const { run, seen } = setup({ on: false });
    await run.prepAhead();
    expect(await run.prepFor(event(), { generate: true })).toEqual({ status: 'off' });
    expect(seen).toMatchObject({ model: 0, calendar: 0 });
    expect(prepFiles()).toEqual([]);
  });
});

describe('writing the note', () => {
  it('writes once, then answers from the cache while the invite is unchanged', async () => {
    const { run, seen } = setup();
    const r = await run.prepFor(event(), { generate: true });
    expect(r.status).toBe('ready');
    expect(readFileSync(r.file, 'utf8')).toContain('Confirm the launch date.');
    expect((await run.prepFor(event(), { generate: true })).status).toBe('ready');
    expect(seen.model).toBe(1);
  });
  it('saves a join link without its passcode', async () => {
    const { run } = setup();
    const r = await run.prepFor(event({ url: '', notes: 'Join: https://teams.live.com/meet/9381234567890?p=FAKEpw2' }), { generate: true });
    const text = readFileSync(r.file, 'utf8');
    expect(text).toContain('[Join on Teams](https://teams.live.com/meet/9381234567890)');
    expect(text).not.toContain('FAKEpw2');
  });
  it('leaves you out of the invitees by the calendar self flag', async () => {
    const { run, seen } = setup();
    await run.prepFor(event({ attendees: [{ name: 'Me Alias', email: 'me.alias@example.com', self: true }, jane, sam, kim] }), { generate: true });
    expect(seen.prompts[0]).not.toContain('me.alias@example.com');
  });
  it('writes no file for an event whose description names an opted-out customer', async () => {
    const { run, seen } = setup();
    expect((await run.prepFor(event({ notes: 'Agenda: Globex renewal' }), { generate: true })).status).toBe('opted-out');
    expect(seen.model).toBe(0);
    expect(prepFiles()).toEqual([]);
  });
});

describe('the person owns the note', () => {
  it('never writes over an edited note, even when the invite changes', async () => {
    const { run, seen } = setup();
    const first = await run.prepFor(event(), { generate: true });
    writeFileSync(first.file, 'my own notes\n');
    const auto = await run.prepFor(event({ title: 'Acme roadmap review v2' }), { generate: true, auto: true });
    expect(auto).toMatchObject({ status: 'changed', edited: true });
    const opened = await run.prepFor(event(), { generate: true });
    expect(opened).toMatchObject({ status: 'ready', edited: true, markdown: 'my own notes\n' });
    expect(readFileSync(first.file, 'utf8')).toBe('my own notes\n');
    expect(seen.model).toBe(1);
  });
  it('Prepare again beside an edited note writes a new note and keeps the edit', async () => {
    const { run } = setup();
    const first = await run.prepFor(event(), { generate: true });
    writeFileSync(first.file, 'my own notes\n');
    const again = await run.prepFor(event(), { force: true });
    expect(again.status).toBe('ready');
    expect(again.file).not.toBe(first.file);
    expect(readFileSync(first.file, 'utf8')).toBe('my own notes\n');
    expect(prepFiles()).toHaveLength(2);
  });
  it('never writes over a file Quorum did not write', async () => {
    const { run } = setup();
    const taken = path.join(vault, prepRel({ daily: 'Daily', event: event() }));
    mkdirSync(path.dirname(taken), { recursive: true });
    writeFileSync(taken, 'someone else\n');
    const r = await run.prepFor(event(), { generate: true });
    expect(r.file).not.toBe(taken);
    expect(readFileSync(taken, 'utf8')).toBe('someone else\n');
  });
  it('gives two same-title events on one day their own notes', async () => {
    const { run } = setup();
    await run.prepFor(event({ id: 'a', title: '1:1' }), { generate: true });
    await run.prepFor(event({ id: 'b', title: '1:1' }), { generate: true });
    expect(prepFiles()).toHaveLength(2);
  });
  it('does not bring back a note the person deleted unless asked', async () => {
    const { run, seen } = setup();
    const first = await run.prepFor(event(), { generate: true });
    rmSync(first.file);
    await run.prepAhead();
    expect((await run.prepFor(event(), { generate: true })).status).toBe('dismissed');
    expect(prepFiles()).toEqual([]);
    expect(seen.model).toBe(1);
    expect((await run.prepFor(event(), { force: true })).status).toBe('ready');
    expect(prepFiles()).toHaveLength(1);
  });
});

describe('model calls', () => {
  it('backs off after a failed reply instead of calling every pass', async () => {
    let t = Date.now();
    const { run, seen } = setup({ reply: 'not json', now: () => t });
    await run.prepAhead();
    await run.prepAhead();
    expect(seen.model).toBe(1);
    t += backoffMs(1) + 1000;
    await run.prepAhead();
    expect(seen.model).toBe(2);
    await run.prepAhead();
    expect(seen.model).toBe(2);
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
    expect(backoffMs(99)).toBe(6 * 3600000);
  });
  it('caps model calls per pass', async () => {
    const many = Array.from({ length: PASS_CAP + 4 }, (_, i) => event({ id: `e${i}` }));
    const { run, seen } = setup({ events: many });
    await run.prepAhead();
    expect(seen.model).toBe(PASS_CAP);
    await run.prepAhead();
    expect(seen.model).toBe(PASS_CAP + 4);
  });
  it('runs one write per event at a time', async () => {
    const { run, seen } = setup();
    const [a, b] = await Promise.all([run.prepFor(event(), { generate: true }), run.prepFor(event(), { force: true })]);
    expect(seen.model).toBe(1);
    expect(a).toBe(b);
    expect(prepFiles()).toHaveLength(1);
  });
  it('prepares Webex calls ahead', async () => {
    const { run, seen } = setup({ events: [event({ url: 'https://acme.webex.com/meet/jdoe' })] });
    await run.prepAhead();
    expect(seen.model).toBe(1);
    expect(readFileSync(path.join(vault, 'Daily/prep', prepFiles()[0]), 'utf8')).toContain('[Join on Webex](https://acme.webex.com/meet/jdoe)');
  });
  it('skips plain calendar entries in the pass', async () => {
    const { run, seen } = setup({ events: [event({ url: '', notes: '' })] });
    await run.prepAhead();
    expect(seen.model).toBe(0);
  });
});
