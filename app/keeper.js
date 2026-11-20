// the keeper: what maintains an Agent OS after Quorum writes into it. Each new meeting note gets an index line, a line
// in the daily note, and a line under "## Meetings" in every people note and project note it concerns; a dated entry in
// the keeper's changelog records each change. With the memory graph open, each filed meeting also records typed edges in
// it: attended for each person, mentions for each project it names, decided_in for each decision. With a model source
// chosen, a few learned facts per note go into a marked list in the facts file, learned-facts.md in the Quorum folder
// (QUORUM_FOLDER unless the person picks another or the vault has one already), linked from index.md when Quorum keeps
// the index. Claude Code does not load it on its own; the Quorum MCP server reads it (learned_facts) and its
// instructions point agents at it. The list stays under a budget in characters: the oldest lines move to the changelog
// when it runs over, and a line marked #keep stays. A fact that only says a note is empty or holds no decisions is left
// out. Everything else is append-only: no note body is rewritten, and a line already present is left alone.
// Quorum edits only the files it made: files that carry its mark (QUORUM_MARK in their frontmatter, added to each file
// the keeper creates or writes), files the keeper created (recorded in keeper.json as made), the files the starter wrote
// into a folder Quorum built, files under the .quorum folder an earlier version used, and, for files an earlier version
// wrote with no mark, a facts file, an index or a daily note whose text is still only what the keeper writes. CLAUDE.md, AGENTS.md, project logs and every other note the person made are never
// written; the meeting index lines then go to the meetings folder's own index.md, which Quorum makes. A list an earlier
// version wrote into a file the person made stays there until the person approves its move in Needs review
// (rules/keeperLines.js).
// Confidential notes, private folders and secret-looking files never enter the index, the links or the facts.
// The keeper's state (keeper.json, the changelog, kept-notes.json) lives in Quorum's data folder, one folder per vault
// (keeperHome), so it never shows as a changed file in the vault's git; state an earlier version kept in the vault's
// .quorum folder moves there on first load. Progress is kept in keeper.json by note hash, so a note changed later is
// filed again and an unchanged one is skipped; a backlog left by days with the app closed runs in one pass at launch.
// Each job (index, daily, links, facts) is a plugin (plugins.js): the keeper writes only the jobs Quorum owns, never
// touches a file whose first lines say it is generated, names daily notes the way the vault already does, and holds a
// run that would create more than CREATE_LIMIT new files until the user says to go ahead.
// A note Quorum made with no recording and almost no real words (noteJunk.js) is not filed: it is listed in
// keeper.json as junk for the Notifications view to ask about, until the person moves it to the Trash or keeps it.
// A kept note is recorded in kept-notes.json and never asked about again
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { SETUP_FILE, plan, readSetup, slug } from './starter.js';
import { CITE_RE, FACTS_NAME, KEEP_RE, LEARNED_CLOSE, LEARNED_HEADER, LEARNED_OPEN, LEGACY_LEARNED, QUORUM_FOLDER, VAULT_FILE, blockAt, bodyText, dropBlock, factKey, isFactsFile, isMarked, keeperHome, learnedLines, withMark } from './cli/learned.mjs';
import { junkOf } from './noteJunk.js';
import { DAILY_DEFAULT, choose, dailyName, dailyPattern, isGenerated, owns, resolvePlugins } from './plugins.js';
import { entityId, noteKind } from './graph/extract.js';

// the files of the keeper's state, by name in its folder under Quorum's data folder (keeperHome)
export const KEEPER_FILE = 'keeper.json';
export const CHANGELOG = 'changelog.md';
// the notes the person kept after upkeep flagged them as junk, by quorum_id (else path). A file of its own, so a
// decision written while a run is going is never lost when the run saves keeper.json
export const KEPT_FILE = 'kept-notes.json';
// where an earlier version kept each of them, inside the vault
const LEGACY_STATE = [[KEEPER_FILE, '.quorum/keeper.json'], [CHANGELOG, '.quorum/changelog.md'], [KEPT_FILE, '.quorum/kept-notes.json']];
export { CITE_RE, FACTS_NAME, KEEP_RE, LEARNED_CLOSE, LEARNED_HEADER, LEARNED_OPEN, LEGACY_LEARNED, QUORUM_FOLDER, QUORUM_MARK, factKey, isMarked, keeperHome, learnedFileIn, learnedLines, withMark } from './cli/learned.mjs';
export const LEARNED_BUDGET = 2000;
export const NOTE_LINK = 'learned facts from meetings, kept by Quorum';
// the first lines of the index files the keeper makes; only Quorum writes them
export const INDEX_HEADER = '# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n';
export const MEETINGS_HEADER = '# Meetings\n\nOne line per meeting, written by Quorum.\n';
// a daily note exactly as the keeper makes it: a date heading and meeting lines, nothing the person added
const KEEPER_DAILY_RE = /^# \d{4}-\d{2}-\d{2}\n\n## Meetings\n\n(?:- \[\[[^\]\n]+\]\][^\n]*\n)+$/;
// a run that would add more new files than this to the vault waits for the user (a backlog of months of meetings
// against a vault with its own daily naming once made 86)
export const CREATE_LIMIT = 10;
// the upkeep error log stays small: past ERR_MAX bytes it keeps its last ERR_KEEP lines
const ERR_MAX = 96 * 1024;
const ERR_KEEP = 200;
const posix = (rel) => rel.split(path.sep).join('/');
const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const today = (d = new Date()) => d.toISOString().slice(0, 10);

// the areas by name, under either naming (02-people or people): the first top-level folder whose name, without a
// numeric prefix, ends in the word
const AREA_RE = { people: /people$/i, projects: /projects?$/i, daily: /daily$/i, meetings: /meetings?$/i };
const readKept = (home) => { try { const v = JSON.parse(readFileSync(path.join(home, KEPT_FILE), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export function folders(vault) {
  const out = {};
  let names;
  try { names = readdirSync(vault).filter((n) => !n.startsWith('.')).sort(); } catch { return out; }
  for (const [k, re] of Object.entries(AREA_RE)) {
    const hit = names.find((n) => re.test(n.replace(/^\d+[-_ ]*/, '')) && isDir(path.join(vault, n)));
    if (hit) out[k] = hit;
  }
  return out;
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// a folder path the user typed, vault-relative with no trailing slash; null when it leaves the vault or sits in a dot
// folder
export function folderPath(p) {
  const t = String(p ?? '').normalize('NFC').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!t || t.startsWith('/') || /^[a-z]:/i.test(t)) return null;
  return t.split('/').some((s) => !s || s.startsWith('.')) ? null : t;
}
// the one folder Quorum keeps its files in: the person's pick, else a top-level folder the vault already has under
// that name (Quorum, 09-quorum), else QUORUM_FOLDER, made when the first file goes in
export function quorumFolder(vault, pick = null) {
  const p = folderPath(pick);
  if (p) return p;
  let names = [];
  try { names = readdirSync(vault).filter((n) => !n.startsWith('.')).sort(); } catch {}
  return names.find((n) => /^quorum$/i.test(n.replace(/^\d+[-_ ]*/, '')) && isDir(path.join(vault, n))) ?? QUORUM_FOLDER;
}
const read =(p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// whether a meeting note is junk upkeep should ask about: only a note Quorum made (source quorum, not an agent
// import), and only one with no recording. Only a typed note (type: note) can be junk: a meeting note Quorum wrote
// has no type and came from a recording. Returns the note's
// key for the kept list, its title and the reason, or null
export function junkNote(rel, text) {
  const { props, end } = parseFrontmatter(text);
  const source = String(props.source ?? '');
  if (!/^quorum(-dev)?$/.test(source) || props.imported_by === 'agent') return null;
  const recorded = props.recorded === true || props.recorded === 'true' || props.type !== 'note' || !!props.transcript;
  const rest = text.slice(end).replace(/^-{3}\r?\n/, '');
  const h1 = rest.match(/^\s*#\s+(.+)$/m);
  const title = (typeof props.title === 'string' && props.title.trim()) || h1?.[1]?.trim() || '';
  const body = h1 ? rest.replace(h1[0], '') : rest;
  const j = junkOf({ title, body, hasRecording: recorded, hasTranscript: /^#{1,3}\s+Transcript\b/im.test(body) });
  return j ? { key: String(props.quorum_id ?? '').trim() || rel, title: title || path.posix.basename(rel, '.md'), reason: j.reason } : null;
}
// the last n bytes of a file, from the first whole line in them
function tail(p, n) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, n);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd != null) closeSync(fd); }
}

// a line appended under a heading; the heading is added at the end when the note lacks it. The whole note is left as
// it was otherwise. False when the line is already there
export function appendUnder(text, heading, line) {
  if (text.includes(line)) return null;
  const lines = text.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (at < 0) return [...lines, '', heading, '', line, ''].join('\n');
  // the section runs to the next heading of any level
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  // an empty section gets a blank line between the heading and its first item, as the other sections have
  lines.splice(end, 0, ...(end === at + 1 ? ['', line] : [line]));
  return lines.join('\n') + '\n';
}

// the learned block: a marked list, newest last, with no repeats (factKey, cli/learned.mjs)
const factDate = (l) => l.match(CITE_RE)?.[0].match(/\d{4}-\d{2}-\d{2}/)[0] ?? null;
// a line with its citation swapped for a newer one; the wording and a #keep marker stay as they were
const withCite = (line, cite) => (CITE_RE.test(line) ? line.replace(CITE_RE, cite) : line.replace(/\s*(#keep\s*)?$/i, (_m, k) => ` ${cite}${k ? ` ${k.trim()}` : ''}`));
export const learnedChars = (lines) => lines.reduce((n, l) => n + l.length + 1, 0);

// the lines that fit the budget, oldest in the list first: the block is kept newest last, and a fact confirmed again
// moves to the end, so position is the order the lines were written. Cited lines go before lines without a citation
// (most likely written by hand); a #keep line is never dropped, so kept lines alone can run over. maxLines caps the
// number of lines as well
export function pruneLearned(lines, budget = LEARNED_BUDGET, maxLines = Infinity) {
  let total = learnedChars(lines);
  let count = lines.length;
  const order = lines.map((l, i) => ({ l, i, cited: CITE_RE.test(l) })).filter((x) => !KEEP_RE.test(x.l))
    .sort((x, y) => (x.cited ? 0 : 1) - (y.cited ? 0 : 1) || x.i - y.i);
  const out = new Set();
  for (const x of order) {
    if (total <= budget && count <= maxLines) break;
    out.add(x.i);
    total -= x.l.length + 1;
    count--;
  }
  return { kept: lines.filter((_, i) => !out.has(i)), dropped: lines.filter((_, i) => out.has(i)) };
}

const learnedBlock = (lines, budget, maxLines) => [LEARNED_OPEN, '## Learned from meetings', '',
  `Facts Quorum picked up from meeting notes, newest last. The list stays under ${budget.toLocaleString('en-US')} characters${Number.isFinite(maxLines) ? ` and ${maxLines} lines` : ''}: when it runs over, the oldest lines move to Quorum's changelog (Settings, Memory). Add #keep to a line to hold it. Edit or delete any line.`,
  '', ...lines, LEARNED_CLOSE].join('\n');
const putBlock = (text, block) => {
  const at = blockAt(text);
  if (at) return text.slice(0, at[0]) + block + text.slice(at[1]);
  return text.replace(/\s*$/, '') + '\n\n' + block + '\n';
};

// facts into the block, then the block pruned to the budget. A new fact is appended; a fact already there keeps its
// line, takes the newer citation and moves to the end. With no facts this only applies the budget. null when the text
// would not change. dropped lists the lines that left the block, for the changelog
export function addLearned(text, facts, { budget = LEARNED_BUDGET, maxLines = Infinity } = {}) {
  const out = learnedLines(text);
  for (const f of facts) {
    const line = `- ${f.replace(/^[-*]\s*/, '').trim()}`;
    const k = factKey(line);
    if (!k) continue;
    const i = out.findIndex((l) => factKey(l) === k);
    if (i < 0) { out.push(line); continue; }
    const nd = factDate(line);
    const od = factDate(out[i]);
    if (nd && (!od || nd > od)) { const next = withCite(out[i], line.match(CITE_RE)[0]); out.splice(i, 1); out.push(next); }
  }
  const { kept, dropped } = pruneLearned(out, budget, maxLines);
  if (!kept.length && !blockAt(text)) return null;
  const next = putBlock(text, learnedBlock(kept, budget, maxLines));
  return next === text ? null : { text: next, dropped };
}


export const FACTS_SYSTEM = 'You keep a short list of durable facts about a person\'s work. Answer with plain lines starting with "- " and nothing else.';
export const factsPrompt = ({ title, date, participants, body }) => [
  `From this meeting note, list up to 3 facts worth remembering for months: people and their roles, project decisions, commitments with dates. One line each, under 20 words, no filler, no speculation. Write "- none" when nothing qualifies.`,
  `Meeting: ${title} (${date}). Participants: ${participants.join(', ') || 'unknown'}.`,
  '', body.slice(0, 6000),
].join('\n');
// a fact worth a line: false for one whose whole content says the note is empty or holds no decisions, commitments,
// action items or summary, and for one too short to say anything (under 3 words, or under 4 characters in a script
// written without spaces, such as Chinese or Japanese). Each pattern has to match the whole line, so a fact that only
// starts the same way ("No new hires until March", "None of the vendors met the SLA") stays
const NOTE_SUBJECT = String.raw`(?:the |this )?(?:meeting |call )?(?:note|notes|meeting|transcript|summary|record|recording|call|discussion)(?: note)?`;
const EMPTY_ITEM = String.raw`(?:clear |specific |notable |recorded |explicit |new |further |other )?(?:decisions?|commitments?|action items?|actions?|summary|summaries|next steps?|content|details?|takeaways?|outcomes?|facts?|information|agenda items?)`;
const EMPTY_LIST = String.raw`${EMPTY_ITEM}(?:(?:,\s*|\s+)(?:(?:and|or|nor)\s+)?${EMPTY_ITEM})*`;
const EMPTY_TAIL = String.raw`(?: (?:were|was|are|is|have been|has been))?(?: (?:recorded|made|captured|noted|discussed|given|listed|mentioned|identified|agreed|reached))?(?: (?:in|from|during|for) (?:the |this )?(?:meeting|note|call|discussion|transcript))?`;
const EMPTY_FACT_RES = [
  new RegExp(`^${NOTE_SUBJECT} (?:records?|contains?|has|have|had|includes?|lists?|shows?|mentions?|captures?|provides?|gives?|documents?) (?:no|nothing|none)(?: ${EMPTY_LIST})?${EMPTY_TAIL}$`, 'i'),
  new RegExp(`^${NOTE_SUBJECT} (?:is|was|are|were|appears?|seems?|appears? to be|seems? to be) (?:empty|blank|missing|unavailable)$`, 'i'),
  new RegExp(`^(?:there (?:is|are|was|were) )?no ${EMPTY_LIST}${EMPTY_TAIL}$`, 'i'),
  /^(?:an? )?(?:empty|blank) (?:note|meeting|transcript|summary)$/i,
  /^(?:none|n\/a|not applicable|nothing)$/i,
  /^nothing (?:to (?:note|record|remember|report)|qualifies|of note|notable)$/i,
];
// a fact as the patterns read it: one space between words, without quotes around it, trailing punctuation or a
// trailing parenthetical such as "(meeting cancelled)"
const bareFact = (t) => {
  let out = t.replace(/\s+/g, ' ').replace(/^["'“”‘’]+/, '');
  for (let prev = null; prev !== out;) { prev = out; out = out.replace(/\s*\([^()]*\)\s*$/, '').replace(/[\s.!?;:,"'“”‘’]+$/, ''); }
  return out;
};
const NO_SPACE_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;
export function informative(fact) {
  const t = String(fact ?? '').replace(CITE_RE, '').replace(KEEP_RE, '').replace(/^[-*]\s*/, '').trim();
  const bare = bareFact(t);
  if (EMPTY_FACT_RES.some((re) => re.test(bare))) return false;
  const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return words >= 3 || (t.match(NO_SPACE_SCRIPT_RE)?.length ?? 0) >= 4;
}
// the model's lines, with facts that carry nothing left out before the list is deduplicated
export const parseFacts = (out) => String(out ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l && informative(l)).slice(0, 3);

// Links the first plain mention of each name in a note's body to the memory it was filed into: "Ana Ruiz" becomes
// [[ana-ruiz|Ana Ruiz]]. Frontmatter, headings, code blocks and text already inside a link stay as they are, and a
// name whose note the body already links to is left alone. Pure
export function linkMentions(text, links) {
  const fm = String(text).match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
  let body = String(text).slice(fm.length);
  for (const { name, target } of links) {
    if (!name || name.length < 3 || body.includes(`[[${target}`)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[|])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=[^\\p{L}\\p{N}\\]|]|$)`, 'iu');
    let fence = false, done = false;
    body = body.split('\n').map((line) => {
      if (/^\s*```/.test(line)) { fence = !fence; return line; }
      if (done || fence || /^\s*#/.test(line)) return line;
      // only outside existing [[links]]
      const parts = line.split(/(\[\[[^\]]*\]\])/);
      for (let i = 0; i < parts.length && !done; i += 2) {
        const m = parts[i].match(re);
        if (m) { parts[i] = parts[i].slice(0, m.index + m[1].length) + `[[${target}|${m[2]}]]` + parts[i].slice(m.index + m[0].length); done = true; }
      }
      return parts.join('');
    }).join('\n');
  }
  return fm + body;
}

// The typed edges of a filed meeting (graph/store.js): each person the keeper matched attended it, it mentions each
// project it names, and each decision line the graph holds for it was decided in it. Ids as the graph extracts them
// (graph/extract.js entityId); rule provenance, since they come from the keeper's name match. have(edge) answers true
// for an edge the graph holds already, which is left out. backed(rel): the id of the entity node the note backs in the
// graph, which goes by its path when another note shares its name. Pure
export function meetingEdges({ rel, props = {}, date, people = [], projects = [], decisions = [], at = Date.now(), have = () => false, backed = () => null }) {
  const meeting = entityId(noteKind(rel, props).kind, rel);
  const day = Date.parse(String(date ?? '').slice(0, 10));
  const from = Number.isFinite(day) ? day : null;
  const idOf = (r, fallback) => { const b = backed(r); if (b) return b; const k = noteKind(r, {}).kind; return entityId(k === 'note' ? fallback : k, r); };
  // by: the keeper's own edges, which the graph keeps when it reads the note again (graph/index.js)
  const edge = (src, dst, kind, line = null, confidence = 0.9) => ({ src, dst, kind, provenance: 'rule', source_rel: rel, source_line: line, confidence, valid_from: from, recorded_at: at, props: { by: 'keeper' } });
  return [
    ...people.map((p) => edge(idOf(p, 'person'), meeting, 'attended')),
    ...projects.map((p) => edge(meeting, idOf(p, 'project'), 'mentions')),
    ...decisions.map((d) => edge(d.id, meeting, 'decided_in', d.line ?? null, 0.8)),
  ].filter((e) => !have(e));
}

// graph: the memory graph's store (graph/store.js) or null while it is not open; a filed meeting's typed edges go there.
// dataDir: Quorum's data folder, which holds the keeper's state per vault (keeperHome)
export function createKeeper({ onStep = () => {}, brain, settings, saveSettings = () => {}, guards = () => null, wouldBlock = () => null, runText = null, hasModel = () => false, owner = () => '', log = () => {}, onChange = () => {}, errorLog = null, versions = null, live = null, onGuarded = () => {}, graph = () => null, dataDir }) {
  // factsBudget is null until the user picks one, folder until the user picks a Quorum folder
  // meetingsIndex writes the meeting index lines to <meetings folder>/index.md while the vault owns the root index
  const conf = () => ({ on: settings.keeper?.on ?? settings.brainMade === 'quorum', factsBudget: settings.keeper?.factsBudget ?? null, folder: settings.keeper?.folder ?? null, meetingsIndex: settings.keeper?.meetingsIndex === true });
  // the list's budget: the user's pick, else LEARNED_BUDGET
  const budgetFor = () => ({ budget: conf().factsBudget ?? LEARNED_BUDGET, maxLines: Infinity });
  // the facts file, vault-relative: learned-facts.md in the Quorum folder
  const factsFor = (vault) => `${quorumFolder(vault, conf().folder)}/${FACTS_NAME}`;
  // where an earlier version put the facts note by default: the knowledge folder (05-knowledge or knowledge), else the
  // root. A list there moves into the facts file once saveFacts proves the note Quorum's, also with no state
  const oldNotes = (vault) => {
    let names = [];
    try { names = readdirSync(vault).filter((n) => !n.startsWith('.')).sort(); } catch {}
    const k = names.find((n) => /^knowledge$/i.test(n.replace(/^\d+[-_ ]*/, '')) && isDir(path.join(vault, n)));
    return [...(k ? [`${k}/quorum-learned.md`] : []), 'quorum-learned.md'];
  };
  let running = null;
  let queued = null;
  let timer = null;
  let lastRun = null;

  const home = (vault) => keeperHome(dataDir, vault);
  const stateFile = (vault) => path.join(home(vault), KEEPER_FILE);
  const changelogFile = (vault) => path.join(home(vault), CHANGELOG);
  const keptOf = (vault) => { migrate(vault); return readKept(home(vault)); };
  // state an earlier version kept in the vault's .quorum folder moves to the data folder, once per vault: each file is
  // copied, read back, and removed from the vault only when the copy holds the same text. A file the data folder has
  // already stays in the vault as it is, so nothing is lost. The .quorum folder goes when nothing else is left in it
  const migrated = new Set();
  const migrate = (vault) => {
    if (migrated.has(vault)) return;
    migrated.add(vault);
    for (const [name, rel] of LEGACY_STATE) {
      const from = path.join(vault, rel);
      const text = read(from);
      if (text == null) continue;
      const to = path.join(home(vault), name);
      try {
        if (!existsSync(to)) { mkdirSync(home(vault), { recursive: true }); writeAtomic(to, text); }
        if (read(to) === text) rmSync(from, { force: true });
        else log('keeper', `${rel} stays in the vault: Quorum's data folder holds another copy`);
      } catch (e) { log('keeper', `${rel} could not move to Quorum's data folder`, e?.message); }
    }
    try { rmdirSync(path.join(vault, '.quorum')); } catch { /* not empty, or not there */ }
  };
  // a vault note the keeper writes or removes keeps its earlier text as a version (memoryVersions.js); why is the
  // reason the version shows, set by each pass that writes. keeper.json and the changelog are not versioned
  let why = { reason: 'Upkeep', agent: true };
  // the run in progress in the Memory tab (liveRuns.js): each note written is named to it with its version. stopping
  // is set by halt; the next write then throws, the run ends, and the files it changed are put back from the versions
  let liveRun = null;
  let stopping = false;
  const stopped = () => Object.assign(new Error('Stopped from the Memory tab'), { stopped: true });
  const writeNote = (vault, abs, next) => {
    if (stopping) throw stopped();
    const before = versions ? read(abs) : null;
    writeAtomic(abs, next);
    const rel = posix(path.relative(vault, abs));
    const r = versions?.record({ vault, rel, before, after: next, who: 'keeper', ...why });
    if (liveRun) live?.touch(liveRun, rel, r?.version.id ?? null);
  };
  const removeNote = (vault, abs) => {
    if (stopping) throw stopped();
    const before = versions ? read(abs) : null;
    rmSync(abs, { force: true });
    const rel = posix(path.relative(vault, abs));
    const r = before != null ? versions?.record({ vault, rel, before, after: null, who: 'keeper', ...why }) : null;
    if (liveRun) live?.touch(liveRun, rel, r?.version.id ?? null);
  };
  // asks the running pass to stop and waits for it; a pass waiting to be scheduled is dropped too
  const halt = async () => {
    stopping = true;
    clearTimeout(timer);
    timer = null;
    try { await running?.catch(() => {}); } finally { stopping = false; }
  };
  // made is a Set in memory and an array in the file. A keeper.json from before made existed gets it from provenMade.
  // fresh: no keeper.json on this Mac yet (another Mac filed this vault, the folder moved to another volume, or Delete
  // my data ran); run then takes the notes Quorum's index lists as filed. It is never saved
  const loadState = (vault) => {
    migrate(vault);
    let st;
    try { st = JSON.parse(readFileSync(stateFile(vault), 'utf8')); } catch { st = { done: {}, fresh: true }; }
    st.made = new Set(Array.isArray(st.made) ? st.made : provenMade(vault));
    return st;
  };
  // the home also records the vault's path, which keeperHome reads to tell two folders with one inode apart
  const saveState = (vault, st) => {
    mkdirSync(home(vault), { recursive: true });
    const { fresh, ...keep } = st;
    writeAtomic(stateFile(vault), JSON.stringify({ ...keep, made: [...(st.made ?? [])] }, null, 2) + '\n');
    writeAtomic(path.join(home(vault), VAULT_FILE), JSON.stringify({ path: path.resolve(vault) }) + '\n');
  };
  // the files an earlier keeper made, for a keeper.json without made: a file the changelog names whose text is still
  // only what the keeper writes (an index under INDEX_HEADER or MEETINGS_HEADER, a daily note of meeting lines and
  // nothing else). Anything it cannot prove stays the person's. Worked out once per vault until a run saves made
  const proven = new Map();
  const provenMade = (vault) => {
    if (proven.has(vault)) return proven.get(vault);
    const log = read(changelogFile(vault)) ?? '';
    const named = new Set(log.split('\n').map((l) => l.match(/^- ([^[\n]+\.md)$/)?.[1]).filter(Boolean));
    const out = [...named].filter((rel) => {
      const cur = read(path.join(vault, rel));
      if (cur == null) return false;
      const base = path.posix.basename(rel);
      return (rel === 'index.md' && cur.startsWith(INDEX_HEADER)) || (base === 'index.md' && cur.startsWith(MEETINGS_HEADER)) || KEEPER_DAILY_RE.test(cur);
    }).sort();
    proven.set(vault, out);
    return out;
  };

  // the plugin rows for this vault, and the daily naming it uses. The rows are the only record of whether facts are on;
  // the older facts switch, saved as off before plugins existed, reads as the vault owning facts until the user picks
  // on the plugin row, which clears it
  // connectBrain saves brainMade null for a folder the person connected; that folder keeps unsaved jobs with its own setup
  const registry = (b) => {
    const f = folders(b.vault);
    let rows = resolvePlugins(settings.plugins, { built: settings.brainMade !== null });
    if (settings.keeper?.facts === false && !settings.plugins?.facts) rows = rows.map((r) => (r.id === 'facts' ? { ...r, owner: 'vault' } : r));
    let daily = [];
    if (f.daily) { try { daily = readdirSync(path.join(b.vault, f.daily)).filter((n) => !n.startsWith('.')).sort(); } catch {} }
    return { vault: b.vault, f, rows, daily: f.daily ? dailyPattern(daily).template : DAILY_DEFAULT, made: starterMade(b) };
  };
  // the files the starter wrote, vault-relative, when Quorum built the folder; a folder the person connected has none
  // worked out again only when setup.json changes (a rerun of the setup adds files)
  let starterCache = null;
  const starterMade = (b) => {
    if (settings.brainMade !== 'quorum') return new Set();
    let mtime;
    try { mtime = statSync(path.join(b.root, SETUP_FILE)).mtimeMs; } catch { return new Set(); }
    const key = `${b.root}\n${b.vault}\n${mtime}`;
    if (starterCache?.key === key) return starterCache.made;
    const setup = readSetup(b.root);
    let files = {};
    try { if (setup?.answers) files = plan({ name: setup.name, answers: setup.answers }).files; } catch {}
    starterCache = { key, made: new Set(Object.keys(files).map((rel) => posix(path.relative(b.vault, path.join(b.root, rel))))) };
    return starterCache.made;
  };
  // whether a file is Quorum's (see the top of this file), and whether the keeper may write it: a file that does not
  // exist yet is made by the keeper and recorded as its own. Read from the file itself first, so it holds on any Mac
  // and with no state: the mark (QUORUM_MARK), or for a file an earlier version wrote with no mark, its text is still
  // only what the keeper writes at that path (a facts file, an index under INDEX_HEADER or MEETINGS_HEADER, a daily
  // note of meeting lines). Each write the keeper makes to its own file adds the mark when it is missing (own)
  const provenByText = (reg, rel, cur) => {
    const body = bodyText(cur);
    const base = path.posix.basename(rel);
    return isFactsFile(cur) || (rel === 'index.md' && body.startsWith(INDEX_HEADER)) || (base === 'index.md' && body.startsWith(MEETINGS_HEADER))
      || (!!reg.f.daily && rel.startsWith(`${reg.f.daily}/`) && KEEPER_DAILY_RE.test(body));
  };
  const quorumMade = (reg, st, rel, cur) => rel.startsWith('.quorum/') || reg.made.has(rel) || !!st.made?.has(rel) || (cur != null && (isMarked(cur) || provenByText(reg, rel, cur)));
  const own = withMark;
  const mayEdit = (reg, st, rel, cur) => cur == null || quorumMade(reg, st, rel, cur);
  const markMade = (st, rel) => { st.made ??= new Set(); st.made.add(rel); };

  // an upkeep error goes to the console and to a log file under Application Support, which the settings page counts.
  // Past ERR_MAX bytes the file is cut to its last ERR_KEEP lines, and status reads only that much from its end
  // a stop from the Memory tab is passed on to the run, which ends without logging an error
  const fail = (where, e) => {
    if (e?.stopped) throw e;
    const message = String(e?.message || e).slice(0, 300);
    log(`keeper ${where} failed`, message);
    if (!errorLog) return;
    try {
      mkdirSync(path.dirname(errorLog), { recursive: true });
      appendFileSync(errorLog, JSON.stringify({ at: new Date().toISOString(), where, message }) + '\n');
      if (statSync(errorLog).size > ERR_MAX) writeAtomic(errorLog, (read(errorLog) ?? '').split('\n').filter(Boolean).slice(-ERR_KEEP).join('\n') + '\n');
    } catch {}
  };
  const errors = () => {
    const lines = errorLog ? tail(errorLog, ERR_MAX).split('\n').filter(Boolean) : [];
    let last = null;
    try { last = lines.length ? JSON.parse(lines.at(-1)) : null; } catch {}
    return { count: lines.length, last, file: errorLog };
  };
  const clearErrors = () => { if (errorLog) rmSync(errorLog, { force: true }); return status(); };

  // the facts file is linked from index.md only while Quorum owns the index job and index.md exists and is not marked
  // generated; an index the vault keeps itself is never written to. unlinkNote takes out only the line linkNote wrote
  const indexFor = (vault, reg, st) => {
    if (!owns(reg.rows, 'index')) return null;
    const abs = path.join(vault, 'index.md');
    const cur = read(abs);
    return cur == null || isGenerated(cur) || !mayEdit(reg, st, 'index.md', cur) ? null : { abs, cur };
  };
  const noteLine = (note) => `- [[${path.posix.basename(note, '.md')}]] - ${NOTE_LINK}`;
  const linkNote = (vault, reg, st, note, changed) => {
    const ix = indexFor(vault, reg, st);
    const base = path.posix.basename(note, '.md');
    if (!ix || [`[[${base}]]`, `[[${base}|`, `[[${note.replace(/\.md$/i, '')}`].some((l) => ix.cur.includes(l))) return;
    writeNote(vault, ix.abs, own(ix.cur.replace(/\s*$/, '') + '\n' + noteLine(note) + '\n'));
    changed.push('index.md');
  };
  const unlinkNote = (vault, reg, st, note, changed) => {
    const ix = indexFor(vault, reg, st);
    const line = noteLine(note);
    if (!ix || !ix.cur.split('\n').includes(line)) return;
    writeNote(vault, ix.abs, own(ix.cur.split('\n').filter((l) => l !== line).join('\n')));
    changed.push('index.md');
  };

  // the list into the facts file, with new facts, under the budget. A list an earlier version kept in a file Quorum made
  // (.quorum/learned.md, a vault note picked in Settings, the facts file of another Quorum folder) moves in once: that
  // file loses its block, and is removed with its index line when nothing else is in it. A list in a file the person
  // made (CLAUDE.md, AGENTS.md, any other note) is never read or written here; the keeper lines rule
  // (rules/keeperLines.js) offers that move in Needs review. A source is cleared only once the facts file holds the
  // list. A facts file marked generated, or one the person made, stops the write, changes nothing and is logged, and so
  // does a source marked generated. dropped gets only lines that really left a written list. With noCreate (a held run)
  // a facts file that does not exist yet is left uncreated; the run counts it in createsFor and asks for the facts again
  // once it may create files
  const saveFacts = (vault, reg, st, facts, changed, dropped, { noCreate = false } = {}) => {
    const file = factsFor(vault);
    const abs = path.join(vault, file);
    const cur = read(abs);
    if (cur != null && isGenerated(cur)) { fail('facts', `${file} is marked as generated, so learned facts were not written`); return; }
    if (!mayEdit(reg, st, file, cur)) { fail('facts', `${file} was not made by Quorum, so learned facts were not written. Pick another Quorum folder in Settings`); return; }
    const olds = [...new Set([LEGACY_LEARNED, st.factsNoteAt, ...oldNotes(vault)])].filter((rel) => rel && rel !== file)
      .map((rel) => ({ rel, text: read(path.join(vault, rel)) }))
      .filter((o) => o.text != null && !isGenerated(o.text) && !!blockAt(o.text) && quorumMade(reg, st, o.rel, o.text));
    if (cur == null && noCreate) return;
    const r = addLearned(cur ?? LEARNED_HEADER, [...olds.flatMap((o) => learnedLines(o.text)), ...facts], budgetFor());
    if (r) {
      if (cur == null) markMade(st, file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeNote(vault, abs, own(r.text));
      changed.push(file);
      dropped.push(...r.dropped);
    }
    if (!r && cur == null) return;
    st.factsNoteAt = file;
    for (const o of olds) {
      const oabs = path.join(vault, o.rel);
      const rest = dropBlock(o.text);
      if (o.rel !== LEGACY_LEARNED && bodyText(rest).trim() !== LEARNED_HEADER.trim()) { writeNote(vault, oabs, own(rest)); changed.push(o.rel); continue; }
      removeNote(vault, oabs);
      changed.push(o.rel);
      if (o.rel === LEGACY_LEARNED) { try { rmdirSync(path.join(vault, '.quorum')); } catch { /* setup.json or other files stay */ } } else unlinkNote(vault, reg, st, o.rel, changed);
    }
    linkNote(vault, reg, st, file, changed);
  };
  const placeFacts = saveFacts;
  // one dated entry at the end of the keeper's changelog, which is made with its header when missing
  const appendChangelog = (vault, title, body) => {
    const abs = changelogFile(vault);
    mkdirSync(path.dirname(abs), { recursive: true });
    const entry = `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${title}\n\n${body}`;
    writeAtomic(abs, (read(abs) ?? '# Changelog\n\nWhat the keeper changed, newest last. Each entry names the files it touched for one meeting note.\n\n') + entry);
  };
  const logChange = (vault, title, changed, dropped) => {
    const files = [...new Set(changed)];
    if (!files.length) return;
    const pruned = dropped.length ? `Moved out of the learned facts to stay under the budget:\n\n${dropped.join('\n')}\n\n` : '';
    appendChangelog(vault, title, `${files.map((c) => `- ${c}`).join('\n')}\n\n${pruned}`);
  };
  // an entry when the keeper leaves index.md alone (the vault owns the index job, or index.md is marked generated),
  // saying where the meeting index lines went: the meetings folder's index.md, held until the run may create it, or
  // nowhere. It is written once per change of that state (kept in keeper.json as indexSkip), so runs do not repeat it
  const logIndexSkip = (vault, reg, st, marked) => {
    const why = !owns(reg.rows, 'index') ? 'index.md is kept by your Agent OS' : marked.includes('index.md') ? 'index.md is marked as generated' : !rootIndex(reg, st) ? 'Quorum did not make index.md' : null;
    if (!why) { delete st.indexSkip; return; }
    const ix = indexFile(reg, st);
    const rel = ix && ix.rel !== 'index.md' ? ix.rel : null;
    const cur = rel ? read(path.join(vault, rel)) : null;
    const outcome = !rel ? 'none' : marked.includes(rel) || (cur != null && isGenerated(cur)) ? 'generated' : cur == null ? 'held' : 'written';
    const key = `${why}|${outcome}|${rel ?? ''}`;
    if (st.indexSkip === key) return;
    st.indexSkip = key;
    const then = {
      none: 'so the keeper leaves it unchanged and writes no meeting index lines.',
      written: `so the keeper leaves it unchanged. Meeting index lines go to ${rel}.`,
      held: `so the keeper leaves it unchanged. Meeting index lines wait for ${rel}, which the held run has not created yet.`,
      generated: `so the keeper leaves it unchanged. ${rel} is marked as generated too, so no meeting index lines were written.`,
    }[outcome];
    appendChangelog(vault, 'Index skipped', `${why}, ${then}\n\n`);
  };
  // the list put in its place and trimmed to the budget, outside of filing a note: each run, and when the budget is
  // lowered or the file picked again
  const tidyFacts = (vault, reg, st) => {
    const changed = [];
    const dropped = [];
    if (!owns(reg.rows, 'facts')) return changed;
    why = { reason: 'Kept the learned facts in place and under budget', agent: true };
    try { placeFacts(vault, reg, st, [], changed, dropped); } catch (e) { fail('facts', e); }
    logChange(vault, 'Learned facts', changed, dropped);
    return changed;
  };

  const meetingNotes = (vault, dir) => {
    const out = [];
    const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = path.join(d, n); if (n.startsWith('.')) continue; if (isDir(p)) walk(p); else if (n.endsWith('.md') && n !== 'README.md' && n !== 'index.md') out.push(path.relative(vault, p).split(path.sep).join('/')); } };
    try { walk(path.join(vault, dir)); } catch {}
    return out;
  };

  const meta = (rel, text) => {
    const { props } = parseFrontmatter(text);
    const base = path.posix.basename(rel, '.md');
    const title = (typeof props.title === 'string' && props.title) || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || base;
    const date = String(props.date ?? '').slice(0, 10) || base.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || today();
    return { props, base, title, date };
  };

  // one note into the folder: index, daily, people, projects, facts, each only when Quorum owns that job; returns the
  // list of files changed. A file whose first lines say it is generated is left alone and named in marked. With
  // noCreate, the index and the daily note are written only when they exist already; those are the files a held run
  // counts
  async function file(vault, reg, st, rel, text, { facts, marked, left = [], noCreate = false }) {
    const { f, rows, daily } = reg;
    const changed = [];
    const { props, base, title, date } = meta(rel, text);
    why = { reason: `Filed the meeting ${title}`, agent: true };
    // each step shows on the note's page while it runs
    const step = (t) => { try { onStep(rel, t); } catch { /* the page is gone */ } };
    step('Checking related notes and links');
    const people = (Array.isArray(props.participants) ? props.participants : []).map((p) => String(p).replace(/\s*\(recorder\)\s*$/i, '').trim()).filter((p) => p && p.toLowerCase() !== owner().toLowerCase());
    const link = `[[${base}]]`;
    // a file the person made is left as it is, and named in left
    const touch = (abs, next, cur) => {
      if (next == null) return;
      const r = posix(path.relative(vault, abs));
      if (cur != null && isGenerated(cur)) {
        if (!marked.includes(r)) marked.push(r);
        return;
      }
      if (!mayEdit(reg, st, r, cur)) { if (!left.includes(r)) left.push(r); return; }
      if (cur == null) markMade(st, r);
      writeNote(vault, abs, own(next));
      changed.push(path.relative(vault, abs));
      step(`Updated ${path.basename(abs, '.md')}`);
    };
    // index: one line per note, in the file indexFile names
    const ix = indexFile(reg, st);
    if (ix) step('Adding it to the index');
    if (ix && !(noCreate && !existsSync(path.join(vault, ix.rel)))) {
      const indexAbs = path.join(vault, ix.rel);
      const cur = read(indexAbs);
      const index = cur ?? ix.header;
      if (!hasIndexLine(index, link)) touch(indexAbs, index.replace(/\s*$/, '') + '\n' + `- ${link} - meeting ${date}: ${title}` + '\n', cur);
    }
    // daily note, named the way the vault already names them
    if (f.daily && owns(rows, 'daily')) {
      step('Linking it from the daily note');
      const abs = path.join(vault, f.daily, dailyName(daily, date));
      const cur = read(abs);
      if (!(noCreate && cur == null)) touch(abs, appendUnder(cur ?? `# ${date}\n`, '## Meetings', `- ${link} ${title}`), cur);
    }
    // memories this note was filed into, linked inline in it once filing is done
    const inline = [];
    // the people and project notes it was filed into, for the typed edges
    const filed = { people: [], projects: [] };
    // people: a note per participant, matched by slug
    if (f.people && owns(rows, 'links')) {
      if (people.length) step(`Checking notes for ${people.length} ${people.length === 1 ? 'person' : 'people'}`);
      for (const p of people) {
        const abs = path.join(vault, f.people, `${slug(p)}.md`);
        const cur = read(abs);
        if (cur != null) { touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur); inline.push({ name: p, target: slug(p) }); filed.people.push(posix(path.join(f.people, `${slug(p)}.md`))); }
      }
    }
    // projects: a note whose title appears in the meeting text
    if (f.projects && owns(rows, 'links')) {
      step('Looking for projects it mentions');
      const body = text.toLowerCase();
      let names = [];
      try { names = readdirSync(path.join(vault, f.projects)).filter((n) => n.endsWith('.md') && n !== 'README.md'); } catch {}
      for (const n of names) {
        const abs = path.join(vault, f.projects, n);
        const cur = read(abs);
        if (cur == null) continue;
        const name = (parseFrontmatter(cur).props.title ?? cur.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(n, '.md')).toString().trim();
        if (name.length < 3) continue;
        const hit = new RegExp(`(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(body);
        if (hit) { touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur); inline.push({ name, target: path.basename(n, '.md') }); filed.projects.push(posix(path.join(f.projects, n))); }
      }
    }
    // the same links inline in the meeting note: a name it mentions points at the memory it was filed into. Only in a
    // note Quorum wrote or imported; any other note is left as the person wrote it
    if (inline.length) {
      const own = /^source:\s*"?quorum(-dev)?"?\s*$/m.test(text) || /^imported_by:\s*"?agent"?\s*$/m.test(text);
      const linked = linkMentions(text, inline);
      if (linked !== text && own) {
        step('Linking the names it mentions to their memories');
        writeNote(vault, path.join(vault, rel), linked);
        changed.push(rel);
      }
    }
    // the typed edges in the memory graph: attended, mentions, decided_in. The graph is derived data, so a failure here
    // is logged and filing goes on
    const store = graph();
    if (store) {
      try {
        const r = posix(rel);
        const decisions = store.nodesByRel(r).filter((x) => x.kind === 'decision').map((x) => ({ id: x.id, line: x.props?.line ?? null }));
        const have = (e) => store.edgesOf(e.src, { dir: 'out', kinds: [e.kind], current: true }).some((x) => x.dst === e.dst);
        const backed = (p) => store.nodesByRel(p).find((x) => ['person', 'project', 'company', 'topic'].includes(x.kind))?.id ?? null;
        const edges = meetingEdges({ rel: r, props, date, people: filed.people, projects: filed.projects, decisions, have, backed });
        store.tx(() => { for (const e of edges) store.addEdge(e); });
      } catch (e) { fail('graph', e); }
    }
    // learned facts, with the person's own model source, into the learned list (saveFacts); lines pruned to fit the
    // budget are kept in the changelog entry
    const dropped = [];
    if (facts && owns(rows, 'facts') && runText && hasModel()) {
      step('Learning facts from it');
      try {
        const out = await runText(factsPrompt({ title, date, participants: people, body: text.slice(parseFrontmatter(text).end) }), FACTS_SYSTEM);
        const got = parseFacts(out).map((g) => `${g} (${link}, ${date})`);
        if (got.length) placeFacts(vault, reg, st, got, changed, dropped, { noCreate });
      } catch (e) { fail('facts', e); }
    }
    logChange(vault, title, changed, dropped);
    return changed;
  }

  const hasIndexLine = (index, link) => index.includes(`${link} `) || index.includes(`${link}]`) || index.includes(`${link}\n`);
  // the meetings folder's index.md, filled once with the meetings filed before it was turned on (kept in keeper.json as
  // meetingsIndexAt). null when it is off, or the root index is Quorum's
  const backfillFor = (reg, st) => {
    const ix = indexFile(reg, st);
    return ix && ix.rel !== 'index.md' && st.meetingsIndexAt !== ix.rel ? ix : null;
  };
  // index lines for the meetings filed already: unchanged since filing and not withheld. Into an existing file, or a
  // new one when the run may create files; a file marked generated is named in marked and left alone
  const backfill = (vault, reg, ix, st, notes, compiled, marked, mayCreate) => {
    const abs = path.join(vault, ix.rel);
    const cur = read(abs);
    if (cur != null && isGenerated(cur)) { if (!marked.includes(ix.rel)) marked.push(ix.rel); st.meetingsIndexAt = ix.rel; return []; }
    if (cur != null && !mayEdit(reg, st, ix.rel, cur)) { st.meetingsIndexAt = ix.rel; return []; }
    if (cur == null && !mayCreate) return [];
    why = { reason: 'Added earlier meetings to the meetings index', agent: true };
    let index = cur ?? ix.header;
    for (const { rel, text } of notes) {
      if (st.done[rel] !== sha(text) || (compiled && wouldBlock(compiled, rel, text.slice(0, 2000)))) continue;
      const { base, title, date } = meta(rel, text);
      if (!hasIndexLine(index, `[[${base}]]`)) index = index.replace(/\s*$/, '') + '\n' + `- [[${base}]] - meeting ${date}: ${title}` + '\n';
    }
    st.meetingsIndexAt = ix.rel;
    if (index === cur || (cur == null && index === ix.header)) return [];
    if (cur == null) markMade(st, ix.rel);
    writeNote(vault, abs, own(index));
    return [ix.rel];
  };
  // the file a note's index line goes into: index.md while Quorum owns the index job; while the vault owns it, the
  // meetings folder's own index.md when the user turned that on; else none
  // the root index.md takes the lines while Quorum owns the index job and may write it; when Quorum owns the job but
  // the person made index.md, the lines go to the meetings folder's index.md instead
  // worked out once per registry, so once per run; a run that makes index.md finds it its own either way
  const rootIndex = (reg, st) => {
    if (reg.rootIndex == null) { const cur = read(path.join(reg.vault, 'index.md')); reg.rootIndex = (cur != null && isGenerated(cur)) || mayEdit(reg, st, 'index.md', cur); }
    return reg.rootIndex;
  };
  const indexFile = (reg, st) => {
    if (owns(reg.rows, 'index') && rootIndex(reg, st)) return { rel: 'index.md', header: INDEX_HEADER };
    if ((conf().meetingsIndex || owns(reg.rows, 'index')) && reg.f.meetings) return { rel: `${reg.f.meetings}/index.md`, header: MEETINGS_HEADER };
    return null;
  };
  // whether a note's facts would go into a facts file that does not exist yet
  const factsCreate = (vault, reg, st, n) => {
    if (!owns(reg.rows, 'facts') || !runText || !hasModel() || st.partial?.[n.rel] === n.h) return null;
    const file = factsFor(vault);
    return existsSync(path.join(vault, file)) ? null : file;
  };
  // the new files one note would add: the index when missing, its daily note when that does not exist yet, and the
  // facts file when it does not exist yet
  const createsFor = (vault, reg, st, n) => {
    const out = [];
    const ix = indexFile(reg, st);
    if (ix && !existsSync(path.join(vault, ix.rel))) out.push(ix.rel);
    const note = factsCreate(vault, reg, st, n);
    if (note) out.push(note);
    if (reg.f.daily && owns(reg.rows, 'daily')) {
      const r = `${reg.f.daily}/${dailyName(reg.daily, meta(n.rel, n.text).date)}`;
      if (!existsSync(path.join(vault, r))) out.push(r);
    }
    return out;
  };

  // every meeting note not yet filed, or changed since; one pass. When the pass would create more than CREATE_LIMIT
  // files, the notes that need a new file are held: their lines go into files that exist (links, facts, an existing
  // index), the new files are listed in held, and the notes wait in partial for a run with allowCreate. Notes that
  // need no new file are filed as usual. A partial note is never sent for facts twice. allowCreate asked for while a
  // pass is running starts a second pass after it
  async function run({ reason = 'manual', allowCreate = false } = {}) {
    if (running) {
      if (!allowCreate) return running;
      queued ??= running.then(() => { queued = null; return run({ reason, allowCreate: true }); });
      return queued;
    }
    running = (async () => {
      const b = brain();
      const c = conf();
      const result = { filed: 0, skipped: 0, changed: 0, reason, at: new Date().toISOString(), error: null, marked: [], left: [], held: null };
      if (!b || !c.on) return { ...result, off: true };
      const vault = b.vault;
      const reg = registry(b);
      if (!reg.f.meetings) return result;
      // the changelog is put back when the run is stopped, since its files are put back too
      const changelogBefore = read(changelogFile(vault));
      liveRun = live?.start({ who: 'keeper', label: 'Upkeep', stop: halt }) ?? null;
      // the state is saved even when the run fails part way, so the files it made stay recorded as Quorum's. A stopped
      // run saves nothing, so its notes are filed again on the next run
      let st = null;
      try {
        st = loadState(vault);
        st.done ??= {};
        const compiled = guards();
        const pending = [];
        const filed = [];
        for (const rel of meetingNotes(vault, reg.f.meetings)) {
          const text = read(path.join(vault, rel));
          if (text == null) continue;
          const h = sha(text);
          if (st.done[rel] === h) { filed.push({ rel, text }); continue; }
          const why = compiled ? wouldBlock(compiled, rel, text.slice(0, 2000)) : null;
          pending.push({ rel, text, h, why });
        }
        // with fresh state, a note the index Quorum keeps lists already was filed before: it counts as filed, so its
        // facts are not asked for again
        const ixf = st.fresh ? indexFile(reg, st) : null;
        const listed = ixf ? read(path.join(vault, ixf.rel)) : null;
        if (listed != null && quorumMade(reg, st, ixf.rel, listed)) {
          for (let i = pending.length - 1; i >= 0; i--) {
            const n = pending[i];
            if (n.why || !hasIndexLine(listed, `[[${path.posix.basename(n.rel, '.md')}]]`)) continue;
            st.done[n.rel] = n.h;
            filed.push({ rel: n.rel, text: n.text });
            pending.splice(i, 1);
          }
        }
        // junk notes wait for the person's decision before they are filed into the memory
        const kept = keptOf(vault);
        const junk = {};
        for (const n of [...filed, ...pending]) {
          const j = junkNote(n.rel, n.text);
          if (!j || kept[j.key]) continue;
          junk[n.rel] = { key: j.key, title: j.title, reason: j.reason, at: st.junk?.[n.rel]?.at ?? new Date().toISOString() };
        }
        if (Object.keys(junk).length) st.junk = junk; else delete st.junk;
        for (let i = pending.length - 1; i >= 0; i--) if (junk[pending[i].rel]) { pending.splice(i, 1); result.junk = (result.junk ?? 0) + 1; }
        st.partial ??= {};
        result.changed += tidyFacts(vault, reg, st).length;
        for (const n of pending) n.creates = n.why ? [] : createsFor(vault, reg, st, n);
        // the backfill ran for this target already unless the meetings index is no longer where the lines go
        if (indexFile(reg, st)?.rel !== st.meetingsIndexAt) delete st.meetingsIndexAt;
        const fill = filed.length ? backfillFor(reg, st) : null;
        // with nothing filed yet there is nothing to fill in: the notes of this run write their own lines
        if (!filed.length) { const ix = indexFile(reg, st); if (ix && ix.rel !== 'index.md') st.meetingsIndexAt = ix.rel; }
        const creates = [...new Set([...pending.flatMap((n) => n.creates), ...(fill && !existsSync(path.join(vault, fill.rel)) ? [fill.rel] : [])])].sort();
        const hold = creates.length > CREATE_LIMIT && !allowCreate;
        result.held = hold ? { count: creates.length, sample: creates.slice(0, 5) } : null;
        if (hold) st.held = result.held; else delete st.held;
        let indexed = 0;
        for (const n of pending) {
          if (n.why) {
            st.done[n.rel] = n.h; result.skipped++;
            try { onGuarded(n.rel, String(n.why)); } catch {}
            st.trail ??= {};
          if (!result.trailPruned) { for (const k of Object.keys(st.trail)) if (!existsSync(path.join(vault, k))) delete st.trail[k]; result.trailPruned = true; }
            const before = Array.isArray(st.trail[n.rel]) ? st.trail[n.rel] : [];
            st.trail[n.rel] = [{ at: new Date().toISOString(), files: [], skipped: String(n.why) }, ...before].slice(0, 10);
            continue;
          }
          const waits = hold && n.creates.length > 0;
          // a held note whose facts need a new facts file waits for its facts too, so they are asked for once it may
          // create files
          const later = waits && !!factsCreate(vault, reg, st, n);
          const facts = st.partial[n.rel] !== n.h && !later;
          const left = [];
          const changed = await file(vault, reg, st, n.rel, n.text, { facts, marked: result.marked, left, noCreate: waits });
          // a note whose mentions were linked just now counts as filed in its new form, so the next run leaves it alone
          if (changed.includes(n.rel)) { const now = read(path.join(vault, n.rel)); if (now != null) n.h = sha(now); }
          result.changed += changed.length;
          // what this note was filed into, for the line above its editor (noteTrail)
          st.trail ??= {};
          const runs = Array.isArray(st.trail[n.rel]) ? st.trail[n.rel] : st.trail[n.rel] ? [st.trail[n.rel]] : [];
          st.trail[n.rel] = [{ at: new Date().toISOString(), files: [...new Set(changed.map((c) => c.split(path.sep).join('/')))] }, ...runs].slice(0, 10);
          for (const r of left) if (!result.left.includes(r)) result.left.push(r);
          st.left ??= {};
          if (left.length) st.left[n.rel] = n.h; else delete st.left[n.rel];
          indexed++;
          if (waits) { if (!later) st.partial[n.rel] = n.h; continue; }
          delete st.partial[n.rel];
          st.done[n.rel] = n.h;
          result.filed++;
        }
        if (fill) {
          const changed = backfill(vault, reg, fill, st, filed, compiled, result.marked, !hold);
          logChange(vault, 'Meetings index', changed, []);
          result.changed += changed.length;
        }
        if (indexed || fill) logIndexSkip(vault, reg, st, result.marked);
        if (st.left && !Object.keys(st.left).length) delete st.left;
        st.lastRunAt = result.at;
        st.last = result;
      } catch (e) {
        if (e?.stopped) result.stopped = true;
        else { result.error = String(e?.message || e); fail('run', e); }
      } finally {
        if (result.stopped) {
          const abs = changelogFile(vault);
          if (changelogBefore == null) rmSync(abs, { force: true }); else writeAtomic(abs, changelogBefore);
        } else if (st) {
          try { saveState(vault, st); } catch (e) { fail('run', e); }
        }
        if (liveRun) live?.end(liveRun);
        liveRun = null;
      }
      lastRun = result;
      if (result.filed || result.skipped) log('keeper', `${reason}: ${result.filed} filed, ${result.changed} files changed, ${result.skipped} withheld`);
      if (result.held) log('keeper', `${reason}: held, the run would create ${result.held.count} files`);
      if (result.changed || result.held) onChange(result);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // a note just written: filed shortly, once the burst of writes settles
  const schedule = (reason = 'note') => { clearTimeout(timer); timer = setTimeout(() => { timer = null; run({ reason }).catch(() => {}); }, 2500); };

  const status = () => {
    const b = brain();
    const c = conf();
    const st = b ? loadState(b.vault) : { done: {} };
    const reg = b ? registry(b) : null;
    return { on: c.on, meetingsIndex: c.meetingsIndex, facts: reg ? owns(reg.rows, 'facts') : false, running: !!running, lastRunAt: st.lastRunAt ?? null, filed: Object.keys(st.done ?? {}).length, last: st.last ?? lastRun, held: st.held ?? null, folders: reg?.f ?? {}, folder: b ? quorumFolder(b.vault, c.folder) : null, model: hasModel(), plugins: reg?.rows ?? [], learned: reg ? learnedStatus(b.vault, reg) : null, errors: errors(), changelog: b ? changelogFile(b.vault) : null };
  };
  // the learned list's size against its budget and its share of the file it lives in
  const learnedStatus = (vault, reg) => {
    const file = factsFor(vault);
    const text = read(path.join(vault, file)) ?? '';
    const lines = learnedLines(text);
    // how many lines picking Default would move to the changelog, for the confirm the settings page shows
    const defaultMoves = pruneLearned(lines, LEARNED_BUDGET).dropped.length;
    // the file is linked while Quorum owns the index job, also before index.md exists; indexGenerated says why not
    const index = read(path.join(vault, 'index.md'));
    const indexGenerated = owns(reg.rows, 'index') && index != null && isGenerated(index);
    return {
      file, linked: owns(reg.rows, 'index') && !indexGenerated, indexGenerated,
      budget: budgetFor().budget, budgetPick: conf().factsBudget ?? 'auto', defaultBudget: LEARNED_BUDGET, defaultMoves, chars: learnedChars(lines), fileChars: text.length,
    };
  };
  // one job handed to Quorum or to the vault. A held run planned with the old owners no longer applies, so it is
  // cleared and a new pass is scheduled
  const setPlugin = (id, to) => {
    const b = brain();
    settings.plugins = choose(settings.plugins, id, to);
    if (id === 'facts' && settings.keeper && 'facts' in settings.keeper) { settings.keeper = { ...settings.keeper }; delete settings.keeper.facts; }
    saveSettings();
    if (b) { const st = loadState(b.vault); if (st.held) { delete st.held; saveState(b.vault, st); } }
    if (conf().on) schedule('settings');
    return status();
  };
  // facts in a patch is the older switch; it now sets the facts plugin row
  const set = (patch = {}) => {
    if (typeof patch.facts === 'boolean') setPlugin('facts', patch.facts ? 'quorum' : 'vault');
    // only what the patch changes is saved, so a default changed later still reaches everyone who never picked
    const b = brain();
    const before = conf();
    const next = { ...settings.keeper };
    if (typeof patch.on === 'boolean') next.on = patch.on;
    if (typeof patch.meetingsIndex === 'boolean') next.meetingsIndex = patch.meetingsIndex;
    if (Number.isInteger(patch.factsBudget) && patch.factsBudget >= 500 && patch.factsBudget <= 20000) next.factsBudget = patch.factsBudget;
    else if (patch.factsBudget === 'auto') delete next.factsBudget;
    // the Quorum folder: a folder outside the meetings folder, which the keeper files as meetings; an empty one goes
    // back to the default. The facts file moves with it on the next tidy
    if (typeof patch.folder === 'string') {
      const rel = folderPath(patch.folder);
      const meetings = b ? folders(b.vault).meetings?.normalize('NFC').toLowerCase() : null;
      if (!patch.folder.trim()) delete next.folder;
      else if (rel && !(meetings && rel.toLowerCase().split('/')[0] === meetings)) next.folder = rel;
    }
    settings.keeper = next;
    saveSettings();
    const after = conf();
    // another budget or folder applies now, unless upkeep is off or a run is about to do it
    if (b && after.on && !running && ['factsBudget', 'folder'].some((key) => before[key] !== after[key])) {
      const st = loadState(b.vault);
      const changed = tidyFacts(b.vault, registry(b), st);
      saveState(b.vault, st);
      if (changed.length) onChange({ ...(lastRun ?? {}), changed: changed.length, reason: 'settings' });
    }
    if (after.on) schedule('settings');
    return status();
  };
  // one note's upkeep: whether upkeep is on, whether it has filed the note, when, and the files it added it to
  const noteTrail = (rel) => {
    const b = brain();
    const st = b ? loadState(b.vault) : { done: {} };
    const t = st.trail?.[rel];
    const runs = Array.isArray(t) ? t : t ? [t] : [];
    return { on: conf().on, running: !!running, filed: !!st.done?.[rel], runs };
  };
  // every note's upkeep runs at once, keyed by its path in the vault, for the Notifications view
  const trails = () => {
    const b = brain();
    const t = b ? loadState(b.vault).trail ?? {} : {};
    return Object.fromEntries(Object.entries(t).map(([rel, r]) => [rel, Array.isArray(r) ? r : r ? [r] : []]));
  };
  // the junk notes waiting for a decision, for the Notifications view: the ones still on disk and not kept since
  const junk = () => {
    const b = brain();
    if (!b) return [];
    const kept = keptOf(b.vault);
    return Object.entries(loadState(b.vault).junk ?? {})
      .filter(([rel, j]) => !kept[j.key] && existsSync(path.join(b.vault, rel)))
      .map(([rel, j]) => ({ rel, abs: path.join(b.vault, rel), title: j.title, reason: j.reason, at: j.at }));
  };
  // the person kept a note: it is never flagged again, and the next run files it
  const keepJunk = (rel, key = null) => {
    const b = brain();
    if (!b) return false;
    const text = read(path.join(b.vault, rel));
    const k = key ?? (text != null ? junkNote(rel, text)?.key : null) ?? loadState(b.vault).junk?.[rel]?.key ?? rel;
    const kept = keptOf(b.vault);
    kept[k] = new Date().toISOString();
    mkdirSync(home(b.vault), { recursive: true });
    writeAtomic(path.join(home(b.vault), KEPT_FILE), JSON.stringify(kept, null, 2) + '\n');
    schedule('kept');
    return true;
  };
  // the person moved a junk note to the Trash: the changelog says so, the way it names every file upkeep touches
  const trashedJunk = (rel, title) => {
    const b = brain();
    if (!b) return;
    appendChangelog(b.vault, 'Moved to the Trash', `- ${rel}\n\n“${title}” looked empty, and you chose to remove it. It is in the macOS Trash.\n\n`);
  };
  // the Quorum folder and the facts file of the connected vault, vault-relative, for main (the repair plan note) and the
  // keeper lines rule
  const folder = () => { const b = brain(); return b ? quorumFolder(b.vault, conf().folder) : null; };
  const factsFile = () => { const b = brain(); return b ? factsFor(b.vault) : null; };
  return { run, schedule, halt, status, set, setPlugin, conf, folder, factsFile, clearErrors, errorLog, noteTrail, trails, junk, keepJunk, trashedJunk };
}
