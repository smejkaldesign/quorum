// Meeting notes saved into the workspace's meetings knowledge base (Cloud edition with a team switched on; migration
// 0028, docs/specs/workspace-knowledge.md "Meeting notes" and Decisions 4). A workspace has one meetings KB. Meeting
// notes from members' meeting-notes connectors (Granola today, Zoom cloud recordings) and notes recorded with Record
// go into it as shared notes, one folder per month ("2026-11"), through the same push sync.js makes for every meeting
// note. That push keeps every existing guardrail: a note with opted-out lines, a confidential note, a denied folder
// or frontmatter key is never pushed (sync.js noteRow with isExcluded and isExcludedText), and Quorum's own notes are
// written with the opt-out lines already redacted (main.js noteMarkdown).
//
// Each note carries the person's choice in its frontmatter:
//   keep_private: true   visibility: private   the author's private note, outside the KB
//   keep_private: false  visibility: public    shared into the meetings KB
// A note with neither key is undecided. On its first push an undecided meeting note dated after this workspace's
// routing started (settings.meetingsKb.since) is shared, unless the person turned off "Save meeting notes to the
// team's meetings knowledge base" (settings.meetingsKb.autoSave, default on). Older undecided notes stay as they
// are. A note with visibility set and no keep_private follows its visibility. Transcripts never go in, and a written
// note (type: note) goes in only when it was recorded (recorded: true). Solo workspaces and the Local edition never
// load this module, so nothing changes for them.
import { readFileSync } from 'node:fs';
import { notes as localNotes } from '../store/local.js';

const KB_TTL = 5 * 60 * 1000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])/;

// the month folder for a note: the year and month its date was written with (the meeting's own local date), else now
export function monthOf(date, now = new Date()) {
  const m = MONTH.exec(String(date ?? '').trim());
  if (m) return `${m[1]}-${m[2]}`;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// a note from a meeting: anything from a meeting-notes connector or a call, and a written note only once recorded
export function isMeetingNote(fm = {}) {
  const type = String(fm.type ?? '').trim();
  if (type === 'transcript') return false;
  if (type === 'note') return String(fm.recorded ?? '') === 'true';
  return true;
}

// what the person chose for the note: 'shared', 'private', or null when nothing is set
export function shareChoice(fm = {}) {
  const keep = String(fm.keep_private ?? '').trim();
  if (keep === 'true') return 'private';
  if (keep === 'false') return 'shared';
  if (fm.visibility === 'public') return 'shared';
  if (fm.visibility === 'private') return 'private';
  return null;
}

// the routing rule for one meeting note:
//   'leave'   not a meeting note, or undecided and the default does not apply: nothing changes
//   'private' kept private, confidential, or with withheld lines: not in the KB
//   'shared'  the person chose to share it: placed in the KB
//   'share'   undecided and shared by default: the choice is written to the note, then it is placed
export function meetingRoute({ fm = {}, withheld = false, autoSave = true, since = null }) {
  if (!isMeetingNote(fm)) return 'leave';
  if (withheld || String(fm.confidential ?? '').trim() !== '') return 'private';
  const choice = shareChoice(fm);
  if (choice) return choice;
  if (!autoSave || !since) return 'leave';
  const at = Date.parse(String(fm.date ?? ''));
  if (Number.isNaN(at) || at < Date.parse(since)) return 'leave';
  return 'share';
}

// the note's text with the choice written into its frontmatter, every other byte kept
export const withChoice = (text, keepPrivate) => localNotes.setFrontmatterKey(localNotes.setFrontmatterKey(text, 'keep_private', keepPrivate ? 'true' : 'false'), 'visibility', keepPrivate ? 'private' : 'public');

export function createMeetingsKb({ account, settings, saveSettings = () => {}, isExcludedText = () => false, log = () => {}, read = (abs) => readFileSync(abs, 'utf8'), write = localNotes.write, now = () => new Date() }) {
  const conf = () => (settings.meetingsKb ??= {});
  const autoSave = () => conf().autoSave !== false;
  // files whose choice the person just turned to shared: their next push places them even if they were placed once
  const fresh = new Set();
  let cache = { ws: null, at: 0, kb: null, folders: new Map() };

  const workspace = () => {
    const s = account.state();
    return s.signedIn && s.workspace?.teamEnabled === true && account.client?.() ? s.workspace : null;
  };
  const rpc = async (name, args) => {
    const { data, error } = await account.client().rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  // the workspace's meetings KB the person can read, the oldest if there are two; cached for a few minutes
  async function meetingsKb(ws) {
    if (cache.ws === ws.id && Date.now() - cache.at < KB_TTL) return cache.kb;
    const kbs = (await rpc('kb_list', { workspace_id: ws.id })) ?? [];
    const k = kbs.filter((x) => x?.kind === 'meetings').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null;
    cache = { ws: ws.id, at: Date.now(), kb: k ? { id: k.id, name: k.name } : null, folders: new Map() };
    return cache.kb;
  }
  async function folderFor(ws, month) {
    if (cache.ws === ws.id && cache.folders.has(month)) return cache.folders.get(month);
    const r = await rpc('kb_meetings_folder', { workspace_id: ws.id, month });
    const place = r?.kb_id ? { kbId: r.kb_id, folderId: r.folder_id ?? null } : null;
    if (place && cache.ws === ws.id) cache.folders.set(month, place);
    return place;
  }
  // when this workspace's default started; set the first time it applies, so only notes from then on are shared
  const sinceFor = (ws) => {
    if (!autoSave()) return null;
    const all = (conf().since ??= {});
    if (!all[ws.id]) { all[ws.id] = now().toISOString(); saveSettings(); }
    return all[ws.id];
  };
  const readNote = (abs) => { try { return read(abs); } catch { return null; } };
  const routeOf = (ws, text, since) => meetingRoute({ fm: localNotes.readFrontmatter(text), withheld: isExcludedText(text), autoSave: autoSave(), since });

  // for sync.js before a meeting note is pushed: { kbId, folderId, fresh } to place it, { private: true } when it is
  // kept out, or null when nothing applies. An undecided note shared by default gets its choice written first, so
  // the push carries visibility public
  async function route(abs) {
    const ws = workspace();
    if (!ws) return null;
    const text = readNote(abs);
    if (text === null || !isMeetingNote(localNotes.readFrontmatter(text))) return null;
    try {
      if (!(await meetingsKb(ws))) return null;
      const r = routeOf(ws, text, sinceFor(ws));
      if (r === 'leave') return null;
      if (r === 'private') { fresh.delete(abs); return { private: true }; }
      const place = await folderFor(ws, monthOf(localNotes.readFrontmatter(text).date, now()));
      if (!place) return null;
      if (r === 'share') write(abs, withChoice(text, false));
      const isFresh = fresh.delete(abs) || r === 'share';
      return { ...place, fresh: isFresh };
    } catch (err) { log('meetings kb', err?.message ?? err); return null; }
  }

  // what the toggle shows for one note: available when the note is a meeting note in a team workspace with a meetings
  // KB the person reads; locked when it cannot be shared (confidential or withheld lines)
  async function stateOf(abs) {
    const ws = workspace();
    const off = { available: false, keepPrivate: true, locked: false, kbName: null };
    if (!ws) return off;
    const text = readNote(abs);
    if (text === null) return off;
    const fm = localNotes.readFrontmatter(text);
    if (!isMeetingNote(fm)) return off;
    let kb;
    try { kb = await meetingsKb(ws); } catch (err) { log('meetings kb', err?.message ?? err); return off; }
    if (!kb) return off;
    const locked = isExcludedText(text) || String(fm.confidential ?? '').trim() !== '';
    const r = routeOf(ws, text, autoSave() ? conf().since?.[ws.id] ?? null : null);
    return { available: true, keepPrivate: !(r === 'shared' || r === 'share'), locked, kbName: kb.name };
  }

  // the Keep private toggle: writes the choice into the note; the caller pushes it
  async function setKeepPrivate(abs, keepPrivate) {
    const st = await stateOf(abs);
    if (!st.available) return { error: 'This note has no team meetings knowledge base to join or leave.' };
    if (!keepPrivate && st.locked) return { error: 'This note is marked confidential or has withheld lines, so it stays private.' };
    const text = readNote(abs);
    if (text === null) return { error: 'This note was moved or deleted.' };
    const next = withChoice(text, keepPrivate);
    if (next !== text) write(abs, next);
    if (keepPrivate) fresh.delete(abs); else fresh.add(abs);
    return { ...st, keepPrivate };
  }

  return { route, stateOf, setKeepPrivate, autoSave };
}
