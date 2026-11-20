import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { cleanIssueReport, createReportPurge, GLOBAL_PER_HOUR, imageType, LIMITS, MAX_REPORT_BODY, MAX_SHOT_BYTES, ORPHAN_AGE_MS, reportShotsRoute, reportsRoute, storedIssueReport } from '../reports.js';
import { hashInstall } from '../errors.js';
import { RelayError } from '../lib/auth.js';
import { createLimiter } from '../platform.js';
import { fakeAnon } from './helpers.js';

const INSTALL = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const ID = '7d1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const now = Date.parse('2026-11-19T12:00:00Z');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const GIF = Buffer.from('GIF89a0000000000');
const shot = (buf) => ({ data: buf.toString('base64') });
const report = (over = {}) => ({ install: INSTALL, edition: 'local', version: '0.4.2', os: 'macOS 26.4 arm64', view: 'settings/memory', title: 'Fix failed', description: 'The fix on a dead link failed.', logLines: ['memory: fix failed'], runId: 'run_01', at: '2026-11-19T11:59:00Z', screenshots: [], ...over });

describe('the report shape', () => {
  it('keeps the contract fields, lowercases the install and drops anything else', () => {
    const r = cleanIssueReport(report({ install: INSTALL.toUpperCase(), email: 'x@example.com', path: '/Users/x' }), now);
    assert.deepEqual(Object.keys(r).sort(), ['at', 'description', 'edition', 'install', 'logLines', 'os', 'runId', 'screenshots', 'title', 'version', 'view']);
    assert.equal(r.install, INSTALL);
    assert.equal(r.at, '2026-11-19T11:59:00.000Z');
  });
  it('clamps strings, keeps the last 60 log lines and reads a time ahead of the relay as now', () => {
    const r = cleanIssueReport(report({ title: 't'.repeat(300), description: 'd'.repeat(9000), logLines: Array.from({ length: 80 }, (_, i) => `${i}${'x'.repeat(600)}`), at: '2027-01-01T00:00:00Z' }), now);
    assert.equal(r.title.length, LIMITS.title);
    assert.equal(r.description.length, LIMITS.description);
    assert.equal(r.logLines.length, LIMITS.lines);
    assert.ok(r.logLines[0].startsWith('20'));
    assert.equal(r.logLines[0].length, LIMITS.line);
    assert.equal(r.at, new Date(now).toISOString());
  });
  it('drops a run id that is not a plain id', () => {
    assert.equal(cleanIssueReport(report({ runId: '../../etc' }), now).runId, null);
  });
  it('refuses a bad install, edition, time, an empty report and a non-string field', () => {
    assert.throws(() => cleanIssueReport(report({ install: 'abc' }), now), /UUID v4/);
    assert.throws(() => cleanIssueReport(report({ edition: 'web' }), now), /edition/);
    assert.throws(() => cleanIssueReport(report({ at: 'yesterday' }), now), /ISO time/);
    assert.throws(() => cleanIssueReport(report({ title: '', description: '  ' }), now), /title or a description/);
    assert.throws(() => cleanIssueReport(report({ title: 5 }), now), /title must be a string/);
    assert.throws(() => cleanIssueReport(report({ logLines: [1] }), now), /logLines\[0\]/);
  });
});

describe('screenshots', () => {
  it('reads the type from the first bytes', () => {
    assert.deepEqual(imageType(PNG), { mime: 'image/png', ext: 'png' });
    assert.deepEqual(imageType(JPEG), { mime: 'image/jpeg', ext: 'jpg' });
    assert.equal(imageType(GIF), null);
  });
  it('accepts PNG and JPEG, also as data URLs, whatever type the app claims', () => {
    const r = cleanIssueReport(report({ screenshots: [shot(PNG), { data: `data:image/png;base64,${JPEG.toString('base64')}`, type: 'image/png' }] }), now);
    assert.deepEqual(r.screenshots.map((s) => s.mime), ['image/png', 'image/jpeg']);
  });
  it('refuses more than 5, another format, an empty one and one over 2 MB', () => {
    assert.throws(() => cleanIssueReport(report({ screenshots: Array.from({ length: 6 }, () => shot(PNG)) }), now), /At most 5/);
    assert.throws(() => cleanIssueReport(report({ screenshots: [shot(GIF)] }), now), /not a PNG or JPEG/);
    assert.throws(() => cleanIssueReport(report({ screenshots: [{ data: '' }] }), now), /empty/);
    assert.throws(() => cleanIssueReport(report({ screenshots: [{ data: 'not base64!' }] }), now), /base64/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_SHOT_BYTES)]);
    assert.throws(() => cleanIssueReport(report({ screenshots: [shot(big)] }), now), (e) => e instanceof RelayError && e.status === 413);
  });
});

describe('the stored row', () => {
  it('carries the hash, the account and the object keys, never the raw install id', () => {
    const r = cleanIssueReport(report(), now);
    const row = storedIssueReport(ID, r, hashInstall('s', INSTALL), { userId: 'u1', workspaceId: 'w1' }, [`${ID}/1.png`]);
    assert.equal(row.user_id, 'u1');
    assert.equal(row.workspace_id, 'w1');
    assert.deepEqual(row.screenshots, [`${ID}/1.png`]);
    assert.ok(!JSON.stringify(row).includes(INSTALL));
    assert.equal(storedIssueReport(ID, r, 'h', null, []).user_id, null);
  });
});

let addr = 0;
function call(handler, body, { headers = {}, raw, method = 'POST', ip } = {}) {
  const req = new PassThrough();
  req.method = method; req.headers = { 'content-type': 'application/json', 'x-real-ip': ip ?? `10.2.${Math.floor(addr / 250)}.${addr++ % 250}`, ...headers }; req.socket = {};
  req.end(raw ?? JSON.stringify(body));
  const out = { status: 0, body: '' };
  const res = { writeHead: (s, h) => { out.status = s; out.headers = h ?? {}; }, end: (b) => { out.body = String(b ?? ''); } };
  return Promise.resolve(handler(req, res)).then(() => ({ status: out.status, body: JSON.parse(out.body || '{}'), ...(out.status === 503 ? { headers: out.headers } : {}) }));
}
function setup({ salt = 'test-salt', failRecord = false, failUpload = 0, anon = fakeAnon(), db = null, maxInFlight = 2, globalMax = GLOBAL_PER_HOUR, hold = null } = {}) {
  const rows = []; const logs = []; const objects = new Map(); const removed = [];
  let uploads = 0;
  const store = {
    upload: async (p, bytes, mime) => { uploads += 1; if (failUpload && uploads === failUpload) throw new RelayError('server', 'A screenshot could not be stored.', 500); objects.set(p, { bytes, mime }); },
    remove: async (paths) => { for (const p of paths) { objects.delete(p); removed.push(p); } return true; },
    record: async (row) => { if (hold) await hold; if (failRecord) throw new RelayError('server', 'The report could not be stored.', 500); rows.push(row); return { id: row.id }; },
  };
  const handler = reportsRoute({ clients: { anon, db }, config: { errors: { salt } }, store, now: () => now, newId: () => ID, maxInFlight, log: (event, fields) => logs.push({ event, ...fields }), installLimit: createLimiter({ max: 10, now: () => now }), addressLimit: createLimiter({ max: 30, now: () => now }), globalLimit: createLimiter({ max: globalMax, now: () => now }) });
  return { handler, rows, logs, objects, removed };
}

describe('POST /v1/reports', () => {
  it('stores the screenshots under the report id and the hashed row', async () => {
    const { handler, rows, objects, logs } = setup();
    const r = await call(handler, report({ screenshots: [shot(PNG), shot(JPEG)] }));
    assert.deepEqual(r, { status: 202, body: { ok: true, id: ID } });
    assert.deepEqual([...objects.keys()], [`${ID}/1.png`, `${ID}/2.jpg`]);
    assert.equal(objects.get(`${ID}/2.jpg`).mime, 'image/jpeg');
    assert.deepEqual(rows[0].screenshots, [`${ID}/1.png`, `${ID}/2.jpg`]);
    assert.equal(rows[0].install_hash, hashInstall('test-salt', INSTALL));
    assert.ok(!JSON.stringify(rows).includes(INSTALL));
    assert.ok(!JSON.stringify(logs).includes(INSTALL));
  });
  it('without the salt answers 202, stores nothing and warns once', async () => {
    const { handler, rows, objects, logs } = setup({ salt: '' });
    assert.equal((await call(handler, report({ screenshots: [shot(PNG)] }))).status, 202);
    assert.equal((await call(handler, report())).status, 202);
    assert.equal(rows.length + objects.size, 0);
    assert.equal(logs.filter((l) => l.event === 'reports_no_salt').length, 1);
  });
  it('records the account and workspace for a signed-in app and stays anonymous for a bad token', async () => {
    const db = { from: () => { const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: { workspace_id: '01J0000000000000000000000A' }, error: null }) }; return q; } };
    const { handler, rows } = setup({ anon: fakeAnon({ tok: { id: 'u1' } }), db });
    await call(handler, report(), { headers: { authorization: 'Bearer tok' } });
    await call(handler, report(), { headers: { authorization: 'Bearer expired' } });
    assert.deepEqual(rows.map((r) => [r.user_id, r.workspace_id]), [['u1', '01J0000000000000000000000A'], [null, null]]);
  });
  it('removes the uploaded screenshots when the row or a later upload fails', async () => {
    const a = setup({ failRecord: true });
    assert.equal((await call(a.handler, report({ screenshots: [shot(PNG), shot(PNG)] }))).status, 500);
    assert.equal(a.objects.size, 0);
    assert.deepEqual(a.removed, [`${ID}/1.png`, `${ID}/2.png`]);
    const b = setup({ failUpload: 2 });
    assert.equal((await call(b.handler, report({ screenshots: [shot(PNG), shot(PNG)] }))).status, 500);
    assert.equal(b.objects.size, 0);
    assert.equal(b.rows.length, 0);
  });
  it('answers 400 for a bad shape or image and 405 for another method', async () => {
    const { handler, rows } = setup();
    assert.equal((await call(handler, report({ edition: 'web' }))).status, 400);
    assert.equal((await call(handler, report({ screenshots: [shot(GIF)] }))).status, 400);
    assert.equal((await call(handler, null, { raw: 'not json' })).status, 400);
    assert.equal((await call(handler, null, { method: 'GET', raw: '' })).status, 405);
    assert.equal(rows.length, 0);
  });
  it('limits one install to 10 an hour and one address to 30', async () => {
    const { handler, rows } = setup();
    for (let i = 0; i < 10; i++) assert.equal((await call(handler, report())).status, 202);
    assert.equal((await call(handler, report())).status, 429);
    const other = setup();
    const installs = Array.from({ length: 31 }, (_, i) => `3f2b8c1e-9a4d-4e6f-8b2a-${String(i).padStart(12, '0')}`);
    for (let i = 0; i < 30; i++) assert.equal((await call(other.handler, report({ install: installs[i] }), { ip: '10.9.9.9' })).status, 202);
    assert.equal((await call(other.handler, report({ install: installs[30] }), { ip: '10.9.9.9' })).status, 429);
    assert.equal(rows.length, 10);
  });
});

describe('memory and volume limits', () => {
  it('refuses a body whose Content-Length is over the limit before reading it', async () => {
    const { handler, rows } = setup();
    const r = await call(handler, report(), { headers: { 'content-length': String(MAX_REPORT_BODY + 1) } });
    assert.equal(r.status, 413);
    assert.equal(rows.length, 0);
    assert.ok(MAX_REPORT_BODY <= 8 * 1024 * 1024);
    assert.equal(MAX_SHOT_BYTES, 2 * 1024 * 1024);
  });
  it('reads at most two bodies at once and answers 503 with Retry-After past that', async () => {
    let release;
    const hold = new Promise((r) => { release = r; });
    const { handler, rows } = setup({ hold });
    const a = call(handler, report()), b = call(handler, report());
    await new Promise((r) => setTimeout(r, 10));
    const c = await call(handler, report());
    assert.equal(c.status, 503);
    assert.equal(c.headers['retry-after'], '30');
    release();
    assert.deepEqual([(await a).status, (await b).status], [202, 202]);
    assert.equal((await call(handler, report())).status, 202);
    assert.equal(rows.length, 3);
  });
  it('stops storing past the global hourly cap and logs it once', async () => {
    const { handler, rows, logs } = setup({ globalMax: 2 });
    const installs = ['3f2b8c1e-9a4d-4e6f-8b2a-000000000001', '3f2b8c1e-9a4d-4e6f-8b2a-000000000002', '3f2b8c1e-9a4d-4e6f-8b2a-000000000003', '3f2b8c1e-9a4d-4e6f-8b2a-000000000004'];
    const out = [];
    for (const install of installs) out.push((await call(handler, report({ install }))).status);
    assert.deepEqual(out, [202, 202, 429, 429]);
    assert.equal(rows.length, 2);
    assert.equal(logs.filter((l) => l.event === 'reports_global_cap').length, 1);
  });
});

describe('POST /v1/platform/report-screenshots', () => {
  const signer = (fail = false) => ({ storage: { from: () => ({ createSignedUrls: async (paths, secs) => (fail ? { data: null, error: new Error('x') } : { data: paths.map((p) => ({ path: p, signedUrl: `https://storage.example.com/${p}?ttl=${secs}` })), error: null }) }) } });
  const owner = (answer) => { const calls = []; return { calls, asOwner: (token, passkey) => ({ rpc: async (name, args) => { calls.push({ token, passkey, name, args }); return answer; } }) }; };
  const route = (o, db = signer()) => reportShotsRoute({ clients: { db }, config: { corsOrigins: ['https://admin.example.com'] }, asOwner: o.asOwner });
  it('signs the report screenshots for 5 minutes after the owner check, passing the passkey header through', async () => {
    const o = owner({ data: { id: ID, screenshots: [`${ID}/1.png`, 'other/1.png'] }, error: null });
    const r = await call(route(o), { id: ID }, { headers: { authorization: 'Bearer tok', 'x-quorum-passkey': 'pk' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.urls, [{ path: `${ID}/1.png`, url: `https://storage.example.com/${ID}/1.png?ttl=300` }]);
    assert.deepEqual(o.calls[0], { token: 'tok', passkey: 'pk', name: 'admin_issue_report', args: { report_id: ID } });
  });
  it('refuses without a token, for a bad id and when the database refuses the caller', async () => {
    const o = owner({ data: null, error: { message: 'Only the platform owner can do that' } });
    assert.equal((await call(route(o), { id: ID })).status, 401);
    assert.equal((await call(route(o), { id: 'x' }, { headers: { authorization: 'Bearer tok' } })).status, 400);
    assert.equal((await call(route(o), { id: ID }, { headers: { authorization: 'Bearer tok' } })).status, 403);
    const missing = owner({ data: null, error: { message: 'That report does not exist' } });
    assert.equal((await call(route(missing), { id: ID }, { headers: { authorization: 'Bearer tok' } })).status, 404);
  });
  it('answers 500 when signing fails', async () => {
    const o = owner({ data: { screenshots: [`${ID}/1.png`] }, error: null });
    assert.equal((await call(route(o, signer(true)), { id: ID }, { headers: { authorization: 'Bearer tok' } })).status, 500);
  });
});

describe('the hourly purge', () => {
  it('deletes the objects, then only the rows whose objects are gone', async () => {
    const calls = []; const logs = [];
    const db = { rpc: async (name, args) => { calls.push({ name, args }); return name === 'issue_reports_expired' ? { data: [{ id: 'a', screenshots: ['a/1.png'] }, { id: 'b', screenshots: ['b/1.png'] }, { id: 'c', screenshots: [] }], error: null } : { data: 2, error: null }; } };
    const store = { remove: async (paths) => !paths.includes('b/1.png'), folders: async () => [], files: async () => [] };
    const out = await createReportPurge({ db, store, log: (event, fields) => logs.push({ event, ...fields }) }).run();
    assert.deepEqual(out, { reports: 2, failed: 1, orphaned: 0 });
    assert.deepEqual(calls[1], { name: 'issue_reports_delete', args: { ids: ['a', 'c'] } });
    assert.deepEqual(logs, [{ event: 'reports_purged', reports: 2, failed: 1, orphaned: 0 }]);
  });
  it('deletes screenshots with no row once all are older than a day, and pages through the folders', async () => {
    const OLD = new Date(now - ORPHAN_AGE_MS - 1000).toISOString(), NEW = new Date(now - 1000).toISOString();
    const A = '0a1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', B = '0b1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', C = '0c1f2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
    const folderFiles = { [A]: [{ path: `${A}/1.png`, createdAt: OLD }], [B]: [{ path: `${B}/1.png`, createdAt: OLD }, { path: `${B}/2.png`, createdAt: NEW }], [C]: [{ path: `${C}/1.png`, createdAt: OLD }] };
    const removed = []; const offsets = [];
    const db = { rpc: async (name, args) => (name === 'issue_reports_expired' ? { data: [], error: null } : name === 'issue_reports_missing' ? { data: args.ids.filter((id) => id !== C), error: null } : { data: 0, error: null }) };
    const store = { remove: async (paths) => { removed.push(...paths); return true; }, folders: async (offset, limit) => { offsets.push(offset); return offset === 0 ? [A, B, C, 'not-a-report'].slice(0, limit) : []; }, files: async (f) => folderFiles[f] };
    const purge = createReportPurge({ db, store, now: () => now, page: 4 });
    assert.deepEqual(await purge.run(), { reports: 0, failed: 0, orphaned: 1 });
    assert.deepEqual(removed, [`${A}/1.png`]);
    await purge.run(); await purge.run();
    assert.deepEqual(offsets, [0, 4, 0]);
  });
  it('logs a failure and keeps going', async () => {
    const logs = [];
    const db = { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) };
    assert.equal(await createReportPurge({ db, store: { remove: async () => true, folders: async () => [], files: async () => [] }, log: (e, f) => logs.push({ e, ...f }) }).run(), null);
    assert.deepEqual(logs, [{ e: 'reports_purge_failed', message: 'function does not exist' }]);
  });
});
