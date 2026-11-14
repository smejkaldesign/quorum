// the keeper: what maintains an Agent OS after Quorum writes into it. Each new meeting note gets an index line, a line
// in the daily note, and a line under "## Meetings" in every people note and project note it concerns; a dated entry in
// .quorum/changelog.md records each change. With a model source chosen, a few learned facts per note go into a marked
// list: CLAUDE.md, .quorum/learned.md, or a vault note linked from index.md (Claude Code loads neither of the last two
// on its own). The list stays under a budget in characters, smaller by default in CLAUDE.md: the oldest lines move to
// .quorum/changelog.md when it runs over, and a line marked #keep stays. A fact that only says a note is empty or holds
// no decisions is left out. Everything else is append-only: no note body is rewritten, and a line already present is
// left alone.
// Confidential notes, private folders and secret-looking files never enter the index, the links or the facts.
// Progress is kept in .quorum/keeper.json by note hash, so a note changed later is filed again and an unchanged one
// is skipped; a backlog left by days with the app closed runs in one pass at launch.
// Each job (index, daily, links, facts) is a plugin (plugins.js): the keeper writes only the jobs Quorum owns, never
// touches a file whose first lines say it is generated, names daily notes the way the vault already does, and holds a
// run that would create more than CREATE_LIMIT new files until the user says to go ahead
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { slug } from './starter.js';
import { DAILY_DEFAULT, choose, dailyName, dailyPattern, detect, isGenerated, owns, resolvePlugins, scanContext } from './plugins.js';

export const KEEPER_FILE = path.join('.quorum', 'keeper.json');
export const CHANGELOG = path.join('.quorum', 'changelog.md');
export const LEARNED_OPEN = '<!-- quorum:learned -->';
export const LEARNED_CLOSE = '<!-- /quorum:learned -->';
export const LEARNED_FILE = path.join('.quorum', 'learned.md');
export const LEARNED_BUDGET = 2000;
// CLAUDE.md is loaded in every session, so by default its list holds CLAUDE_FACTS lines or CLAUDE_BUDGET characters,
// whichever is reached first. A budget the user picks applies to every file
export const CLAUDE_BUDGET = 800;
export const CLAUDE_FACTS = 10;
// the vault note target: in the vault's knowledge folder (05-knowledge or knowledge) when it has one, else at the root
export const NOTE_FILE = 'quorum-learned.md';
export const NOTE_LINK = 'learned facts from meetings, kept by Quorum';
export const KEEP_RE = /#keep\b/i;
// a run that would add more new files than this to the vault waits for the user (a backlog of months of meetings
// against a vault with its own daily naming once made 86)
export const CREATE_LIMIT = 10;
// the upkeep error log stays small: past ERR_MAX bytes it keeps its last ERR_KEEP lines
const ERR_MAX = 96 * 1024;
const ERR_KEEP = 200;
const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const today = (d = new Date()) => d.toISOString().slice(0, 10);

// the areas by name, under either naming (02-people or people): the first top-level folder whose name, without a
// numeric prefix, ends in the word
const AREA_RE = { people: /people$/i, projects: /projects?$/i, daily: /daily$/i, meetings: /meetings?$/i };
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
  const t = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!t || t.startsWith('/') || /^[a-z]:/i.test(t)) return null;
  if (t.split('/').some((s) => !s || s.startsWith('.'))) return null;
  const rel = /\.md$/i.test(t) ? t : `${t}.md`;
  return /^(claude|agents|index)\.md$/i.test(rel) ? null : rel;
}
const read =(p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
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
const blockAt = (text) => {
  const a = text.indexOf(LEARNED_OPEN);
  const b = text.indexOf(LEARNED_CLOSE);
  return a >= 0 && b > a ? [a, b + LEARNED_CLOSE.length] : null;
};
export function learnedLines(text) {
  const at = blockAt(text);
  return at ? text.slice(at[0] + LEARNED_OPEN.length, at[1] - LEARNED_CLOSE.length).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')) : [];
}
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

// CLAUDE.md, when the facts live in .quorum/learned.md: its block becomes a pointer to that file. null when it already is
export const LEARNED_POINTER = [LEARNED_OPEN, '## Learned from meetings', '', 'Quorum keeps facts from meeting notes in [.quorum/learned.md](.quorum/learned.md). That file is not loaded on its own; read it when a question needs them.', LEARNED_CLOSE].join('\n');
export function pointLearned(text) {
  const next = putBlock(text, LEARNED_POINTER);
  return next === text ? null : next;
}
const isPointer = (text) => text != null && text.includes(LEARNED_POINTER);
// the top of .quorum/learned.md; true whether or not CLAUDE.md could take a pointer
export const LEARNED_HEADER = '# Learned from meetings\n\nFacts Quorum keeps from meeting notes. Claude Code does not load this file on its own.\n';

export const FACTS_SYSTEM = 'You keep a short list of durable facts about a person\'s work. Answer with plain lines starting with "- " and nothing else.';
export const factsPrompt = ({ title, date, participants, body }) => [
  `From this meeting note, list up to 3 facts worth remembering for months: people and their roles, project decisions, commitments with dates. One line each, under 20 words, no filler, no speculation. Write "- none" when nothing qualifies.`,
  `Meeting: ${title} (${date}). Participants: ${participants.join(', ') || 'unknown'}.`,
  '', body.slice(0, 6000),
].join('\n');
// a fact worth a line: false for one that only says the note is empty or holds no decisions, commitments, action items
// or summary, and for one too short to say anything (under 3 words, or under 4 characters in a script written without
// spaces, such as Chinese or Japanese)
const NOTE_SUBJECT = String.raw`(?:the |this )?(?:meeting |call )?(?:note|notes|meeting|transcript|summary|record|recording|call|discussion)\b`;
const EMPTY_FACT_RES = [
  new RegExp(`^${NOTE_SUBJECT}.*\\b(?:records?|contains?|has|have|had|includes?|lists?|shows?|mentions?|captures?|provides?|gives?|documents?)\\s+(?:no|nothing|none)\\b`, 'i'),
  new RegExp(`^${NOTE_SUBJECT}.*\\b(?:is|was|are|were|appears?|seems?)\\s+(?:to be\\s+)?(?:empty|blank|missing|unavailable)\\b`, 'i'),
  /^(?:there (?:is|are|was|were) )?no (?:clear |specific |notable |recorded |explicit )?(?:decisions?|commitments?|action items?|actions?|summary|content|details?|facts?|takeaways?|next steps|outcomes?|information)\b/i,
  /^(?:an? )?(?:empty|blank) (?:note|meeting|transcript|summary)\b/i,
  /^(?:none|n\/a|not applicable)\b/i,
  /^nothing (?:to (?:note|record|remember|report)|qualifies|of note|notable|worth)\b/i,
];
const NO_SPACE_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;
export function informative(fact) {
  const t = String(fact ?? '').replace(CITE_RE, '').replace(KEEP_RE, '').replace(/^[-*]\s*/, '').trim();
  if (EMPTY_FACT_RES.some((re) => re.test(t))) return false;
  const words = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return words >= 3 || (t.match(NO_SPACE_SCRIPT_RE)?.length ?? 0) >= 4;
}
// the model's lines, with facts that carry nothing left out before the list is deduplicated
export const parseFacts = (out) => String(out ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l && informative(l)).slice(0, 3);

export function createKeeper({ brain, settings, saveSettings = () => {}, guards = () => null, wouldBlock = () => null, runText = null, hasModel = () => false, owner = () => '', log = () => {}, onChange = () => {}, errorLog = null }) {
  // factsBudget and factsNote are null until the user picks one
  const conf = () => ({ on: settings.keeper?.on ?? settings.brainMade === 'quorum', factsBudget: settings.keeper?.factsBudget ?? null, factsTarget: settings.keeper?.factsTarget ?? null, factsNote: settings.keeper?.factsNote ?? null });
  // whether CLAUDE.md gets the smaller default, settled once in keeper.json: a vault that has a learned list already
  // keeps LEARNED_BUDGET until the user picks Default, so no existing list is pruned by it; a vault with none starts small
  const hasList = (vault, st) => ['CLAUDE.md', LEARNED_FILE, st.factsNoteAt].some((rel) => rel && learnedLines(read(path.join(vault, rel)) ?? '').length > 0);
  const claudeSmall = (vault, st) => st.claudeSmall ?? !hasList(vault, st);
  const defaultBudget = (vault, st, target) => (target === 'claude' && claudeSmall(vault, st) ? { budget: CLAUDE_BUDGET, maxLines: CLAUDE_FACTS } : { budget: LEARNED_BUDGET, maxLines: Infinity });
  // the budget for a target: the user's pick for any file, else the default above
  const budgetFor = (vault, st, target) => {
    const picked = conf().factsBudget;
    return picked != null ? { budget: picked, maxLines: Infinity } : defaultBudget(vault, st, target);
  };
  // the vault note's path: the user's, else the one written last (kept in keeper.json), else the default
  const noteFor = (vault, st) => conf().factsNote ?? st.factsNoteAt ?? defaultNote(vault);
  let running = null;
  let queued = null;
  let lastRows = null;
  let timer = null;
  let lastRun = null;

  const stateFile = (vault) => path.join(vault, KEEPER_FILE);
  const loadState = (vault) => { try { return JSON.parse(readFileSync(stateFile(vault), 'utf8')); } catch { return { done: {} }; } };
  const saveState = (vault, st) => { mkdirSync(path.dirname(stateFile(vault)), { recursive: true }); writeAtomic(stateFile(vault), JSON.stringify(st, null, 2) + '\n'); };

  // the plugin rows for this vault, and the daily naming it uses. The rows are the only record of whether facts are on;
  // the older facts switch, saved as off before plugins existed, reads as the vault owning facts until the user picks
  // on the plugin row, which clears it
  const registry = (b) => {
    const f = folders(b.vault);
    const ctx = scanContext(b.root, b.vault, f);
    let rows = resolvePlugins(detect(ctx), settings.plugins);
    if (settings.keeper?.facts === false && !settings.plugins?.facts) rows = rows.map((r) => (r.id === 'facts' ? { ...r, owner: 'vault', overridden: false, isNew: false } : r));
    lastRows = rows;
    return { f, rows, daily: f.daily ? dailyPattern(ctx.daily).template : DAILY_DEFAULT };
  };

  // an upkeep error goes to the console and to a log file under Application Support, which the settings page counts.
  // Past ERR_MAX bytes the file is cut to its last ERR_KEEP lines, and status reads only that much from its end
  const fail = (where, e) => {
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

  // where learned facts go. The user's pick wins. Otherwise the automatic choice, settled at the first write and kept in
  // keeper.json so it never changes by itself: .quorum/learned.md when it exists already or when the vault has its own
  // memory system (the facts plugin found one), else CLAUDE.md
  const evidenceTarget = (reg) => (reg.rows.find((r) => r.id === 'facts')?.evidence.length ? 'learned' : 'claude');
  const autoTarget = (vault, reg, st) => {
    if (st.factsAuto) return st.factsAuto;
    if (existsSync(path.join(vault, LEARNED_FILE))) return 'learned';
    return evidenceTarget(reg);
  };
  const learnedTarget = (vault, reg, st) => conf().factsTarget ?? autoTarget(vault, reg, st);

  // the vault note is linked from index.md only while Quorum owns the index job and index.md exists and is not marked
  // generated; an index the vault keeps itself is never written to. unlinkNote takes out only the line linkNote wrote
  const indexFor = (vault, reg) => {
    if (!owns(reg.rows, 'index')) return null;
    const abs = path.join(vault, 'index.md');
    const cur = read(abs);
    return cur == null || isGenerated(cur) ? null : { abs, cur };
  };
  const noteLine = (note) => `- [[${path.posix.basename(note, '.md')}]] - ${NOTE_LINK}`;
  const linkNote = (vault, reg, note, changed) => {
    const ix = indexFor(vault, reg);
    const base = path.posix.basename(note, '.md');
    if (!ix || [`[[${base}]]`, `[[${base}|`, `[[${note.replace(/\.md$/i, '')}`].some((l) => ix.cur.includes(l))) return;
    writeAtomic(ix.abs, ix.cur.replace(/\s*$/, '') + '\n' + noteLine(note) + '\n');
    changed.push('index.md');
  };
  const unlinkNote = (vault, reg, note, changed) => {
    const ix = indexFor(vault, reg);
    const line = noteLine(note);
    if (!ix || !ix.cur.split('\n').includes(line)) return;
    writeAtomic(ix.abs, ix.cur.split('\n').filter((l) => l !== line).join('\n'));
    changed.push('index.md');
  };

  // the list into its target, with new facts, under the target's budget. When the target changed, the list moves with
  // it: into .quorum/learned.md with a pointer in CLAUDE.md; into the vault note, with CLAUDE.md's block taken out and
  // a CLAUDE.md without one left as it is; or back into CLAUDE.md, with learned.md removed. A note the list leaves
  // loses its block, and is removed with its index line when nothing else is in it. A source is cleared only once the
  // target holds the list; a file marked generated stops the move, changes nothing and is logged. dropped gets only
  // lines that really left a written list
  const saveFacts = (vault, reg, st, target, facts, changed, dropped) => {
    st.claudeSmall ??= !hasList(vault, st);
    const opts = budgetFor(vault, st, target);
    const claudeAbs = path.join(vault, 'CLAUDE.md');
    const learnedAbs = path.join(vault, LEARNED_FILE);
    const claude = read(claudeAbs);
    const learned = read(learnedAbs);
    const note = target === 'note' ? noteFor(vault, st) : null;
    const oldNote = st.factsNoteAt && st.factsNoteAt !== note ? st.factsNoteAt : null;
    const oldText = oldNote ? read(path.join(vault, oldNote)) : null;
    const fromOld = oldText != null && !isGenerated(oldText) ? learnedLines(oldText) : [];
    const put = (abs, next) => { if (next == null) return; mkdirSync(path.dirname(abs), { recursive: true }); writeAtomic(abs, next); changed.push(path.relative(vault, abs)); };
    const clearOld = () => {
      if (!oldNote) return;
      delete st.factsNoteAt;
      if (oldText == null || isGenerated(oldText) || !blockAt(oldText)) return;
      const abs = path.join(vault, oldNote);
      const rest = dropBlock(oldText);
      if (rest.trim() !== LEARNED_HEADER.trim()) { put(abs, rest); return; }
      rmSync(abs, { force: true });
      changed.push(path.relative(vault, abs));
      unlinkNote(vault, reg, oldNote, changed);
    };
    if (target === 'claude') {
      const back = [...(learned != null ? learnedLines(learned) : []), ...fromOld];
      if (claude != null && isGenerated(claude)) { if (facts.length || back.length) fail('facts', 'CLAUDE.md is marked as generated, so learned facts were not written'); return; }
      const r = addLearned(claude ?? '# Agent OS\n', [...back, ...facts], opts);
      put(claudeAbs, r ? r.text : isPointer(claude) ? dropBlock(claude) : null);
      if (r) dropped.push(...r.dropped);
      if (learned != null) { rmSync(learnedAbs, { force: true }); changed.push(LEARNED_FILE); }
      clearOld();
      return;
    }
    const cGen = claude != null && isGenerated(claude);
    if (target === 'note') {
      const noteAbs = path.join(vault, note);
      const cur = read(noteAbs);
      if (cur != null && isGenerated(cur)) { fail('facts', `${note} is marked as generated, so learned facts were not written`); return; }
      const fromClaude = claude != null && !cGen && !isPointer(claude) ? learnedLines(claude) : [];
      const r = addLearned(cur ?? LEARNED_HEADER, [...fromClaude, ...(learned != null ? learnedLines(learned) : []), ...fromOld, ...facts], opts);
      if (r) { put(noteAbs, r.text); dropped.push(...r.dropped); }
      if (!r && cur == null) return;
      clearOld();
      st.factsNoteAt = note;
      if (learned != null) { rmSync(learnedAbs, { force: true }); changed.push(LEARNED_FILE); }
      if (claude != null && !cGen && blockAt(claude)) put(claudeAbs, dropBlock(claude));
      linkNote(vault, reg, note, changed);
      return;
    }
    if (learned != null && isGenerated(learned)) { fail('facts', '.quorum/learned.md is marked as generated, so learned facts were not written'); return; }
    const moved = claude != null && !cGen ? learnedLines(claude) : [];
    const r = addLearned(learned ?? LEARNED_HEADER, [...moved, ...fromOld, ...facts], opts);
    if (r) { put(learnedAbs, r.text); dropped.push(...r.dropped); }
    if (!r && learned == null) return;
    clearOld();
    if (cGen) { if (r) fail('facts', 'CLAUDE.md is marked as generated, so it has no pointer to .quorum/learned.md'); return; }
    // with no CLAUDE.md yet, a short one is made to hold the pointer
    put(claudeAbs, pointLearned(claude ?? '# Agent OS\n'));
  };
  const placeFacts = (vault, reg, st, facts, changed, dropped) => {
    const target = learnedTarget(vault, reg, st);
    const before = changed.length;
    saveFacts(vault, reg, st, target, facts, changed, dropped);
    if (!conf().factsTarget && !st.factsAuto && changed.length > before) st.factsAuto = target;
  };
  const logChange = (vault, title, changed, dropped) => {
    const files = [...new Set(changed.filter((c) => c !== CHANGELOG))];
    if (!files.length) return;
    const abs = path.join(vault, CHANGELOG);
    mkdirSync(path.dirname(abs), { recursive: true });
    const pruned = dropped.length ? `Moved out of the learned facts to stay under the budget:\n\n${dropped.join('\n')}\n\n` : '';
    const entry = `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${title}\n\n${files.map((c) => `- ${c}`).join('\n')}\n\n${pruned}`;
    writeAtomic(abs, (read(abs) ?? '# Changelog\n\nWhat the keeper changed, newest last. Each entry names the files it touched for one meeting note.\n\n') + entry);
  };
  // the list put in its place and trimmed to the budget, outside of filing a note: each run, and when the budget is
  // lowered or the file picked again
  const tidyFacts = (vault, reg, st) => {
    const changed = [];
    const dropped = [];
    if (!owns(reg.rows, 'facts')) return changed;
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
  async function file(vault, reg, st, rel, text, { facts, marked, noCreate = false }) {
    const { f, rows, daily } = reg;
    const changed = [];
    const { props, base, title, date } = meta(rel, text);
    const people = (Array.isArray(props.participants) ? props.participants : []).map((p) => String(p).replace(/\s*\(recorder\)\s*$/i, '').trim()).filter((p) => p && p.toLowerCase() !== owner().toLowerCase());
    const link = `[[${base}]]`;
    const touch = (abs, next, cur) => {
      if (next == null) return;
      if (cur != null && isGenerated(cur)) {
        const r = path.relative(vault, abs).split(path.sep).join('/');
        if (!marked.includes(r)) marked.push(r);
        return;
      }
      writeAtomic(abs, next);
      changed.push(path.relative(vault, abs));
    };
    // index: one line per note
    if (owns(rows, 'index') && !(noCreate && !existsSync(path.join(vault, 'index.md')))) {
      const indexAbs = path.join(vault, 'index.md');
      const cur = read(indexAbs);
      const index = cur ?? '# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n';
      const indexLine = `- ${link} - meeting ${date}: ${title}`;
      if (!index.includes(`${link} `) && !index.includes(`${link}]`) && !index.includes(`${link}\n`)) touch(indexAbs, index.replace(/\s*$/, '') + '\n' + indexLine + '\n', cur);
    }
    // daily note, named the way the vault already names them
    if (f.daily && owns(rows, 'daily')) {
      const abs = path.join(vault, f.daily, dailyName(daily, date));
      const cur = read(abs);
      if (!(noCreate && cur == null)) touch(abs, appendUnder(cur ?? `# ${date}\n`, '## Meetings', `- ${link} ${title}`), cur);
    }
    // people: a note per participant, matched by slug
    if (f.people && owns(rows, 'links')) {
      for (const p of people) {
        const abs = path.join(vault, f.people, `${slug(p)}.md`);
        const cur = read(abs);
        if (cur != null) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur);
      }
    }
    // projects: a note whose title appears in the meeting text
    if (f.projects && owns(rows, 'links')) {
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
        if (hit) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur);
      }
    }
    // learned facts, with the person's own model source, into the learned list (saveFacts); lines pruned to fit the
    // budget are kept in the changelog entry
    const dropped = [];
    if (facts && owns(rows, 'facts') && runText && hasModel()) {
      try {
        const out = await runText(factsPrompt({ title, date, participants: people, body: text.slice(parseFrontmatter(text).end) }), FACTS_SYSTEM);
        const got = parseFacts(out).map((g) => `${g} (${link}, ${date})`);
        if (got.length) placeFacts(vault, reg, st, got, changed, dropped);
      } catch (e) { fail('facts', e); }
    }
    logChange(vault, title, changed, dropped);
    return changed;
  }

  // the new files one note would add: the index when missing, and its daily note when that does not exist yet
  const createsFor = (vault, reg, n) => {
    const out = [];
    if (owns(reg.rows, 'index') && !existsSync(path.join(vault, 'index.md'))) out.push('index.md');
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
      const result = { filed: 0, skipped: 0, changed: 0, reason, at: new Date().toISOString(), error: null, marked: [], held: null };
      if (!b || !c.on) return { ...result, off: true };
      const vault = b.vault;
      const reg = registry(b);
      if (!reg.f.meetings) return result;
      try {
        const st = loadState(vault);
        st.done ??= {};
        const compiled = guards();
        const pending = [];
        for (const rel of meetingNotes(vault, reg.f.meetings)) {
          const text = read(path.join(vault, rel));
          if (text == null) continue;
          const h = sha(text);
          if (st.done[rel] === h) continue;
          const why = compiled ? wouldBlock(compiled, rel, text.slice(0, 2000)) : null;
          pending.push({ rel, text, h, why });
        }
        st.partial ??= {};
        result.changed += tidyFacts(vault, reg, st).length;
        for (const n of pending) n.creates = n.why ? [] : createsFor(vault, reg, n);
        const creates = [...new Set(pending.flatMap((n) => n.creates))].sort();
        const hold = creates.length > CREATE_LIMIT && !allowCreate;
        result.held = hold ? { count: creates.length, sample: creates.slice(0, 5) } : null;
        if (hold) st.held = result.held; else delete st.held;
        for (const n of pending) {
          if (n.why) { st.done[n.rel] = n.h; result.skipped++; continue; }
          const facts = st.partial[n.rel] !== n.h;
          const waits = hold && n.creates.length > 0;
          const changed = await file(vault, reg, st, n.rel, n.text, { facts, marked: result.marked, noCreate: waits });
          result.changed += changed.length;
          if (waits) { st.partial[n.rel] = n.h; continue; }
          delete st.partial[n.rel];
          st.done[n.rel] = n.h;
          result.filed++;
        }
        st.lastRunAt = result.at;
        st.last = result;
        saveState(vault, st);
      } catch (e) {
        result.error = String(e?.message || e);
        fail('run', e);
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

  const plugins = () => { const b = brain(); return b ? registry(b).rows : []; };
  // the rows from the last scan, for callers on a hot path (each question asks about search); scans once if none yet
  const cachedPlugins = () => lastRows ?? plugins();
  const status = () => {
    const b = brain();
    const c = conf();
    const st = b ? loadState(b.vault) : { done: {} };
    const reg = b ? registry(b) : null;
    return { on: c.on, facts: reg ? owns(reg.rows, 'facts') : false, running: !!running, lastRunAt: st.lastRunAt ?? null, filed: Object.keys(st.done ?? {}).length, last: st.last ?? lastRun, held: st.held ?? null, folders: reg?.f ?? {}, model: hasModel(), plugins: reg?.rows ?? [], learned: reg ? learnedStatus(b.vault, reg, st) : null, errors: errors() };
  };
  // the learned list's size against its budget and its share of the file it lives in; pick is the select's value, auto
  // what Automatic resolves to, and suggest the other file when the vault's memory has changed since that was settled
  const learnedStatus = (vault, reg, st) => {
    const target = learnedTarget(vault, reg, st);
    const auto = autoTarget(vault, reg, st);
    const note = noteFor(vault, st);
    const file = target === 'learned' ? LEARNED_FILE.split(path.sep).join('/') : target === 'note' ? note : 'CLAUDE.md';
    const text = read(path.join(vault, file)) ?? '';
    const suggest = !conf().factsTarget && evidenceTarget(reg) !== auto ? evidenceTarget(reg) : null;
    const { budget, maxLines } = budgetFor(vault, st, target);
    const def = defaultBudget(vault, st, target);
    // a CLAUDE.md list kept at LEARNED_BUDGET from before the smaller default: offered, never applied on its own
    const suggestSmall = target === 'claude' && conf().factsBudget == null && !claudeSmall(vault, st);
    return { target, pick: conf().factsTarget ?? 'auto', auto, suggest, file, note, linked: !!indexFor(vault, reg), budget, maxFacts: Number.isFinite(maxLines) ? maxLines : null, budgetPick: conf().factsBudget ?? 'auto', defaultBudget: def.budget, defaultFacts: Number.isFinite(def.maxLines) ? def.maxLines : null, suggestSmall, chars: learnedChars(learnedLines(text)), fileChars: text.length };
  };
  // one plugin row handed to Quorum or to the vault. A held run planned with the old owners no longer applies, so it
  // is cleared and a new pass is scheduled
  // a report plugin writes nothing in the vault, so its pick is saved and nothing else: no held run is cleared and no
  // pass is scheduled
  const setPlugin = (id, to) => {
    const b = brain();
    const rows = plugins();
    settings.plugins = choose(settings.plugins, rows, id, to);
    if (rows.find((r) => r.id === id)?.report) { saveSettings(); return status(); }
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
    // picking Default is the one way a CLAUDE.md list kept from before the smaller default takes it
    let small = false;
    if (Number.isInteger(patch.factsBudget) && patch.factsBudget >= 500 && patch.factsBudget <= 20000) next.factsBudget = patch.factsBudget;
    else if (patch.factsBudget === 'auto') { delete next.factsBudget; small = true; }
    if (patch.factsTarget === 'claude' || patch.factsTarget === 'learned' || patch.factsTarget === 'note') next.factsTarget = patch.factsTarget;
    else if (patch.factsTarget === 'auto') delete next.factsTarget;
    // a note path outside the meetings folder, which the keeper files as meetings; an empty one goes back to the default
    if (typeof patch.factsNote === 'string') {
      const rel = notePath(patch.factsNote);
      const meetings = b ? folders(b.vault).meetings : null;
      if (!patch.factsNote.trim()) delete next.factsNote;
      else if (rel && !(meetings && rel.split('/')[0] === meetings)) next.factsNote = rel;
    }
    settings.keeper = next;
    saveSettings();
    const after = conf();
    let st = null;
    if (b && small) { st = loadState(b.vault); st.claudeSmall = true; saveState(b.vault, st); }
    // another budget, file or note applies now, unless upkeep is off or a run is about to do it
    const factsChanged = small || ['factsBudget', 'factsTarget', 'factsNote'].some((key) => before[key] !== after[key]);
    if (b && after.on && !running && factsChanged) {
      st ??= loadState(b.vault);
      const changed = tidyFacts(b.vault, registry(b), st);
      saveState(b.vault, st);
      if (changed.length) onChange({ ...(lastRun ?? {}), changed: changed.length, reason: 'settings' });
    }
    if (after.on) schedule('settings');
    return status();
  };
  return { run, schedule, status, set, setPlugin, plugins, cachedPlugins, conf, clearErrors, errorLog };
}
