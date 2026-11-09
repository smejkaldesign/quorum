// the local edition's storage: plain files under Application Support and markdown notes in the vault, moved here from main.js
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeAtomic } from '../relink.js';
import { DATA_DIR, isDevelopment } from '../edition.js';

// DATA_DIR is ~/Library/Application Support/Quorum, or Quorum Dev for a development copy (edition.js)
const SESSIONS = path.join(DATA_DIR, 'sessions');
const SETTINGS_FILE = path.join(SESSIONS, '..', 'settings.json');
// what the quorum CLI and MCP read to see a live call; STOP and the end of a call clear the transcript out of it
const STATE_FILE = path.join(SESSIONS, '..', 'state.json');
const CHATS = path.join(SESSIONS, '..', 'chats');
// attachments are copied into Quorum's own folder so the agent only ever gets read access to the copies
const ATTACH = path.join(DATA_DIR, 'attachments');
const MAX_ATTACH = 25 * 1024 * 1024;

const settingsData = { autoListen: false, model: 'sonnet', suggestions: true };
// whether a settings file was there at launch: an install that already ran skips the first-run wizard
const hadSettings = existsSync(SETTINGS_FILE);
try { if (hadSettings) Object.assign(settingsData, JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))); } catch {}
const saveSettings = () => writeFileSync(SETTINGS_FILE, JSON.stringify(settingsData, null, 2));

// the one settings object the app mutates in place; save writes it back, set merges then saves
export const settings = {
  existed: hadSettings,
  get: () => settingsData,
  save: saveSettings,
  set: (patch) => { Object.assign(settingsData, patch); saveSettings(); return settingsData; },
};

export const state = {
  write: (data) => { try { writeFileSync(STATE_FILE, JSON.stringify(data)); } catch {} },
};

// minimal frontmatter reader for the meeting notes (title, date, participants list)
function readFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = { participants: [] };
  if (!m) return fm;
  let inList = false;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      inList = kv[1] === 'participants' && !kv[2];
      if (!inList) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
    } else if (inList && /^\s+-\s+/.test(line)) {
      fm.participants.push(line.replace(/^\s+-\s+/, ''));
    }
  }
  return fm;
}

// set one frontmatter key in place; everything else in the file stays byte-for-byte
function setFrontmatterKey(text, key, value) {
  const line = `${key}: ${value}`;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\n${line}\n---\n${text}`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const fm = re.test(m[1]) ? m[1].replace(re, line) : `${m[1]}\n${line}`;
  return `---\n${fm}\n---${text.slice(m[0].length)}`;
}

function noteTitle(abs) {
  try {
    const m = readFileSync(abs, 'utf8').match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return path.basename(abs, '.md');
}

// markdown notes by absolute path; the vault tree, rename and move stay in vault.js and relink.js
export const notes = {
  read: (abs) => readFileSync(abs, 'utf8'),
  write: writeAtomic,
  list: (dir) => readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'index.md' && f !== 'README.md'),
  title: noteTitle,
  readFrontmatter,
  setFrontmatterKey,
};

// other apps' meeting notes: subfolders of the meetings folder, plus folders added by hand when there's no connector
const KNOWN_APPS = { granola: 'Granola' };
// the folder your meeting notes live in: your pick, else the vault's existing meetings folder; Quorum saves into it directly, and `source:` in each note says which app made it
function meetingsDir(vault) {
  if (settingsData.meetingsDir && existsSync(settingsData.meetingsDir)) return settingsData.meetingsDir;
  if (!vault) return null;
  try {
    const d = readdirSync(vault).find((n) => /meetings?$/i.test(n.replace(/^\d+[-_ ]*/, '')) && statSync(path.join(vault, n)).isDirectory());
    return d ? path.join(vault, d) : null;
  } catch { return null; }
}
// Quorum's own notes sit in a quorum subfolder, next to the folders other apps fill (granola/ and so on)
// a development copy writes its meeting notes beside the real ones, in their own folder, so test calls never mix in
const quorumNotesDir = (vault) => { const root = meetingsDir(vault); return root ? path.join(root, isDevelopment ? 'quorum-dev' : 'quorum') : null; };
function meetingSources(vault) {
  const root = meetingsDir(vault);
  const hidden = new Set(settingsData.meetingHidden ?? []);
  let subs = [];
  try { subs = root ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'quorum').map((d) => path.join(root, d.name)) : []; } catch {}
  const manual = (settingsData.meetingSources ?? []).filter((p) => existsSync(p) && !subs.includes(p) && p !== root);
  return [...subs.map((p) => ({ path: p, manual: false })), ...manual.map((p) => ({ path: p, manual: true }))]
    .filter((s) => !hidden.has(s.path))
    .map((s) => {
      const base = path.basename(s.path);
      const key = base.toLowerCase().replace(/^\d+[-_ ]*/, '');
      return { ...s, id: s.path, key, name: KNOWN_APPS[key] ?? base.replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) };
    });
}

// a meeting is a session folder of capture segments (audio plus transcript.json) and, once saved, a markdown note
export const meetings = {
  root: SESSIONS,
  ensureRoot: () => mkdirSync(SESSIONS, { recursive: true }),
  dir: meetingsDir,
  notesDir: quorumNotesDir,
  sources: meetingSources,
  beginSegment: (id) => { const dir = path.join(SESSIONS, id, `segment-${Date.now()}`); mkdirSync(dir, { recursive: true }); return dir; },
  writeTranscript: (dir, transcript) => writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2)),
  deleteAudio: (dir) => { try { for (const f of readdirSync(dir)) if (f.endsWith('.caf')) rmSync(path.join(dir, f), { force: true }); } catch {} },
  deleteSegments: (dirs) => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); },
  deleteSession: (id) => rmSync(path.join(SESSIONS, id), { recursive: true, force: true }),
  saveNote: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
};

// every conversation is kept locally so it shows up in History
export const chats = {
  list: () => (existsSync(CHATS) ? readdirSync(CHATS).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(path.join(CHATS, f), 'utf8')); } catch { return null; } }).filter(Boolean) : []),
  read: (id) => { const file = path.join(CHATS, `${String(id).replace(/[^\w-]/g, '')}.json`); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; },
  write: (c) => { mkdirSync(CHATS, { recursive: true }); writeFileSync(path.join(CHATS, `${c.id}.json`), JSON.stringify(c, null, 2)); },
  remove: (id) => rmSync(path.join(CHATS, `${id}.json`), { force: true }),
};

export const attachments = {
  stage: (from) => {
    if (statSync(from).size > MAX_ATTACH) throw new Error('Files over 25 MB can\'t be attached');
    const dir = path.join(ATTACH, randomUUID());
    mkdirSync(dir, { recursive: true });
    const to = path.join(dir, path.basename(from));
    // an APFS clone shares the original's storage, so attaching takes no extra disk space; Node can't clone on macOS, cp -c can
    try { execFileSync('/bin/cp', ['-c', from, to]); } catch { copyFileSync(from, to); }
    return to;
  },
  // a copy only lives until Quorum has answered; anything left from a closed composer goes at the next launch
  unstage: (files) => { for (const f of files) rmSync(path.dirname(f), { recursive: true, force: true }); },
  stagedOnly: (files) => (Array.isArray(files) ? files.map(String).filter((f) => path.dirname(path.dirname(f)) === ATTACH && existsSync(f)) : []),
  clear: () => rmSync(ATTACH, { recursive: true, force: true }),
};

export default { notes, meetings, chats, settings, attachments, state };
