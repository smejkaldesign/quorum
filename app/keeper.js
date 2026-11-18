// the keeper: what maintains an Agent OS after Quorum writes into it. Each new meeting note gets an index line, a line
// in the daily note, and a line under "## Meetings" in every people note and project note it concerns; a dated entry in
// .quorum/changelog.md records each change. With a model source chosen, a few learned facts per note go into a marked
// list in .quorum/learned.md, or in a vault note linked from index.md. Claude Code loads neither on its own; the Quorum
// MCP server reads them (learned_facts). The list stays under a budget in characters: the oldest lines move to
// .quorum/changelog.md when it runs over, and a line marked #keep stays. A fact that only says a note is empty or holds
// no decisions is left out. CLAUDE.md is written only when the user turns that on: it then holds a copy of the newest
// facts, which each run rewrites. With it off, a block in CLAUDE.md is left as it is until the user removes it from
// Settings. Everything else is append-only: no note body is rewritten, and a line already present is left alone.
// Quorum edits only the files it made unless the user turns on editVault: files under .quorum, files the keeper
// created (recorded in keeper.json as made), the files the starter wrote into a folder Quorum built, and a facts note
// that starts with LEARNED_HEADER. With it off, an index.md, daily, people or project note the person made is left as
// it is, and the meeting index lines go to the meetings folder's own index.md, which Quorum makes.
// Confidential notes, private folders and secret-looking files never enter the index, the links or the facts.
// Progress is kept in .quorum/keeper.json by note hash, so a note changed later is filed again and an unchanged one
// is skipped; a backlog left by days with the app closed runs in one pass at launch.
// Each job (index, daily, links, facts) is a plugin (plugins.js): the keeper writes only the jobs Quorum owns, never
// touches a file whose first lines say it is generated, names daily notes the way the vault already does, and holds a
// run that would create more than CREATE_LIMIT new files until the user says to go ahead.
// A note Quorum made with no recording and almost no real words (noteJunk.js) is not filed: it is listed in
// keeper.json as junk for the Notifications view to ask about, until the person moves it to the Trash or keeps it.
// A kept note is recorded in .quorum/kept-notes.json and never asked about again
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { SETUP_FILE, plan, readSetup, slug } from './starter.js';
import { LEARNED_CLOSE, LEARNED_FILE, LEARNED_OPEN, blockAt, learnedFileIn, learnedLines } from './cli/learned.mjs';
import { junkOf } from './noteJunk.js';
import { DAILY_DEFAULT, choose, dailyName, dailyPattern, isGenerated, owns, resolvePlugins } from './plugins.js';

export const KEEPER_FILE = path.join('.quorum', 'keeper.json');
export const CHANGELOG = path.join('.quorum', 'changelog.md');
// the notes the person kept after upkeep flagged them as junk, by quorum_id (else path). A file of its own, so a
// decision written while a run is going is never lost when the run saves keeper.json
export const KEPT_FILE = path.join('.quorum', 'kept-notes.json');
export { LEARNED_CLOSE, LEARNED_FILE, LEARNED_OPEN, learnedFileIn, learnedLines } from './cli/learned.mjs';
export const LEARNED_BUDGET = 2000;
// CLAUDE.md is loaded in every session, so the copy there, when the user turns it on, holds the newest CLAUDE_FACTS
// lines within CLAUDE_BUDGET characters
export const CLAUDE_BUDGET = 800;
export const CLAUDE_FACTS = 10;
// the vault note target: in the vault's knowledge folder (05-knowledge or knowledge) when it has one, else at the root
export const NOTE_FILE = 'quorum-learned.md';
export const NOTE_LINK = 'learned facts from meetings, kept by Quorum';
export const KEEP_RE = /#keep\b/i;
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
const readKept = (vault) => { try { const v = JSON.parse(readFileSync(path.join(vault, KEPT_FILE), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

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
export function defaultNote(vault) {
  let names = [];
  try { names = readdirSync(vault).filter((n) => !n.startsWith('.')).sort(); } catch {}
  const hit = names.find((n) => /^knowledge$/i.test(n.replace(/^\d+[-_ ]*/, '')) && isDir(path.join(vault, n)));
  return hit ? `${hit}/${NOTE_FILE}` : NOTE_FILE;
}
// a note path the user typed, as a vault-relative .md path; null when it leaves the vault, sits in a dot folder, or
// names a file Quorum or Claude Code already uses (CLAUDE.md, AGENTS.md, index.md)
export function notePath(p) {
  const t = String(p ?? '').normalize('NFC').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!t || t.startsWith('/') || /^[a-z]:/i.test(t)) return null;
  if (t.split('/').some((s) => !s || s.startsWith('.'))) return null;
  const rel = /\.md$/i.test(t) ? t : `${t}.md`;
  return /^(claude|agents|index)\.md$/i.test(rel) ? null : rel;
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

// the learned block: a marked list, newest last, with no repeats. Two lines that differ only in case, punctuation, width
// or the note they cite count as the same fact; letters and digits of any script are kept, so facts in Cyrillic or
// Chinese stay distinct
const CITE_RE = /\(\[\[[^\]]+\]\],\s*\d{4}-\d{2}-\d{2}\)/;
export const factKey = (l) => l.normalize('NFKC').replace(/^-\s*/, '').replace(KEEP_RE, '').replace(CITE_RE, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const factDate = (l) => l.match(CITE_RE)?.[0].match(/\d{4}-\d{2}-\d{2}/)[0] ?? null;
// a line with its citation swapped for a newer one; the wording and a #keep marker stay as they were
const withCite = (line, cite) => (CITE_RE.test(line) ? line.replace(CITE_RE, cite) : line.replace(/\s*(#keep\s*)?$/i, (_m, k) => ` ${cite}${k ? ` ${k.trim()}` : ''}`));
export const learnedChars = (lines) => lines.reduce((n, l) => n + l.length + 1, 0);

// the lines that fit the budget, oldest in the list first: the block is kept newest last, and a fact confirmed again
// moves to the end, so position is the order the lines were written. Cited lines go before lines without a citation
// (most likely written by hand); a #keep line is never dropped, so kept lines alone can run over. maxLines caps the
// number of lines as well, for the CLAUDE.md default
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
  `Facts Quorum picked up from meeting notes, newest last. The list stays under ${budget.toLocaleString('en-US')} characters${Number.isFinite(maxLines) ? ` and ${maxLines} lines` : ''}: when it runs over, the oldest lines move to .quorum/changelog.md. Add #keep to a line to hold it. Edit or delete any line.`,
  '', ...lines, LEARNED_CLOSE].join('\n');
const putBlock = (text, block) => {
  const at = blockAt(text);
  if (at) return text.slice(0, at[0]) + block + text.slice(at[1]);
  return text.replace(/\s*$/, '') + '\n\n' + block + '\n';
};
const dropBlock = (text) => { const at = blockAt(text); return at ? (text.slice(0, at[0]).replace(/\s*$/, '\n') + text.slice(at[1]).replace(/^\s*/, '\n')).replace(/\n+$/, '\n') : text; };

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

// the block an earlier version wrote into CLAUDE.md while the facts lived in .quorum/learned.md
export const LEARNED_POINTER = [LEARNED_OPEN, '## Learned from meetings', '', 'Quorum keeps facts from meeting notes in [.quorum/learned.md](.quorum/learned.md). That file is not loaded on its own; read it when a question needs them.', LEARNED_CLOSE].join('\n');
const isPointer = (text) => text != null && text.includes(LEARNED_POINTER);
// the copy in CLAUDE.md: the newest lines of the list that say something, at most CLAUDE_FACTS lines and CLAUDE_BUDGET
// characters, newest last, with no blank lines. A block holding COPY_NOTE is a copy, so its lines are never read back
// into the list. null when no line qualifies
export const COPY_NOTE = 'Quorum rewrites this block on each run';
const isCopy = (text) => { const at = text == null ? null : blockAt(text); return !!at && text.slice(at[0], at[1]).includes(COPY_NOTE); };
export function claudeCopy(lines, file) {
  const out = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < CLAUDE_FACTS; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('- ') || !informative(l.slice(2))) continue;
    if (chars + l.length + 1 > CLAUDE_BUDGET) break;
    out.unshift(l);
    chars += l.length + 1;
  }
  return out.length ? [LEARNED_OPEN, '## Learned from meetings', `The newest facts from ${file}. ${COPY_NOTE}, so edit the facts in that file.`, ...out, LEARNED_CLOSE].join('\n') : null;
}
// the top of .quorum/learned.md; true whether or not CLAUDE.md could take a pointer
export const LEARNED_HEADER = '# Learned from meetings\n\nFacts Quorum keeps from meeting notes. Claude Code does not load this file on its own.\n';

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

export function createKeeper({ onStep = () => {}, brain, settings, saveSettings = () => {}, guards = () => null, wouldBlock = () => null, runText = null, hasModel = () => false, owner = () => '', log = () => {}, onChange = () => {}, errorLog = null, versions = null, live = null, onGuarded = () => {} }) {
  // factsBudget and factsNote are null until the user picks one
  // meetingsIndex writes the meeting index lines to <meetings folder>/index.md while the vault owns the root index
  // editVault lets the keeper edit files Quorum did not make, and factsInClaude turns on the copy in CLAUDE.md; both are
  // off unless the user picks them
  const conf = () => ({ on: settings.keeper?.on ?? settings.brainMade === 'quorum', editVault: settings.keeper?.editVault === true, factsInClaude: settings.keeper?.factsInClaude === true, factsBudget: settings.keeper?.factsBudget ?? null, factsTarget: settings.keeper?.factsTarget ?? null, factsNote: settings.keeper?.factsNote ?? null, meetingsIndex: settings.keeper?.meetingsIndex === true });
  // the list's budget: the user's pick, else LEARNED_BUDGET
  const budgetFor = () => ({ budget: conf().factsBudget ?? LEARNED_BUDGET, maxLines: Infinity });
  // the vault note's path: the user's, else the default settled in keeper.json at its first write, else the default.
  // factsNoteAt is where the list was written last, so a move knows where to take it from
  const noteFor = (vault, st) => conf().factsNote ?? st.factsNoteDefault ?? defaultNote(vault);
  // settings changes that touch keeper.json (a settled default reset by the user), waiting for the state a run will
  // save; set() applies them at once when no run is going, and a running run applies them before it saves
  let resets = {};
  // refile: editVault was turned on, so the notes that left lines out (st.left) are filed again, without asking for
  // their facts a second time
  let refile = false;
  const applyResets = (st) => {
    for (const [key, v] of Object.entries(resets)) { if (v == null) delete st[key]; else st[key] = v; }
    resets = {};
    if (!refile) return;
    refile = false;
    st.partial ??= {};
    for (const [rel, h] of Object.entries(st.left ?? {})) if (st.done?.[rel] === h) { delete st.done[rel]; st.partial[rel] = h; }
    delete st.left;
  };
  let running = null;
  let queued = null;
  let timer = null;
  let lastRun = null;

  const stateFile = (vault) => path.join(vault, KEEPER_FILE);
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
  // a keeper.json from before factsNoteDefault existed gets it from where the list was last written, so an existing
  // list never moves on its own
  // made is a Set in memory and an array in the file. A keeper.json from before made existed gets it from provenMade
  const loadState = (vault) => {
    let st;
    try { st = JSON.parse(readFileSync(stateFile(vault), 'utf8')); } catch { st = { done: {} }; }
    if (st.factsNoteAt && !('factsNoteDefault' in st)) st.factsNoteDefault = st.factsNoteAt;
    st.made = new Set(Array.isArray(st.made) ? st.made : provenMade(vault));
    return st;
  };
  const saveState = (vault, st) => { mkdirSync(path.dirname(stateFile(vault)), { recursive: true }); writeAtomic(stateFile(vault), JSON.stringify({ ...st, made: [...(st.made ?? [])] }, null, 2) + '\n'); };
  // the files an earlier keeper made, for a keeper.json without made: a file the changelog names whose text is still
  // only what the keeper writes (an index under INDEX_HEADER or MEETINGS_HEADER, a daily note of meeting lines and
  // nothing else). Anything it cannot prove stays the person's. Worked out once per vault until a run saves made
  const proven = new Map();
  const provenMade = (vault) => {
    if (proven.has(vault)) return proven.get(vault);
    const log = read(path.join(vault, CHANGELOG)) ?? '';
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
  // exist yet is made by the keeper and recorded as its own
  const quorumMade = (reg, st, rel, cur) => rel.startsWith('.quorum/') || reg.made.has(rel) || !!st.made?.has(rel) || (cur != null && cur.startsWith(LEARNED_HEADER));
  const mayEdit = (reg, st, rel, cur) => cur == null || conf().editVault || quorumMade(reg, st, rel, cur);
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

  // where learned facts go: the vault note when the user picked one and the keeper may write it, else
  // .quorum/learned.md. A factsTarget of claude saved by an earlier version reads as .quorum/learned.md, and the list it
  // left in CLAUDE.md stays there
  const noteAllowed = (vault, reg, st) => { const note = noteFor(vault, st); return mayEdit(reg, st, note, read(path.join(vault, note))); };
  const learnedTarget = (vault, reg, st) => (conf().factsTarget === 'note' && noteAllowed(vault, reg, st) ? 'note' : 'learned');

  // the vault note is linked from index.md only while Quorum owns the index job and index.md exists and is not marked
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
    writeNote(vault, ix.abs, ix.cur.replace(/\s*$/, '') + '\n' + noteLine(note) + '\n');
    changed.push('index.md');
  };
  const unlinkNote = (vault, reg, st, note, changed) => {
    const ix = indexFor(vault, reg, st);
    const line = noteLine(note);
    if (!ix || !ix.cur.split('\n').includes(line)) return;
    writeNote(vault, ix.abs, ix.cur.split('\n').filter((l) => l !== line).join('\n'));
    changed.push('index.md');
  };

  // the list into its target, with new facts, under the budget. When the target changed, the list moves with it, between
  // .quorum/learned.md and the vault note or from one note path to another. A note the list leaves loses its block, and
  // is removed with its index line when nothing else is in it. A source is cleared only once the target holds the list;
  // a file marked generated stops the move, changes nothing and is logged. dropped gets only lines that really left a
  // written list. With the CLAUDE.md copy off, CLAUDE.md is never read or written here. With it on, a list block in
  // CLAUDE.md (from an earlier version, or written by hand) joins the list once and the block becomes the copy
  // A generated .quorum/learned.md is never read from or removed. With noCreate (a held run) a vault note that does not
  // exist yet is left uncreated; the run counts it in createsFor and asks for the facts again once it may create files
  const saveFacts = (vault, reg, st, target, facts, changed, dropped, { noCreate = false } = {}) => {
    const opts = budgetFor();
    const claudeAbs = path.join(vault, 'CLAUDE.md');
    const learnedAbs = path.join(vault, LEARNED_FILE);
    const claudeNow = conf().factsInClaude ? read(claudeAbs) : null;
    const inClaude = conf().factsInClaude && mayEdit(reg, st, 'CLAUDE.md', claudeNow);
    const claude = inClaude ? claudeNow : null;
    const cGen = claude != null && isGenerated(claude);
    const fromClaude = claude != null && !cGen && !isPointer(claude) && !isCopy(claude) ? learnedLines(claude) : [];
    const learned = read(learnedAbs);
    const lGen = learned != null && isGenerated(learned);
    const fromLearned = learned != null && !lGen ? learnedLines(learned) : [];
    const dropLearned = () => { if (learned != null && !lGen) { removeNote(vault, learnedAbs); changed.push(LEARNED_FILE); } };
    const note = target === 'note' ? noteFor(vault, st) : null;
    const oldNote = st.factsNoteAt && st.factsNoteAt !== note ? st.factsNoteAt : null;
    const oldText = oldNote ? read(path.join(vault, oldNote)) : null;
    const fromOld = oldText != null && !isGenerated(oldText) ? learnedLines(oldText) : [];
    const put = (abs, next) => {
      if (next == null) return;
      const rel = posix(path.relative(vault, abs));
      if (!existsSync(abs)) markMade(st, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeNote(vault, abs, next);
      changed.push(path.relative(vault, abs));
    };
    // a note the person made keeps its block when the list leaves it, unless editVault is on
    const clearOld = () => {
      if (!oldNote) return;
      delete st.factsNoteAt;
      if (oldText == null || isGenerated(oldText) || !blockAt(oldText) || !mayEdit(reg, st, oldNote, oldText)) return;
      const abs = path.join(vault, oldNote);
      const rest = dropBlock(oldText);
      if (rest.trim() !== LEARNED_HEADER.trim()) { put(abs, rest); return; }
      removeNote(vault, abs);
      changed.push(path.relative(vault, abs));
      unlinkNote(vault, reg, st, oldNote, changed);
    };
    // the copy in CLAUDE.md from the list as written; a CLAUDE.md marked generated is logged only when the list changed
    const copy = (rel, text, wrote) => {
      if (!inClaude) return;
      if (cGen) { if (wrote) fail('facts', 'CLAUDE.md is marked as generated, so it has no copy of the learned facts'); return; }
      const block = claudeCopy(learnedLines(text ?? ''), rel);
      const next = block ? putBlock(claude ?? '# Agent OS\n', block) : isCopy(claude) ? dropBlock(claude) : null;
      if (next !== claude) put(claudeAbs, next);
    };
    if (target === 'note') {
      const noteAbs = path.join(vault, note);
      const cur = read(noteAbs);
      if (cur != null && isGenerated(cur)) { fail('facts', `${note} is marked as generated, so learned facts were not written`); return; }
      if (cur == null && noCreate) return;
      const r = addLearned(cur ?? LEARNED_HEADER, [...fromClaude, ...fromLearned, ...fromOld, ...facts], opts);
      if (r) { put(noteAbs, r.text); dropped.push(...r.dropped); }
      if (!r && cur == null) return;
      clearOld();
      st.factsNoteAt = note;
      if (!conf().factsNote) st.factsNoteDefault = note;
      dropLearned();
      copy(note, r ? r.text : cur, !!r);
      linkNote(vault, reg, st, note, changed);
      return;
    }
    if (lGen) { fail('facts', '.quorum/learned.md is marked as generated, so learned facts were not written'); return; }
    const r = addLearned(learned ?? LEARNED_HEADER, [...fromClaude, ...fromOld, ...facts], opts);
    if (r) { put(learnedAbs, r.text); dropped.push(...r.dropped); }
    if (!r && learned == null) return;
    clearOld();
    copy(LEARNED_FILE.split(path.sep).join('/'), r ? r.text : learned, !!r);
  };
  const placeFacts = (vault, reg, st, facts, changed, dropped, opts) => saveFacts(vault, reg, st, learnedTarget(vault, reg, st), facts, changed, dropped, opts);
  // one dated entry at the end of .quorum/changelog.md, which is made with its header when missing
  const appendChangelog = (vault, title, body) => {
    const abs = path.join(vault, CHANGELOG);
    mkdirSync(path.dirname(abs), { recursive: true });
    const entry = `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${title}\n\n${body}`;
    writeAtomic(abs, (read(abs) ?? '# Changelog\n\nWhat the keeper changed, newest last. Each entry names the files it touched for one meeting note.\n\n') + entry);
  };
  const logChange = (vault, title, changed, dropped) => {
    const files = [...new Set(changed.filter((c) => c !== CHANGELOG))];
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
    // a file the person made is left as it is unless editVault is on, and named in left
    const touch = (abs, next, cur) => {
      if (next == null) return;
      const r = posix(path.relative(vault, abs));
      if (cur != null && isGenerated(cur)) {
        if (!marked.includes(r)) marked.push(r);
        return;
      }
      if (!mayEdit(reg, st, r, cur)) { if (!left.includes(r)) left.push(r); return; }
      if (cur == null) markMade(st, r);
      writeNote(vault, abs, next);
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
    // people: a note per participant, matched by slug
    if (f.people && owns(rows, 'links')) {
      if (people.length) step(`Checking notes for ${people.length} ${people.length === 1 ? 'person' : 'people'}`);
      for (const p of people) {
        const abs = path.join(vault, f.people, `${slug(p)}.md`);
        const cur = read(abs);
        if (cur != null) { touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur); inline.push({ name: p, target: slug(p) }); }
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
        if (hit) { touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur); inline.push({ name, target: path.basename(n, '.md') }); }
      }
    }
    // the same links inline in the meeting note: a name it mentions points at the memory it was filed into. Only in a
    // note Quorum wrote or imported, or with Edit vault notes on; any other note is left as the person wrote it
    if (inline.length) {
      const own = /^source:\s*"?quorum(-dev)?"?\s*$/m.test(text) || /^imported_by:\s*"?agent"?\s*$/m.test(text);
      const linked = linkMentions(text, inline);
      if (linked !== text && (own || conf().editVault)) {
        step('Linking the names it mentions to their memories');
        writeNote(vault, path.join(vault, rel), linked);
        changed.push(rel);
      }
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
    writeNote(vault, abs, index);
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
  // whether a note's facts would go into a vault note that does not exist yet
  const factsCreate = (vault, reg, st, n) => {
    if (!owns(reg.rows, 'facts') || !runText || !hasModel() || st.partial?.[n.rel] === n.h) return null;
    if (learnedTarget(vault, reg, st) !== 'note') return null;
    const note = noteFor(vault, st);
    return existsSync(path.join(vault, note)) ? null : note;
  };
  // the new files one note would add: the index when missing, its daily note when that does not exist yet, and the
  // vault note for learned facts when that is the target and does not exist yet
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
      const changelogBefore = read(path.join(vault, CHANGELOG));
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
        // junk notes wait for the person's decision before they are filed into the memory
        const kept = readKept(vault);
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
          // a held note whose facts need a new vault note waits for its facts too, so they are asked for once it may
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
          const abs = path.join(vault, CHANGELOG);
          if (changelogBefore == null) rmSync(abs, { force: true }); else writeAtomic(abs, changelogBefore);
        } else if (st) {
          applyResets(st);
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
    return { on: c.on, editVault: c.editVault, meetingsIndex: c.meetingsIndex, facts: reg ? owns(reg.rows, 'facts') : false, running: !!running, lastRunAt: st.lastRunAt ?? null, filed: Object.keys(st.done ?? {}).length, last: st.last ?? lastRun, held: st.held ?? null, folders: reg?.f ?? {}, model: hasModel(), plugins: reg?.rows ?? [], learned: reg ? learnedStatus(b.vault, reg, st) : null, errors: errors() };
  };
  // the learned list's size against its budget and its share of the file it lives in, and what CLAUDE.md holds: no
  // block, the copy, a pointer or a list from an earlier version, or a list written by hand
  const learnedStatus = (vault, reg, st) => {
    const target = learnedTarget(vault, reg, st);
    const note = noteFor(vault, st);
    const file = target === 'note' ? note : LEARNED_FILE.split(path.sep).join('/');
    const text = read(path.join(vault, file)) ?? '';
    const lines = learnedLines(text);
    // how many lines picking Default would move to the changelog, for the confirm the settings page shows
    const defaultMoves = pruneLearned(lines, LEARNED_BUDGET).dropped.length;
    // the note is linked while Quorum owns the index job, also before index.md exists; indexGenerated says why not
    const index = read(path.join(vault, 'index.md'));
    const indexGenerated = owns(reg.rows, 'index') && index != null && isGenerated(index);
    const claude = read(path.join(vault, 'CLAUDE.md'));
    const block = claude == null || !blockAt(claude) ? null : isCopy(claude) ? 'copy' : isPointer(claude) ? 'pointer' : 'list';
    // a picked note the person made, which takes the facts only with editVault on
    const noteHeld = conf().factsTarget === 'note' && target !== 'note';
    return {
      target, pick: conf().factsTarget === 'note' ? 'note' : 'learned', file, note, noteHeld, linked: owns(reg.rows, 'index') && !indexGenerated, indexGenerated,
      budget: budgetFor().budget, budgetPick: conf().factsBudget ?? 'auto', defaultBudget: LEARNED_BUDGET, defaultMoves, chars: learnedChars(lines), fileChars: text.length,
      claude: { on: conf().factsInClaude, editable: mayEdit(reg, st, 'CLAUDE.md', claude), block, lines: block === 'list' ? learnedLines(claude).length : 0, generated: claude != null && isGenerated(claude), facts: CLAUDE_FACTS, budget: CLAUDE_BUDGET },
    };
  };
  // the block in CLAUDE.md taken out when the user asks from Settings: only the text between the quorum:learned
  // markers goes. A list in it joins Quorum's own list first, so no fact is lost; when that list cannot take the lines
  // (marked generated), CLAUDE.md stays as it was. The copy is turned off too, so no later run writes it again
  async function removeClaude() {
    if (running) await running.catch(() => {});
    const b = brain();
    if (!b) return status();
    if (conf().factsInClaude) { settings.keeper = { ...settings.keeper, factsInClaude: false }; saveSettings(); }
    const vault = b.vault;
    const abs = path.join(vault, 'CLAUDE.md');
    const cur = read(abs);
    if (cur == null || isGenerated(cur) || !blockAt(cur)) return status();
    const st = loadState(vault);
    const reg = registry(b);
    const changed = [];
    const dropped = [];
    // the person asked for this from Settings, so these writes keep versions without updates to review
    why = { reason: 'Learned facts moved out of CLAUDE.md, from Settings', agent: false };
    // a line with nothing in it, or one that only says a note was empty, does not move: it is named in the changelog
    const all = isPointer(cur) || isCopy(cur) ? [] : learnedLines(cur);
    const lines = all.filter((l) => factKey(l) && informative(l));
    const left = all.filter((l) => !lines.includes(l));
    if (lines.length) {
      let moved = false;
      try {
        placeFacts(vault, reg, st, lines, changed, dropped);
        const have = new Set([...learnedLines(read(path.join(vault, learnedFileIn(st))) ?? ''), ...dropped].map(factKey));
        moved = lines.every((l) => have.has(factKey(l)));
      } catch (e) { fail('facts', e); }
      if (!moved) {
        saveState(vault, st);
        if (changed.length) logChange(vault, 'Learned facts', changed, dropped);
        fail('facts', 'the learned facts in CLAUDE.md could not be moved, so CLAUDE.md was left as it was');
        return status();
      }
    }
    writeNote(vault, abs, dropBlock(cur));
    changed.push('CLAUDE.md');
    logChange(vault, 'Learned facts removed from CLAUDE.md', changed, dropped);
    if (left.length) appendChangelog(vault, 'Lines left out of the learned facts', `Empty or saying nothing, so not moved from CLAUDE.md:\n\n${left.join('\n')}\n\n`);
    saveState(vault, st);
    onChange({ ...(lastRun ?? {}), changed: changed.length, reason: 'settings' });
    return status();
  }
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
    if (typeof patch.factsInClaude === 'boolean') next.factsInClaude = patch.factsInClaude;
    if (typeof patch.editVault === 'boolean') next.editVault = patch.editVault;
    if (patch.editVault === true && !before.editVault) refile = true;
    // reset holds the keeper.json fields a pick settles. A cleared note path settles the default note, so the list moves
    // there
    const reset = {};
    if (Number.isInteger(patch.factsBudget) && patch.factsBudget >= 500 && patch.factsBudget <= 20000) next.factsBudget = patch.factsBudget;
    else if (patch.factsBudget === 'auto') delete next.factsBudget;
    if (patch.factsTarget === 'note') next.factsTarget = 'note';
    else if (patch.factsTarget === 'learned' || patch.factsTarget === 'auto') delete next.factsTarget;
    // a note path outside the meetings folder, which the keeper files as meetings; an empty one goes back to the default
    if (typeof patch.factsNote === 'string') {
      const rel = notePath(patch.factsNote);
      const meetings = b ? folders(b.vault).meetings?.normalize('NFC').toLowerCase() : null;
      if (!patch.factsNote.trim()) { delete next.factsNote; if (b) reset.factsNoteDefault = defaultNote(b.vault); }
      else if (rel && !(meetings && rel.toLowerCase().split('/')[0] === meetings)) next.factsNote = rel;
    }
    settings.keeper = next;
    saveSettings();
    const after = conf();
    // a running run saves its own copy of keeper.json, so the reset waits for it there; otherwise it is saved now
    let st = null;
    if (b && (Object.keys(reset).length || refile)) {
      Object.assign(resets, reset);
      if (!running) { st = loadState(b.vault); applyResets(st); saveState(b.vault, st); }
    }
    // another budget, file, note or CLAUDE.md copy applies now, unless upkeep is off or a run is about to do it
    const factsChanged = Object.keys(reset).length > 0 || ['factsBudget', 'factsTarget', 'factsNote', 'factsInClaude', 'editVault'].some((key) => before[key] !== after[key]);
    if (b && after.on && !running && factsChanged) {
      st ??= loadState(b.vault);
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
    const kept = readKept(b.vault);
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
    const kept = readKept(b.vault);
    kept[k] = new Date().toISOString();
    mkdirSync(path.join(b.vault, '.quorum'), { recursive: true });
    writeAtomic(path.join(b.vault, KEPT_FILE), JSON.stringify(kept, null, 2) + '\n');
    schedule('kept');
    return true;
  };
  // the person moved a junk note to the Trash: the changelog says so, the way it names every file upkeep touches
  const trashedJunk = (rel, title) => {
    const b = brain();
    if (!b) return;
    appendChangelog(b.vault, 'Moved to the Trash', `- ${rel}\n\n“${title}” looked empty, and you chose to remove it. It is in the macOS Trash.\n\n`);
  };
  return { run, schedule, halt, status, set, setPlugin, removeClaude, conf, clearErrors, errorLog, noteTrail, trails, junk, keepJunk, trashedJunk };
}
