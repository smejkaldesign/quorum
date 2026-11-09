// push-only sync for the Cloud edition (setup in docs/self-hosting.md): the vault on disk stays the store, and
// every note or meeting note that changes is upserted into the workspace's tables. Nothing here throws when sync
// is off or signed out; a failed push is recorded on the account state as syncError.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../edition.js';
import { createRemote } from './store/remote.js';
import { walk } from '../vault.js';

// which remote row each local note or meeting became; a development copy pointed at production keeps a separate map
// so ids never cross between projects (account.js passes idsFile)
const DEFAULT_IDS_FILE = path.join(DATA_DIR, 'sync-ids.json');
const BATCH = 100;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Crockford base32 ULID: 10 characters of milliseconds, 16 of randomness, sortable by time
export function ulid(time = Date.now()) {
  let t = '';
  for (let i = 0; i < 10; i++) { t = B32[time % 32] + t; time = Math.floor(time / 32); }
  let r = '';
  for (const b of randomBytes(16)) r += B32[b & 31];
  return t + r;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// the frontmatter block as plain key: value pairs, with "- item" lists; enough for what notes carry
export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  let list = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) { list = kv[2] === '' ? (fm[kv[1]] = []) : null; if (!list) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1'); }
    else if (list && /^\s+-\s+/.test(line)) list.push(line.replace(/^\s+-\s+/, '').replace(/^"(.*)"$/, '$1'));
  }
  return fm;
}

export function createSync({ account, store, brain = () => null, log = () => {}, meetingIndex = () => [], isExcluded = () => false, isExcludedText = () => false, idsFile = DEFAULT_IDS_FILE }) {
  const IDS_FILE = idsFile;
  // path -> { id, hash } per workspace, so a note keeps its id across pushes and unchanged notes are skipped
  let ids = {};
  try { ids = JSON.parse(readFileSync(IDS_FILE, 'utf8')); } catch {}
  const saveIds = () => { try { mkdirSync(path.dirname(IDS_FILE), { recursive: true }); writeFileSync(IDS_FILE, JSON.stringify(ids)); } catch (err) { log('sync ids', err.message); } };
  const entry = (ws, key) => ((ids[ws] ??= {})[key] ??= { id: ulid(), hash: '' });
  let running = null;
  let last = { pushed: 0, skipped: 0, meetings: 0 };

  // sync runs only with the switch on, a session and a chosen workspace; otherwise every call is a no-op
  const target = () => {
    const s = account.state();
    const client = account.client();
    if (!s.sync || !s.signedIn || !s.workspace || !client) return null;
    return { remote: createRemote({ client, workspaceId: s.workspace.id, userId: s.userId }), ws: s.workspace.id, vault: brain()?.vault ?? null };
  };
  const relOf = (vault, abs) => { const r = path.relative(vault, abs); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
  const fail = (what, err) => { log('sync', what, err?.message ?? err); account.markSync({ syncError: `Sync could not push ${what}.` }); };

  // one notes row from a file on disk; null when the note is excluded, withheld or unchanged
  const noteRow = (t, abs, rel, force) => {
    if (isExcluded(rel)) return null;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { return null; }
    if (isExcludedText(text)) return null;
    const e = entry(t.ws, rel), hash = sha256(text);
    if (!force && e.hash === hash) return null;
    let mtime = null;
    try { mtime = statSync(abs).mtime.toISOString(); } catch {}
    return { id: e.id, rel, text, frontmatter: parseFrontmatter(text), hash, mtime };
  };
  const meetingRow = (t, abs, rel, fm) => {
    const e = entry(t.ws, `meeting:${rel}`);
    const people = Array.isArray(fm.participants) ? fm.participants : [];
    const started = fm.date && !Number.isNaN(Date.parse(fm.date)) ? new Date(fm.date).toISOString() : null;
    return { id: e.id, title: fm.title ?? path.basename(abs, '.md'), startedAt: started, endedAt: null, participants: people, visibility: fm.visibility === 'public' ? 'public' : 'private', noteId: entry(t.ws, rel).id };
  };
  const commit = (t, rows) => { for (const r of rows) entry(t.ws, r.rel).hash = r.hash; saveIds(); };

  async function pushNote(abs) {
    const t = target();
    if (!t || !t.vault) return false;
    const rel = relOf(t.vault, abs);
    if (!rel || !rel.endsWith('.md')) return false;
    const row = noteRow(t, abs, rel, true);
    if (!row) return false;
    try {
      await t.remote.notes.push(row);
      commit(t, [row]);
      account.markSync({ lastSyncAt: new Date().toISOString(), syncError: null });
      return true;
    } catch (err) { fail('a note', err); return false; }
  }

  // a saved meeting note is a note and a meetings row; segments go only for public meetings, read from the session folder
  async function pushMeetingNote(file) {
    const t = target();
    if (!t || !t.vault) return false;
    const rel = relOf(t.vault, file);
    if (!rel) return false;
    const row = noteRow(t, file, rel, true);
    if (!row) return false;
    const m = meetingRow(t, file, rel, row.frontmatter);
    try {
      await t.remote.notes.push(row);
      await t.remote.meetings.push(m);
      if (m.visibility === 'public' && row.frontmatter.quorum_id) await t.remote.meetings.pushSegments(m, sessionSegments(t, String(row.frontmatter.quorum_id)));
      commit(t, [row]);
      account.markSync({ lastSyncAt: new Date().toISOString(), syncError: null });
      return true;
    } catch (err) { fail('a meeting', err); return false; }
  }

  // the capture segments of a session folder, each with a stable id so a second push upserts in place
  function sessionSegments(t, sessionId) {
    const dir = path.join(store.meetings.root, sessionId.replace(/[^\w.-]/g, ''));
    const out = [];
    if (!existsSync(dir)) return out;
    for (const seg of readdirSync(dir).filter((n) => n.startsWith('segment-')).sort()) {
      let lines = [];
      try { lines = JSON.parse(readFileSync(path.join(dir, seg, 'transcript.json'), 'utf8')); } catch { continue; }
      lines.forEach((l, i) => { if (l?.text) out.push({ id: entry(t.ws, `segment:${sessionId}/${seg}/${i}`).id, channel: l.channel === 'me' ? 'me' : 'them', start: Number(l.start ?? l.t ?? 0) || 0, text: String(l.text), who: l.who ?? null }); });
    }
    return out;
  }

  // the whole vault, changed notes only, in batches; then every meeting note the Home index knows about
  async function syncNow() {
    if (running) return running;
    running = (async () => {
      const t = target();
      if (!t) return { error: 'Sync is off or no workspace is chosen.' };
      if (!t.vault) return { error: 'No vault is connected.' };
      let pushed = 0, skipped = 0, meetings = 0;
      try {
        const rels = walk(t.vault, '', isExcluded, []);
        let batch = [];
        const flush = async () => { if (!batch.length) return; await t.remote.notes.pushMany(batch); commit(t, batch); pushed += batch.length; batch = []; };
        for (const rel of rels) {
          const row = noteRow(t, path.join(t.vault, rel), rel, false);
          if (!row) { skipped++; continue; }
          batch.push(row);
          if (batch.length >= BATCH) await flush();
        }
        await flush();
        const rows = [];
        for (const m of meetingIndex()) {
          if (m.kind !== 'meeting' || !m.file) continue;
          const rel = relOf(t.vault, m.file);
          if (!rel || isExcluded(rel)) continue;
          let text;
          try { text = readFileSync(m.file, 'utf8'); } catch { continue; }
          if (isExcludedText(text)) continue;
          rows.push(meetingRow(t, m.file, rel, parseFrontmatter(text)));
        }
        for (let i = 0; i < rows.length; i += BATCH) { await t.remote.meetings.pushMany(rows.slice(i, i + BATCH)); meetings += Math.min(BATCH, rows.length - i); }
        saveIds();
        last = { pushed, skipped, meetings };
        log('sync', `pushed ${pushed} notes, ${meetings} meetings, ${skipped} unchanged`);
        account.markSync({ lastSyncAt: new Date().toISOString(), syncError: null });
        return { pushed, skipped, meetings };
      } catch (err) {
        fail('the vault', err);
        return { error: 'Sync could not push the vault.' };
      }
    })().finally(() => { running = null; });
    return running;
  }

  const status = () => { const s = account.state(); return { on: s.sync, signedIn: s.signedIn, workspaceId: s.workspace?.id ?? null, running: !!running, lastSyncAt: s.lastSyncAt, syncError: s.syncError, last }; };

  return { pushNote, pushMeetingNote, syncNow, status };
}
