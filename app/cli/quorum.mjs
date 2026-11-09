#!/usr/bin/env node
// quorum: your Quorum meeting notes, chats and live call from Terminal, or served to Claude Code over MCP (`quorum mcp`).
// Reading works from the files with the app closed. Anything that changes something asks the running app over its local socket,
// so it runs the same code as the app's own buttons and follows the app's read-only setting.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

// a development copy of the app keeps its data in Quorum Dev (app/edition.js); QUORUM_ENV=development reads that folder
const HOME = path.join(homedir(), 'Library/Application Support', process.env.QUORUM_ENV === 'development' ? 'Quorum Dev' : 'Quorum');
const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const settings = () => readJson(path.join(HOME, 'settings.json'), {});

function vault() {
  const s = settings();
  if (s.vaultPath && existsSync(s.vaultPath)) return s.vaultPath;
  const root = s.brainRoot;
  if (!root || !existsSync(root)) return null;
  if (existsSync(path.join(root, '.obsidian'))) return root;
  return ['MyBrain', 'vault', 'notes'].map((c) => path.join(root, c)).find((c) => existsSync(path.join(c, '.obsidian'))) ?? root;
}

function meetingsDir() {
  const s = settings();
  if (s.meetingsDir && existsSync(s.meetingsDir)) return s.meetingsDir;
  const v = vault();
  if (!v) return null;
  const d = readdirSync(v).find((n) => /meetings?$/i.test(n.replace(/^\d+[-_ ]*/, '')) && statSync(path.join(v, n)).isDirectory());
  return d ? path.join(v, d) : null;
}

// same list and matching as the app: a line naming an opted-out customer never leaves this process
function excludedTerms() {
  const v = vault();
  try { return readFileSync(path.join(v, 'scripts/embed-bench/excluded.txt'), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; }
}
const terms = excludedTerms();
const isExcluded = (t) => terms.some((x) => String(t).toLowerCase().includes(x));
const redact = (t) => String(t).split('\n').map((l) => (isExcluded(l) ? '[withheld: opted-out customer]' : l)).join('\n');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = { participants: [] };
  if (!m) return fm;
  let inList = false;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) { inList = kv[1] === 'participants' && !kv[2]; if (!inList) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1'); }
    else if (inList && /^\s+-\s+/.test(line)) fm.participants.push(line.replace(/^\s+-\s+/, '').replace(/\s*<[^>]*>/, ''));
  }
  return fm;
}

function meetings() {
  const root = meetingsDir();
  if (!root) return [];
  const dirs = [root, ...readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(root, d.name))];
  const out = [], seen = new Set();
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'index.md') continue;
      const file = path.join(dir, f);
      const text = readFileSync(file, 'utf8');
      const fm = frontmatter(text.slice(0, 4000));
      if (isExcluded(`${fm.title} ${fm.participants.join(' ')}`)) continue;
      const key = fm.granola_id || fm.quorum_id;
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      out.push({ id: path.relative(root, file), title: fm.title || f.replace(/\.md$/, ''), date: fm.date || null, source: fm.source || (dir === root ? 'quorum' : path.basename(dir)), people: fm.participants, file, text });
    }
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

const brief = (m) => ({ id: m.id, title: m.title, date: m.date, source: m.source, people: m.people });

function getMeeting(id) {
  const root = meetingsDir();
  const abs = root && path.resolve(root, String(id));
  if (!abs || !abs.startsWith(root + path.sep) || !abs.endsWith('.md') || !existsSync(abs)) throw new Error(`No meeting note ${id}`);
  const m = meetings().find((x) => x.file === abs);
  if (!m) throw new Error(`${id} is withheld or not a meeting note`);
  return { ...brief(m), body: redact(m.text) };
}

function search(q, limit = 20) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return meetings().map((m) => {
    const hay = `${m.title} ${m.people.join(' ')} ${m.text}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.split(w).length - 1), 0);
    if (!words.every((w) => hay.includes(w))) return null;
    const body = m.text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const line = body.split('\n').find((l) => words.some((w) => l.toLowerCase().includes(w))) ?? '';
    return { ...brief(m), score, snippet: redact(line.trim()).slice(0, 200) };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);
}

function chats(limit = 20) {
  const dir = path.join(HOME, 'chats');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean)
    .map((c) => ({ id: c.id, title: redact(c.title), date: c.updatedAt || c.createdAt, questions: c.turns?.length ?? 0, meeting: c.meetingTitle ? redact(c.meetingTitle) : null }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, limit);
}

function getChat(id) {
  if (!/^chat-\d+$/.test(String(id))) throw new Error(`No chat ${id}`);
  const c = readJson(path.join(HOME, 'chats', `${id}.json`), null);
  if (!c) throw new Error(`No chat ${id}`);
  return { id: c.id, title: redact(c.title), turns: (c.turns ?? []).map((t) => ({ q: redact(t.q), a: redact(t.a), at: t.at })) };
}

function live() {
  const s = readJson(path.join(HOME, 'state.json'), { recording: false });
  if (!s.recording) return { recording: false };
  return { recording: true, title: s.title ? redact(s.title) : null, startedAt: s.startedAt, transcript: (s.transcript ?? []).map((t) => ({ who: t.who, text: redact(t.text) })) };
}

function status() {
  const all = meetings();
  const bySource = all.reduce((o, m) => ({ ...o, [m.source]: (o[m.source] ?? 0) + 1 }), {});
  return { brain: settings().brainRoot ?? null, meetingsFolder: meetingsDir(), meetings: bySource, chats: chats(1e6).length, recording: live().recording };
}

// one request to the running app; it answers on the same line-delimited JSON
function ask(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(HOME, 'quorum.sock'));
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify({ cmd, args })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      sock.end();
      const r = JSON.parse(buf.slice(0, i));
      if (r.error) reject(new Error(r.error)); else resolve(r.result);
    });
    sock.on('error', () => reject(new Error('Quorum isn\'t open. Open the app, then try again.')));
  });
}

const readStdin = () => (process.stdin.isTTY ? '' : readFileSync(0, 'utf8'));
function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [v] = args.splice(i, 2).slice(1);
  return v ?? null;
}
// opens the note in your editor ($EDITOR, else nano) and returns what you saved
function editInEditor(text) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quorum-'));
  const file = path.join(dir, 'note.md');
  writeFileSync(file, text);
  const r = spawnSync(process.env.EDITOR || 'nano', [file], { stdio: 'inherit', shell: true });
  const out = readFileSync(file, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error('Editor closed without saving');
  return out;
}
function vaultNoteText(rel) {
  const v = vault();
  const clean = String(rel).replace(new RegExp(`^${path.basename(v)}/`), '');
  const abs = path.resolve(v, clean.endsWith('.md') ? clean : `${clean}.md`);
  if (!abs.startsWith(v + path.sep) || !existsSync(abs)) throw new Error(`No note at ${rel}`);
  return readFileSync(abs, 'utf8');
}

// for a status line: bright blue while Quorum listens, dim while a call is stopped, nothing otherwise
function statusline() {
  const s = readJson(path.join(HOME, 'state.json'), {});
  if (s.recording) return '\x1b[1;38;5;33m● Quorum listening\x1b[0m';
  if (s.stopped) return '\x1b[2m○ Quorum stopped\x1b[0m';
  return '';
}

const TOOLS = [
  { name: 'quorum_status', description: 'Where Quorum keeps notes, how many meetings and chats it has, and whether a call is being recorded right now.', inputSchema: { type: 'object', properties: {} }, run: () => status() },
  { name: 'list_meetings', description: 'Recent meeting notes from Quorum and other note apps, newest first.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, source: { type: 'string', description: 'quorum, granola, ...' } } }, run: ({ limit = 20, source }) => meetings().filter((m) => !source || m.source === source).slice(0, limit).map(brief) },
  { name: 'search_meetings', description: 'Find meeting notes whose title, attendees or text contain every word of the query.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }, run: ({ query, limit }) => search(query, limit) },
  { name: 'get_meeting', description: 'The full text of one meeting note, by the id from list_meetings or search_meetings.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: ({ id }) => getMeeting(id) },
  { name: 'list_chats', description: 'Recent chats with Quorum in Quorum.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }, run: ({ limit }) => chats(limit) },
  { name: 'get_chat', description: 'The questions and answers in one Quorum chat.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: ({ id }) => getChat(id) },
  { name: 'live_transcript', description: 'The transcript of the call Quorum is recording right now, if any.', inputSchema: { type: 'object', properties: {} }, run: () => live() },
];

// a minimal MCP server over stdio: JSON-RPC, one message per line
function serveMcp() {
  const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    if (id === undefined) return;
    if (method === 'initialize') return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'quorum', version: '0.1.0' }, instructions: 'Read-only access to Quorum meeting notes, Quorum chats and the live call transcript. Lines naming opted-out customers are withheld.' } });
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      try { return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(tool.run(params.arguments ?? {}), null, 2) }] } }); }
      catch (e) { return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } }); }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  });
}

const HELP = `quorum: your Quorum meeting notes from Terminal

Read
  quorum status                     where notes live, counts, recording or not
  quorum meetings [n]               the latest n meeting notes (default 15)
  quorum search <words>             meeting notes containing every word
  quorum note <id>                  one meeting note's full text
  quorum chats [n]                  recent chats with Quorum
  quorum chat <id>                  one chat's questions and answers
  quorum live                       the call being recorded right now

Ask Quorum
  quorum ask <question>             answers from your Agent OS, saved to History

During a call
  quorum start                      start listening (posts the notice in the Zoom chat)
  quorum stop                       same as STOP in the Zoom chat: stops and deletes this call
  quorum go                         same as GO: starts listening again
  quorum end                        end the call and write your notes

Notes in your Agent OS
  quorum new <title> [--folder f]   new note (default folder 00-inbox); text from stdin or after --text
  quorum add <path> <text>          add text to the end of a note
  quorum edit <path>                open a note in your editor and save it back

Settings
  quorum settings                   show what you can change
  quorum set <name> <value>         model (opus, sonnet, haiku), autoListen, suggestions (on, off)

Other
  quorum statusline                 one line for your Claude Code status line; blue while listening
  quorum mcp                        serve your notes to Claude Code over MCP

Reading works with Quorum closed. Everything else needs the app open.
Add --json to any command for raw output.`;

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== '--json');
const json = process.argv.includes('--json');
const print = (data, pretty) => console.log(json || !pretty ? JSON.stringify(data, null, 2) : pretty(data));
const day = (d) => {
  const t = d && new Date(d);
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).padEnd(18) : ''.padEnd(18);
};
const row = (m) => `${day(m.date)}  ${m.title}${m.source !== 'quorum' ? `  [${m.source}]` : ''}\n    ${m.id}`;

try {
  switch (cmd) {
    case 'mcp': serveMcp(); break;
    case 'status': print(status(), (s) => `Brain     ${s.brain ?? 'not connected'}\nMeetings  ${s.meetingsFolder ?? 'no folder'}\n          ${Object.entries(s.meetings).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}\nChats     ${s.chats}\nRecording ${s.recording ? 'yes' : 'no'}`); break;
    case 'meetings': print(meetings().slice(0, Number(rest[0]) || 15).map(brief), (l) => l.map(row).join('\n')); break;
    case 'search': print(search(rest.join(' ')), (l) => (l.length ? l.map((m) => `${row(m)}\n    ${m.snippet}`).join('\n') : 'No matches.')); break;
    case 'note': print(getMeeting(rest.join(' ')), (m) => m.body); break;
    case 'chats': print(chats(Number(rest[0]) || 15), (l) => l.map((c) => `${day(c.date)}  ${c.title}  (${c.questions})\n    ${c.id}`).join('\n')); break;
    case 'chat': print(getChat(rest[0]), (c) => c.turns.map((t) => `> ${t.q}\n\n${t.a}`).join('\n\n')); break;
    case 'live': print(live(), (l) => (l.recording ? `${l.title ?? 'Untitled call'}\n\n${l.transcript.map((t) => `${t.who === 'me' ? 'Me' : 'Others'}: ${t.text}`).join('\n')}` : 'Not recording.')); break;
    case 'statusline': process.stdout.write(statusline()); break;
    case 'ask': {
      const q = rest.join(' ') || readStdin();
      if (!q.trim()) throw new Error('Usage: quorum ask <question>');
      console.error('Quorum is looking through your notes…');
      const r = await ask('ask', { question: q });
      print(r, (x) => `${x.text}${x.sources?.length ? `\n\n${x.sources.map((src) => `[${src.n}] ${src.rel}`).join('\n')}` : ''}`);
      break;
    }
    case 'start': case 'stop': case 'go': case 'end': print(await ask(cmd), (m) => m); break;
    case 'new': {
      const folder = flag(rest, '--folder');
      const text = flag(rest, '--text') ?? readStdin();
      const title = rest.join(' ');
      if (!title) throw new Error('Usage: quorum new <title> [--folder 00-inbox] [--text "..."]');
      print(await ask('note-new', { title, folder, text }), (r) => `Created ${r.rel}`);
      break;
    }
    case 'add': {
      const [rel, ...words] = rest;
      const text = words.join(' ') || readStdin();
      if (!rel || !text.trim()) throw new Error('Usage: quorum add <path> <text>');
      print(await ask('note-append', { rel, text }), (r) => `Added to ${r.rel}`);
      break;
    }
    case 'edit': {
      if (!rest[0]) throw new Error('Usage: quorum edit <path>');
      const before = vaultNoteText(rest[0]);
      if (redact(before) !== before) throw new Error('This note has withheld lines, so it can only be edited in the vault directly');
      const after = process.stdin.isTTY ? editInEditor(before) : readStdin();
      if (after === before) { console.log('No changes.'); break; }
      print(await ask('note-edit', { rel: rest[0], text: after }), (r) => `Saved ${r.rel}`);
      break;
    }
    case 'settings': print(await ask('settings-get'), (x) => Object.entries(x).map(([k, v]) => `${k.padEnd(12)}${v}`).join('\n')); break;
    case 'set': print(await ask('settings-set', { key: rest[0], value: rest[1] }), (x) => Object.entries(x).map(([k, v]) => `${k} is now ${v}`).join('\n')); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
