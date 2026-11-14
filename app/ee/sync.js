// two-way sync for the Cloud edition (setup in docs/self-hosting.md): the vault on disk stays the store. Every note
// or meeting note that changes is upserted into the workspace's tables, and pullNow fetches the rows other devices
// changed since the last pull and writes them into the vault. Nothing here throws when sync is off or signed out; a
// failed push or pull is recorded on the account state as syncError. Changes travel both ways within seconds while
// live() is on: a Realtime channel on the workspace's notes and meetings rows runs pullNow, and a watcher on the vault
// pushes each markdown file that changes. The pull timer in account.js (every three minutes) and the window-focus
// pull stay as the fallback for a dropped socket. Realtime needs migration 0005, which adds both tables to the
// supabase_realtime publication.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../edition.js';
import { createRemote } from './store/remote.js';
import { walk } from '../vault.js';

// which remote row each local note or meeting became; a development copy pointed at production keeps a separate map
// so ids never cross between projects (account.js passes idsFile)
const DEFAULT_IDS_FILE = path.join(DATA_DIR, 'sync-ids.json');
const BATCH = 100;
const PAGE = 1000;
// a burst of Realtime events becomes one pull; a file being written becomes one push once it has settled
const PULL_DEBOUNCE = 1000;
const PUSH_DEBOUNCE = 1500;
// what the watcher pushes: markdown outside dot folders and node_modules, the same shape walk() in vault.js lists
const watchable = (rel) => rel.endsWith('.md') && !rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');
// the pull watermark per workspace lives next to the id map, named sync-pull.json (sync-pull-production.json for the
// developer switch), so the two files travel together
const pullFileFor = (idsFile) => path.join(path.dirname(idsFile), path.basename(idsFile).replace(/^sync-ids/, 'sync-pull'));
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

// a teammate's shared note lands in the workspace vault with a provenance bond in its frontmatter: which team item it
// is, which version, from which workspace, and when it was pulled. The keys are added to the note's own block, or a
// block is opened for a note that has none
export const BOND_KEYS = ['team_item', 'team_version', 'team_workspace', 'team_pulled_at', 'team_behind', 'team_kb', 'team_folder'];
export function withBond(body, bond) {
  const lines = Object.entries(bond).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => `${k}: ${v}`);
  const m = body.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return `---\n${lines.join('\n')}\n---\n${body}`;
  const kept = m[1].split('\n').filter((l) => !BOND_KEYS.some((k) => l.startsWith(`${k}:`)));
  return `---\n${[...kept, ...lines].join('\n')}\n---${m[2]}${body.slice(m[0].length)}`;
}
export const bondOf = (text) => { const fm = parseFrontmatter(text); return fm.team_item ? { item: fm.team_item, version: fm.team_version ?? '', behind: fm.team_behind === 'true' } : null; };
// the knowledge base and folder a pulled row sits in (migration 0024), kept on the id map entry and in a shared note's
// bond; a note outside any knowledge base carries neither
export const placeOf = (row) => (row?.kb_id ? { kb: row.kb_id, folder: row.folder_id ?? null } : { kb: undefined, folder: undefined });
const samePlace = (e, p) => (e?.kb ?? null) === (p.kb ?? null) && (e?.folder ?? null) === (p.folder ?? null);
// the folder for a workspace's shared notes: outside the personal vault, so the watcher never pushes it back
const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Workspace';
export const defaultTeamRoot = (ws) => path.join(homedir(), 'Documents', 'Quorum Team', safeName(ws?.name || ws?.id));

// the note without its frontmatter block, newlines normalized; what a reader shows
export const stripFrontmatter = (text) => String(text).replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '');
// the frontmatter block as plain key: value pairs, with "- item" lists; enough for what notes carry
export function parseFrontmatter(text) {
  const m = String(text).replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---/);
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

export function createSync({ account, store, brain = () => null, log = () => {}, meetingIndex = () => [], isExcluded = () => false, isExcludedText = () => false, idsFile = DEFAULT_IDS_FILE, teamRoot = defaultTeamRoot, meetings = null }) {
  const IDS_FILE = idsFile;
  // path -> { id, hash } per workspace, so a note keeps its id across pushes and unchanged notes are skipped
  let ids = {};
  try { ids = JSON.parse(readFileSync(IDS_FILE, 'utf8')); } catch {}
  const saveIds = () => { try { mkdirSync(path.dirname(IDS_FILE), { recursive: true }); writeFileSync(IDS_FILE, JSON.stringify(ids)); } catch (err) { log('sync ids', err.message); } };
  const entry = (ws, key) => ((ids[ws] ??= {})[key] ??= { id: ulid(), hash: '' });
  // workspace -> { lastPullAt }: the newest updated_at seen, so the next pull asks only for rows after it
  const PULL_FILE = pullFileFor(IDS_FILE);
  let pulls = {};
  try { pulls = JSON.parse(readFileSync(PULL_FILE, 'utf8')); } catch {}
  const savePulls = () => { try { mkdirSync(path.dirname(PULL_FILE), { recursive: true }); writeFileSync(PULL_FILE, JSON.stringify(pulls)); } catch (err) { log('sync pulls', err.message); } };
  let running = null;
  let pulling = null;
  let last = { pushed: 0, skipped: 0, meetings: 0 };
  let lastPull = { written: 0, conflicts: 0, removed: 0, skipped: 0 };
  let lastShared = { written: 0, behind: 0, removed: 0, skipped: 0 };

  // sync runs only with the switch on, a session and a chosen workspace; otherwise every call is a no-op
  const target = () => {
    const s = account.state();
    const client = account.client();
    if (!s.sync || !s.signedIn || !s.workspace || !client) return null;
    return { remote: createRemote({ client, workspaceId: s.workspace.id, userId: s.userId }), ws: s.workspace.id, me: s.userId ?? null, vault: brain()?.vault ?? null, team: teamRoot(s.workspace) };
  };
  const relOf = (vault, abs) => { const r = path.relative(vault, abs); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
  const fail = (what, err, verb = 'push') => { log('sync', what, err?.message ?? err); account.markSync({ syncError: `Sync could not ${verb} ${what}.` }); };

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

  // one file up as a notes row. A save pushes with force; the watcher pushes without it, so a file whose hash already
  // sits in sync-ids.json (the pull just wrote it, or this device's save already pushed it) is skipped
  async function pushFile(abs, force) {
    const t = target();
    if (!t || !t.vault) return false;
    const rel = relOf(t.vault, abs);
    if (!rel || !rel.endsWith('.md')) return false;
    const row = noteRow(t, abs, rel, force);
    if (!row) return false;
    try {
      await t.remote.notes.push(row);
      commit(t, [row]);
      account.markSync({ lastSyncAt: new Date().toISOString(), syncError: null });
      return true;
    } catch (err) { fail('a note', err); return false; }
  }
  const pushNote = (abs) => pushFile(abs, true);

  // a saved meeting note is a note and a meetings row; segments go only for public meetings, read from the session folder
  async function pushMeetingNote(file) {
    const t = target();
    if (!t || !t.vault) return false;
    const rel = relOf(t.vault, file);
    if (!rel) return false;
    // the meetings knowledge base (ee/meetingsKb.js) may write the person's choice into the note first, so the row is
    // read after it. A note goes into the KB once; later pushes leave its place alone, so an admin's move stands
    const place = meetings ? await meetings.route(file) : null;
    const row = noteRow(t, file, rel, true);
    if (!row) return false;
    const e = entry(t.ws, rel);
    if (place?.kbId && (!e.meetings || place.fresh)) Object.assign(row, { kbId: place.kbId, folderId: place.folderId });
    const m = meetingRow(t, file, rel, row.frontmatter);
    try {
      await t.remote.notes.push(row);
      if (row.kbId) e.meetings = true;
      else if (place?.private) delete e.meetings;
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
      let lines;
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

  // every row of a table changed since the watermark, walked page by page so one pull sees the whole set
  async function changed(list, since) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await list(since, { limit: PAGE, offset });
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }
  // a vault-relative path from a row, or null when it is not a markdown path inside the vault or the filters withhold it
  const safeRel = (p) => {
    const rel = String(p ?? '').split('\\').join('/').replace(/^\/+/, '');
    if (!rel || !rel.endsWith('.md') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
    return isExcluded(rel) ? null : rel;
  };
  // a sibling name that does not exist yet: "name (conflict 2026-11-08).md", then "(conflict 2026-11-08 2)" and so on
  const sibling = (vault, rel, tag) => {
    const dir = path.posix.dirname(rel), base = path.posix.basename(rel, '.md');
    for (let n = 1; ; n++) {
      const name = `${base} (${tag}${n > 1 ? ` ${n}` : ''}).md`;
      const r = dir === '.' ? name : `${dir}/${name}`;
      if (!existsSync(path.join(vault, r))) return r;
    }
  };
  const writeRel = (vault, rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); store.notes.write(abs, text); };

  // one remote notes row against the file at its path. The file is never deleted: a soft-deleted row renames it to
  // "(removed)", a row that differs from a locally edited file keeps the remote text at the path and the local text
  // as a "(conflict <date>)" copy next to it
  function applyNote(t, row, counts) {
    const rel = safeRel(row.path);
    if (!rel) { counts.skipped++; return; }
    const abs = path.join(t.vault, rel);
    const bucket = ids[t.ws] ??= {};
    const e = bucket[rel];
    // a note that moved or was renamed remotely still has its id under the old path here; the old file stays put
    for (const [k, v] of Object.entries(bucket)) if (v.id === row.id && k !== rel && !k.includes(':')) delete bucket[k];
    let local = null;
    try { local = readFileSync(abs, 'utf8'); } catch {}
    if (row.deleted_at) {
      if (local !== null) { const to = sibling(t.vault, rel, 'removed'); renameSync(abs, path.join(t.vault, to)); log('sync', `removed remotely, kept as ${to}`); counts.removed++; }
      delete bucket[rel];
      return;
    }
    const body = String(row.body ?? '');
    const remoteHash = row.hash || sha256(body);
    const localHash = local === null ? null : sha256(local);
    // the row is what this device last pushed; a local edit since then goes up on the next push
    if (e && e.hash === remoteHash && localHash !== remoteHash) { e.id = row.id; Object.assign(e, placeOf(row)); return; }
    if (localHash === remoteHash) { bucket[rel] = { id: row.id, hash: remoteHash, ...placeOf(row) }; return; }
    if (local !== null && (!e || e.hash !== localHash)) {
      const copy = sibling(t.vault, rel, `conflict ${new Date().toISOString().slice(0, 10)}`);
      writeRel(t.vault, copy, local);
      log('sync', `conflict on ${rel}: remote kept, local copy at ${copy}`);
      counts.conflicts++;
    }
    writeRel(t.vault, rel, body);
    bucket[rel] = { id: row.id, hash: remoteHash, ...placeOf(row) };
    counts.written++;
  }

  // a teammate's note (public, included, readable under the workspace policy) goes to the workspace vault, never the
  // personal one. The first pull writes it with its bond; a newer version replaces an untouched copy, and marks an
  // edited copy as behind, keeping the fresh text under .updates/ for the diff. A soft-deleted row renames the copy
  function applyShared(t, row, counts) {
    const rel = safeRel(row.path);
    if (!rel) { counts.skipped++; return; }
    const bucket = ids[t.ws] ??= {};
    const key = `team:${rel}`;
    const e = bucket[key];
    const abs = path.join(t.team, rel);
    let local = null;
    try { local = readFileSync(abs, 'utf8'); } catch {}
    if (row.deleted_at) {
      if (local !== null) { const to = sibling(t.team, rel, 'removed'); renameSync(abs, path.join(t.team, to)); counts.removed++; }
      delete bucket[key];
      return;
    }
    const body = String(row.body ?? '');
    const version = row.hash || sha256(body);
    const place = placeOf(row);
    if (e && e.hash === version && local !== null) {
      if (samePlace(e, place)) return;
      // only the note's knowledge base or folder changed: the bond follows it, the text and any edit of it stay
      const fm = parseFrontmatter(local);
      const moved = withBond(local, { team_item: fm.team_item ?? row.id, team_version: fm.team_version ?? version, team_workspace: fm.team_workspace ?? t.ws, team_pulled_at: fm.team_pulled_at, team_behind: fm.team_behind === 'true', team_kb: place.kb, team_folder: place.folder });
      writeRel(t.team, rel, moved);
      bucket[key] = { ...e, ...place, written: e.written === sha256(local) ? sha256(moved) : e.written };
      return;
    }
    const bond = { team_item: row.id, team_version: version, team_workspace: t.ws, team_pulled_at: new Date().toISOString(), team_kb: place.kb, team_folder: place.folder };
    if (local !== null && e && sha256(local) !== e.written) {
      // the person changed their copy: it stays, flagged, and the team's text waits beside it
      writeRel(t.team, rel, withBond(local, { ...bond, team_behind: true }));
      writeRel(t.team, `.updates/${rel}`, body);
      bucket[key] = { id: row.id, hash: version, written: sha256(readFileSync(abs, 'utf8')), behind: true, ...place };
      counts.behind++;
      return;
    }
    const text = withBond(body, bond);
    writeRel(t.team, rel, text);
    bucket[key] = { id: row.id, hash: version, written: sha256(text), ...place };
    counts.written++;
  }

  // a note that stopped being shared (made private, declined, its author removed) no longer comes back from the read
  // policy, so the live shared ids decide which local copies stay
  async function reconcileShared(t, counts) {
    const bucket = ids[t.ws] ?? {};
    const keys = Object.keys(bucket).filter((k) => k.startsWith('team:'));
    if (!keys.length || !t.remote.notes.shared) return;
    const live = new Set((await changed((_s, o) => t.remote.notes.shared(o), null)).map((r) => r.id));
    for (const k of keys) {
      if (live.has(bucket[k].id)) continue;
      const rel = k.slice(5);
      const abs = path.join(t.team, rel);
      if (existsSync(abs)) { const to = sibling(t.team, rel, 'removed'); renameSync(abs, path.join(t.team, to)); counts.removed++; }
      delete bucket[k];
    }
  }

  // rows other devices changed since the last pull, written into the vault; meetings rows only bind their id to the
  // note's path so this device's next push updates the same row
  async function pullNow() {
    if (pulling) return pulling;
    pulling = (async () => {
      const t = target();
      if (!t) return { error: 'Sync is off or no workspace is chosen.' };
      if (!t.vault) return { error: 'No vault is connected.' };
      const counts = { written: 0, conflicts: 0, removed: 0, skipped: 0 };
      try {
        const since = pulls[t.ws]?.lastPullAt ?? null;
        const [notes, meetings] = await Promise.all([changed(t.remote.notes.changedSince, since), changed(t.remote.meetings.changedSince, since)]);
        const shared = { written: 0, behind: 0, removed: 0, skipped: 0 };
        for (const row of notes) (row.user_id && t.me && row.user_id !== t.me ? applyShared(t, row, shared) : applyNote(t, row, counts));
        await reconcileShared(t, shared);
        if (shared.written || shared.behind || shared.removed) log('sync', `workspace vault: ${shared.written} written, ${shared.behind} behind, ${shared.removed} removed`);
        lastShared = shared;
        const byId = new Map(Object.entries(ids[t.ws] ?? {}).filter(([k]) => !k.includes(':')).map(([k, v]) => [v.id, k]));
        for (const m of meetings) {
          const rel = m.note_id ? byId.get(m.note_id) : null;
          if (rel && !m.deleted_at) (ids[t.ws][`meeting:${rel}`] ??= { id: m.id, hash: '' }).id = m.id;
        }
        const newest = [...notes, ...meetings].map((r) => r.updated_at).filter(Boolean).sort().at(-1);
        if (newest) { (pulls[t.ws] ??= {}).lastPullAt = newest; savePulls(); }
        saveIds();
        lastPull = counts;
        if (notes.length || meetings.length) log('sync', `pulled ${notes.length} notes, ${meetings.length} meetings: ${counts.written} written, ${counts.conflicts} conflicts, ${counts.removed} removed, ${counts.skipped} withheld`);
        account.markSync({ lastPullAt: new Date().toISOString(), syncError: null });
        return counts;
      } catch (err) {
        fail('the vault', err, 'pull');
        return { error: 'Sync could not pull the vault.' };
      }
    })().finally(() => { pulling = null; });
    return pulling;
  }

  // Realtime: one channel per workspace with a postgres_changes listener on notes and on meetings, filtered to the
  // workspace. Every event schedules the same pullNow, so the conflict logic above stays the one path for remote
  // changes. supabase-js rejoins the channel itself after a dropped socket; each SUBSCRIBED, the first and every rejoin,
  // pulls what arrived in between.
  let chan = null;
  let pullTimer = null;
  let isLive = false;
  const setLive = (v) => { if (isLive === v) return; isLive = v; account.markSync({ live: v }); };
  const schedulePull = () => { clearTimeout(pullTimer); pullTimer = setTimeout(() => { pullTimer = null; pullNow().catch(() => {}); }, PULL_DEBOUNCE); };
  const closeChannel = () => { if (!chan) return; try { chan.client.removeChannel(chan.channel); } catch {} chan = null; setLive(false); };
  const openChannel = (client, ws) => {
    if (chan && chan.client === client && chan.ws === ws) return;
    closeChannel();
    const channel = client.channel(`sync:${ws}`);
    for (const table of ['notes', 'meetings']) channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `workspace_id=eq.${ws}` }, schedulePull);
    chan = { client, ws, channel };
    channel.subscribe((state, err) => {
      if (chan?.channel !== channel) return;
      if (state === 'SUBSCRIBED') { setLive(true); schedulePull(); return; }
      setLive(false);
      if (err) log('sync', 'realtime', err?.message ?? err);
    });
  };

  // the vault watcher: one timer per changed file, pushed without force once it has been quiet for PUSH_DEBOUNCE.
  // The sync's own writes (pull, conflict copies) land here too and stop at the hash check in pushFile.
  let watcher = null;
  const stopWatch = () => { if (!watcher) return; try { watcher.handle.close(); } catch {} for (const t of watcher.timers.values()) clearTimeout(t); watcher = null; };
  const startWatch = (vault) => {
    if (watcher && watcher.vault === vault) return;
    stopWatch();
    const timers = new Map();
    let handle;
    try {
      handle = watch(vault, { recursive: true }, (_ev, name) => {
        const rel = name ? String(name).split(path.sep).join('/') : null;
        if (!rel || !watchable(rel) || isExcluded(rel)) return;
        clearTimeout(timers.get(rel));
        timers.set(rel, setTimeout(() => { timers.delete(rel); if (existsSync(path.join(vault, rel))) pushFile(path.join(vault, rel), false).catch(() => {}); }, PUSH_DEBOUNCE));
      });
    } catch (err) { log('sync', 'vault watch failed', err?.message ?? err); return; }
    handle.on('error', (err) => log('sync', 'vault watch', err?.message ?? err));
    watcher = { vault, handle, timers };
  };

  // brings the channel and the watcher in line with the current state: both run only while target() is set and a
  // vault is connected, and both move with a workspace switch or a vault change. account.js calls this on every state
  // change, main.js when the vault connects. Returns whether the channel is subscribed.
  function live() {
    const t = target();
    const client = account.client();
    if (!t || !t.vault) { closeChannel(); stopWatch(); return isLive; }
    if (typeof client.channel === 'function') openChannel(client, t.ws);
    startWatch(t.vault);
    return isLive;
  }
  const stop = () => { closeChannel(); stopWatch(); clearTimeout(pullTimer); pullTimer = null; };

  // the workspace vault as the app shows it: where it is, how many shared notes it holds, how many are behind
  const team = () => {
    const s = account.state();
    if (!s.workspace) return null;
    const entries = Object.entries(ids[s.workspace.id] ?? {}).filter(([k]) => k.startsWith('team:'));
    return { root: teamRoot(s.workspace), notes: entries.length, behind: entries.filter(([, v]) => v.behind).length, last: lastShared };
  };
  const status = () => { const s = account.state(); return { on: s.sync, signedIn: s.signedIn, workspaceId: s.workspace?.id ?? null, running: !!running || !!pulling, live: isLive, lastSyncAt: s.lastSyncAt, lastPullAt: s.lastPullAt ?? null, syncError: s.syncError, last, lastPull, team: team() }; };

  return { pushNote, pushMeetingNote, syncNow, pullNow, live, stop, status, team };
}
