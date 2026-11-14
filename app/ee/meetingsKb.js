// Meeting notes saved into a meetings knowledge base (Cloud edition with a team switched on; migrations 0029 and 0035,
// docs/specs/workspace-knowledge.md "Meeting notes" and Decisions 4). A workspace has one meetings KB of its own and
// one per team (0035). The server picks the KB for each person (meetingTeamOf below states the same rule): a person
// in no team uses the workspace's; a person in teams uses their meeting team's, which is the one they chose in
// Settings > Meetings when they are in several, else the team they joined first. Shared meeting notes go into it
// through the push sync.js makes for every meeting note, one folder per month ("2026-11").
// That push keeps every guardrail: a note in an excluded folder, with opted-out lines, confidential, or with a
// denied frontmatter key is never pushed (sync.js noteRow with isExcluded and isExcludedText), and this module never
// rewrites such a note.
//
// The note's choice is keep_private in its frontmatter, with visibility following it (shareChoice.js). An undecided
// note (no keep_private) gets a default on its first push:
//   - a note recorded in Quorum (Record, a call, Start listening; source: quorum) follows "Save meeting notes to the
//     team's meetings knowledge base" (settings.meetingsKb.autoSave, default on)
//   - a note from a meeting-notes connector follows the person's choice for that source account (a Granola account,
//     Zoom), asked once per workspace, since one account can hold another organization's meetings. Until they
//     choose, its notes stay private
// Either default covers notes dated from when it started applying (its since); older notes stay as they are until
// the person shares them one by one, or a source's past notes at once from Settings > Meetings. Transcripts never go
// in, and a written note (type: note) goes in only when it was recorded (recorded: true). Solo workspaces and the
// Local edition never use this module.
//
// settings.meetingsKb: { autoSave, since: { [workspaceId]: iso }, floor: iso,
//                        sources: { [workspaceId]: { [sourceKey]: { choice: 'share' | 'private' | null, label, since, firstDate } } } }
import { readFileSync } from 'node:fs';
import { notes as localNotes } from '../store/local.js';
import { choiceOf, withChoice } from '../shareChoice.js';

const INFO_TTL = 5 * 60 * 1000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])/;
const HOUR = 60 * 60 * 1000;
// a default that starts applying reaches back to the note that started it, less this margin, and never more than a day
export const SINCE_MARGIN = 2 * HOUR;
export const SINCE_REACH = 24 * HOUR;
const SOURCE_NAMES = { granola: 'Granola', zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet' };
export const SYNC_OFF = 'Turn on sync to share meeting notes.';
export const EXCLUDED = 'Not shared (excluded folder).';

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

// where a note came from: 'recorded' for Quorum's own, { key, label } for a connector's source account, null for a
// note no connector or recording made (a file dropped into a meetings folder by hand), which is never shared by default
export function originOf(fm = {}) {
  const source = String(fm.source ?? '').trim().toLowerCase();
  if (source === 'quorum') return 'recorded';
  if (!source) return null;
  const acct = String(fm.source_account ?? '').trim();
  const name = SOURCE_NAMES[source] ?? source.replace(/^./, (c) => c.toUpperCase());
  return { key: `${source}:${acct.toLowerCase()}`, label: acct ? `${name} (${acct})` : name };
}

const isConfidential = (fm) => String(fm.confidential ?? '').trim() !== '';
const after = (date, since) => { const at = Date.parse(String(date ?? '')); return !!since && !Number.isNaN(at) && at >= Date.parse(since); };

// the routing rule for one meeting note:
//   'leave'   not a meeting note, in an excluded folder, or undecided with no default that applies: nothing changes
//   'ask'     undecided, from a connector source the person has not chosen for yet: stays private, and they are asked
//   'private' kept private, confidential, or with withheld lines: not in the KB
//   'shared'  keep_private is false: placed in the KB
//   'share'   undecided and shared by default: the choice is written to the note, then it is placed
// source is the person's choice for the note's connector source: { choice, since } or undefined
export function meetingRoute({ fm = {}, excluded = false, withheld = false, autoSave = true, since = null, source }) {
  if (!isMeetingNote(fm) || excluded) return 'leave';
  if (withheld || isConfidential(fm)) return 'private';
  const choice = choiceOf(fm);
  if (choice) return choice;
  const origin = originOf(fm);
  if (origin === 'recorded') return autoSave && after(fm.date, since) ? 'share' : 'leave';
  if (!origin) return 'leave';
  if (!source?.choice) return 'ask';
  return source.choice === 'share' && after(fm.date, source.since) ? 'share' : 'leave';
}

// when a default starts applying because of a note dated `date`: that date less the margin, but never later than now
// and never more than a day back, and never before floor (the last time the person turned it from off to on)
export function startSince(date, now, floor = null) {
  const t = now.getTime();
  const at = Date.parse(String(date ?? ''));
  let s = Number.isNaN(at) ? t : Math.min(t, at - SINCE_MARGIN);
  s = Math.max(s, t - SINCE_REACH);
  if (floor && !Number.isNaN(Date.parse(floor))) s = Math.max(s, Date.parse(floor));
  return new Date(s).toISOString();
}

// the team whose meetings KB receives the person's notes, from their teams in the order they joined (kb_meetings_info
// lists them so): the one marked as their default, else the first; null for a person in no team
export function meetingTeamOf(teams = []) {
  const list = Array.isArray(teams) ? teams : [];
  return (list.find((t) => t?.meetings_default === true || t?.meetingsDefault === true) ?? list[0])?.id ?? null;
}

export function createMeetingsKb({ account, settings, saveSettings = () => {}, isExcluded = () => false, isExcludedText = () => false, relOf = () => null, listNotes = () => [], push = async () => {}, onChange = () => {}, log = () => {}, read = (abs) => readFileSync(abs, 'utf8'), write = localNotes.write, now = () => new Date() }) {
  const conf = () => (settings.meetingsKb ??= {});
  const autoSave = () => conf().autoSave !== false;
  // files whose choice the person just turned to shared: their next push places them even if they were placed once
  const fresh = new Set();
  let cache = { ws: null, at: 0, info: null, folders: new Map() };

  const workspace = () => {
    const s = account.state();
    return s.signedIn && s.workspace?.teamEnabled === true && account.client?.() ? s.workspace : null;
  };
  const rpc = async (name, args) => {
    const { data, error } = await account.client().rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  // the meetings KB the person's notes go to, as { id, name, teamId, teams }; cached for a few minutes. id is null for a
  // team whose meetings KB the first note will make. A server before 0035 answers with no team
  async function meetingsKb(ws) {
    if (cache.ws === ws.id && Date.now() - cache.at < INFO_TTL) return cache.info;
    const r = await rpc('kb_meetings_info', { workspace_id: ws.id });
    const teams = Array.isArray(r?.teams) ? r.teams.filter((t) => t?.id).map((t) => ({ id: t.id, name: t.name ?? 'Team', meetings_default: t.meetings_default === true })) : [];
    const teamId = r?.team_id ?? meetingTeamOf(teams);
    const info = r?.kb_id || r?.team_id ? { id: r.kb_id ?? null, name: r.name ?? 'Meetings', teamId: teamId ?? null, teams } : null;
    cache = { ws: ws.id, at: Date.now(), info, folders: new Map() };
    return cache.info;
  }
  const dropCache = () => { cache = { ws: null, at: 0, info: null, folders: new Map() }; };
  async function folderFor(ws, month) {
    if (cache.ws === ws.id && cache.folders.has(month)) return cache.folders.get(month);
    const r = await rpc('kb_meetings_folder', { workspace_id: ws.id, month });
    const place = r?.kb_id ? { kbId: r.kb_id, folderId: r.folder_id ?? null } : null;
    if (place && cache.ws === ws.id) cache.folders.set(month, place);
    return place;
  }
  const sourcesOf = (wsId) => ((conf().sources ??= {})[wsId] ??= {});
  const readNote = (abs) => { try { return read(abs); } catch { return null; } };
  const excludedPath = (abs) => { const rel = relOf(abs); return !!rel && isExcluded(rel); };

  // the inputs meetingRoute needs for one note. With start, a default that applies for the first time starts here
  function inputs(ws, abs, text, start) {
    const fm = localNotes.readFrontmatter(text);
    const origin = originOf(fm);
    let since = autoSave() ? conf().since?.[ws.id] ?? null : null;
    if (start && origin === 'recorded' && autoSave() && !since && !choiceOf(fm)) {
      since = startSince(fm.date, now(), conf().floor ?? null);
      (conf().since ??= {})[ws.id] = since;
      saveSettings();
    }
    let source;
    if (origin && origin !== 'recorded') {
      const all = sourcesOf(ws.id);
      source = all[origin.key];
      if (start && !source && !choiceOf(fm) && isMeetingNote(fm)) {
        // the first note from this source account in this workspace: the person is asked once
        source = all[origin.key] = { choice: null, label: origin.label, firstDate: fm.date ?? null };
        saveSettings();
        onChange();
      }
    }
    return { fm, origin, args: { fm, excluded: excludedPath(abs), withheld: isExcludedText(text), autoSave: autoSave(), since, source } };
  }

  // for sync.js before a meeting note is pushed: { kbId, folderId, fresh } to place it, { private: true } when it is
  // kept out, or null when nothing applies. The two choice keys are made to agree first, and an undecided note
  // shared by default gets its choice written, so the push carries both
  async function route(abs) {
    const ws = workspace();
    if (!ws || account.state().sync !== true) return null;
    const text = readNote(abs);
    if (text === null) return null;
    try {
      if (!isMeetingNote(localNotes.readFrontmatter(text)) || !(await meetingsKb(ws))) return null;
      const { fm, args } = inputs(ws, abs, text, true);
      const r = meetingRoute(args);
      if (r === 'leave' || r === 'ask') return null;
      if (r === 'private') {
        fresh.delete(abs);
        // a kept private note whose visibility says public is pushed private; a confidential one is never pushed
        if (choiceOf(fm) === 'private' && fm.visibility !== 'private') write(abs, withChoice(text, true));
        return { private: true };
      }
      const place = await folderFor(ws, monthOf(fm.date, now()));
      if (!place) return null;
      if (r === 'share' || fm.visibility !== 'public') write(abs, withChoice(text, false));
      const isFresh = fresh.delete(abs) || r === 'share';
      return { ...place, fresh: isFresh };
    } catch (err) { log('meetings kb', err?.message ?? err); return null; }
  }

  // what the toggle shows for one note: available when the note is a meeting note in a team workspace with a meetings
  // KB the person reads and sync on; locked when it cannot be shared. reason says why it is unavailable when the
  // person can do something about it, or why it is not shared; ask names the source to choose for
  async function stateOf(abs) {
    const ws = workspace();
    const off = { available: false, keepPrivate: true, locked: false, kbName: null, reason: null, ask: null };
    if (!ws) return off;
    const text = readNote(abs);
    if (text === null) return off;
    if (!isMeetingNote(localNotes.readFrontmatter(text))) return off;
    let info;
    try { info = await meetingsKb(ws); } catch (err) { log('meetings kb', err?.message ?? err); return off; }
    if (!info) return off;
    if (account.state().sync !== true) return { ...off, kbName: info.name, reason: SYNC_OFF };
    if (excludedPath(abs)) return { ...off, kbName: info.name, reason: EXCLUDED };
    const { fm, origin, args } = inputs(ws, abs, text, false);
    const r = meetingRoute(args);
    const locked = args.withheld || isConfidential(fm);
    const ask = r === 'ask' && origin && origin !== 'recorded' ? { key: origin.key, label: origin.label } : null;
    return { available: true, keepPrivate: !(r === 'shared' || r === 'share'), locked, kbName: info.name, reason: null, ask };
  }

  // the Keep private toggle: writes the choice into the note; the caller pushes it
  async function setKeepPrivate(abs, keepPrivate) {
    const st = await stateOf(abs);
    if (!st.available) return { error: st.reason ?? 'This note has no team meetings knowledge base to join or leave.' };
    if (!keepPrivate && st.locked) return { error: 'This note is marked confidential or has withheld lines, so it stays private.' };
    const text = readNote(abs);
    if (text === null) return { error: 'This note was moved or deleted.' };
    const next = withChoice(text, keepPrivate);
    if (next !== text) write(abs, next);
    if (keepPrivate) fresh.delete(abs); else fresh.add(abs);
    return { ...st, keepPrivate, ask: null };
  }

  // the auto-save setting; turning it from off to on starts it from now, so notes made while it was off stay
  function setAutoSave(on) {
    const was = autoSave();
    conf().autoSave = on === true;
    if (on && !was) {
      const t = now().toISOString();
      conf().floor = t;
      conf().since = Object.fromEntries(Object.keys(conf().since ?? {}).map((k) => [k, t]));
      const ws = workspace();
      if (ws) conf().since[ws.id] = t;
    }
    saveSettings();
    onChange();
    return { autoSave: autoSave() };
  }

  // undecided notes from each source that its default does not cover: dated before its since, or all while it is
  // not shared. Excluded, confidential and withheld notes are never counted
  function pastNotes(ws) {
    const by = new Map();
    const all = sourcesOf(ws.id);
    for (const abs of listNotes()) {
      const text = readNote(abs);
      if (text === null) continue;
      const { fm, origin, args } = inputs(ws, abs, text, false);
      if (!origin || origin === 'recorded' || choiceOf(fm) || !isMeetingNote(fm) || args.excluded || args.withheld || isConfidential(fm)) continue;
      const s = all[origin.key];
      if (s?.choice === 'share' && after(fm.date, s.since)) continue;
      by.set(origin.key, [...(by.get(origin.key) ?? []), abs]);
    }
    return by;
  }

  // the connector source accounts this workspace has seen, with the person's choice and how many past notes the
  // "share past meeting notes" action would share
  async function sources() {
    const ws = workspace();
    if (!ws) return { available: false, sources: [] };
    let info = null;
    try { info = await meetingsKb(ws); } catch (err) { log('meetings kb', err?.message ?? err); }
    if (!info) return { available: false, sources: [] };
    const past = pastNotes(ws);
    return {
      available: true, sync: account.state().sync === true, workspaceName: ws.name ?? null, kbName: info.name,
      sources: Object.entries(sourcesOf(ws.id)).map(([key, s]) => ({ key, label: s.label ?? key, choice: s.choice ?? null, past: (past.get(key) ?? []).length })),
      // the meeting team choice is offered only to a person in several teams
      teams: info.teams.length > 1 ? info.teams.map((t) => ({ id: t.id, name: t.name })) : [],
      teamId: info.teamId ?? null,
    };
  }

  // the person's meeting team when they are in several (null: the team they joined first). It is stored on the server,
  // so every Mac of theirs routes the same way; the next note goes to that team's meetings KB
  async function setTeam(teamId) {
    const ws = workspace();
    if (!ws) return { error: 'Sharing meeting notes needs a workspace with a team.' };
    try { await rpc('team_meetings_default_set', { workspace_id: ws.id, team_id: teamId ?? null }); }
    catch (err) { log('meetings kb', err?.message ?? err); return { error: String(err?.message ?? 'The meeting team could not be saved.').replace(/\.?$/, '.') }; }
    dropCache();
    onChange();
    return { ok: true, teamId: teamId ?? null };
  }

  // the person's choice for a source account. Share starts from the first note that asked (within a day) or, when it
  // was Keep private before, from now; the source's notes are pushed again so the ones in that window go in
  async function setSource(key, choice) {
    const ws = workspace();
    if (!ws) return { error: 'Sharing meeting notes needs a workspace with a team.' };
    if (!['share', 'private'].includes(choice)) return { error: 'Choose Share or Keep private.' };
    const all = sourcesOf(ws.id);
    const s = all[key] ??= { label: key, choice: null };
    const was = s.choice;
    s.choice = choice;
    if (choice === 'share' && was !== 'share') s.since = was === 'private' ? now().toISOString() : startSince(s.firstDate, now());
    saveSettings();
    onChange();
    if (choice === 'share') {
      for (const abs of listNotes()) {
        const text = readNote(abs);
        if (text === null) continue;
        const o = originOf(localNotes.readFrontmatter(text));
        if (o && o !== 'recorded' && o.key === key) await push(abs).catch((err) => log('meetings kb', err?.message ?? err));
      }
    }
    return { ok: true, choice };
  }

  // one-time: share every past note from a source (the count sources() reports), after the person confirmed
  async function sharePast(key) {
    const ws = workspace();
    if (!ws) return { error: 'Sharing meeting notes needs a workspace with a team.' };
    if (account.state().sync !== true) return { error: SYNC_OFF };
    let shared = 0;
    for (const abs of pastNotes(ws).get(key) ?? []) {
      const text = readNote(abs);
      if (text === null) continue;
      write(abs, withChoice(text, false));
      fresh.add(abs);
      await push(abs).catch((err) => log('meetings kb', err?.message ?? err));
      shared++;
    }
    onChange();
    return { shared };
  }

  return { route, stateOf, setKeepPrivate, setAutoSave, sources, setSource, sharePast, setTeam, autoSave };
}
