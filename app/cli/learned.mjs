// the learned facts list, shared by app/keeper.js, the review rule for keeper lines (rules/keeperLines.js) and the
// quorum CLI. The CLI ships outside app.asar next to this file, so this module imports nothing from the app
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const LEARNED_OPEN = '<!-- quorum:learned -->';
export const LEARNED_CLOSE = '<!-- /quorum:learned -->';
// the one folder in the vault that holds the files Quorum keeps there, unless the person picks or already has another
export const QUORUM_FOLDER = 'Quorum';
export const FACTS_NAME = 'learned-facts.md';
// where an earlier version kept the list, inside the vault; the keeper moves it into the Quorum folder
export const LEGACY_LEARNED = '.quorum/learned.md';
// the top of the facts file; Quorum writes only files it made, and this header marks one
export const LEARNED_HEADER = '# Learned from meetings\n\nFacts Quorum keeps from meeting notes. Claude Code does not load this file on its own.\n';
export const KEEP_RE = /#keep\b/i;
export const CITE_RE = /\(\[\[[^\]]+\]\],\s*\d{4}-\d{2}-\d{2}\)/;

// the frontmatter line that marks a file Quorum made, so whether a file is Quorum's can be read from the vault itself
// on any Mac, after a move or after Delete my data. A key of its own: the generated notices (plugins.js, linkRules.js)
// mean a file a tool rewrites, which the keeper leaves alone
export const QUORUM_MARK = 'quorum: generated';
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export const isMarked = (text) => { const m = String(text ?? '').match(FM_RE); return !!m && /^quorum:\s*["']?generated["']?\s*$/m.test(m[1]); };
// the text with the mark in its frontmatter, which is added when the text has none
export function withMark(text) {
  const t = String(text ?? '');
  if (isMarked(t)) return t;
  return FM_RE.test(t) ? `---\n${QUORUM_MARK}\n${t.replace(/^---\r?\n/, '')}` : `---\n${QUORUM_MARK}\n---\n${t}`;
}
// the text after its frontmatter
export const bodyText = (text) => String(text ?? '').replace(FM_RE, '');
// a facts file Quorum made: its body starts with the header, marked or not (an earlier version wrote no mark)
export const isFactsFile = (text) => text != null && bodyText(text).startsWith(LEARNED_HEADER);

// the keeper's state for one vault (keeper.json, changelog.md, kept-notes.json) lives in Quorum's data folder, outside
// the vault, so it never shows as a changed file in the vault's git. Keyed by the vault folder's identity on this Mac
// (its inode), so a renamed or moved folder keeps its state; by its path when the folder cannot be read, or when another
// folder still holds the inode an earlier home recorded (a vault on another volume)
const keyOf = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
export const VAULT_FILE = 'vault.json';
export function keeperHome(dataDir, vault) {
  const abs = path.resolve(vault);
  const byPath = path.join(dataDir, 'keeper', keyOf(abs));
  let ino;
  try { ino = statSync(abs).ino; } catch { return byPath; }
  const byId = path.join(dataDir, 'keeper', keyOf(`ino:${ino}`));
  if (existsSync(byId)) {
    let was = null;
    try { was = JSON.parse(readFileSync(path.join(byId, VAULT_FILE), 'utf8')).path; } catch {}
    let other = false;
    try { other = !!was && was !== abs && statSync(was).ino === ino; } catch {}
    return other ? byPath : byId;
  }
  return existsSync(byPath) ? byPath : byId;
}

// the file that holds the list, vault-relative: where the keeper last wrote it (factsNoteAt in keeper.json), else the
// default facts file in the Quorum folder
export const learnedFileIn = (state) => (typeof state?.factsNoteAt === 'string' && state.factsNoteAt) || `${QUORUM_FOLDER}/${FACTS_NAME}`;

// the marked block: the markers on lines of their own, outside fenced code. A note that quotes the markers in a code
// block, a quote or a sentence has no block
export function blockAt(text) {
  let fence = false;
  let start = null;
  let pos = 0;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) fence = !fence;
    else if (!fence && start == null && t === LEARNED_OPEN) start = pos + line.indexOf(LEARNED_OPEN);
    else if (!fence && start != null && t === LEARNED_CLOSE) return [start, pos + line.indexOf(LEARNED_CLOSE) + LEARNED_CLOSE.length];
    pos += line.length + 1;
  }
  return null;
}
export function learnedLines(text) {
  const at = blockAt(text);
  return at ? text.slice(at[0] + LEARNED_OPEN.length, at[1] - LEARNED_CLOSE.length).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')) : [];
}
// two lines that differ only in case, punctuation, width or the note they cite count as the same fact; letters and
// digits of any script are kept, so facts in Cyrillic or Chinese stay distinct
export const factKey = (l) => l.normalize('NFKC').replace(/^-\s*/, '').replace(KEEP_RE, '').replace(CITE_RE, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// the text with its learned block taken out and the rest kept as it was
export const dropBlock = (text) => { const at = blockAt(text); return at ? (text.slice(0, at[0]).replace(/\s*$/, '\n') + text.slice(at[1]).replace(/^\s*/, '\n')).replace(/\n+$/, '\n') : text; };
// the lines the keeper writes in a block besides facts: its heading and the sentence under it, in each version
const KEEPER_TEXT = [/^## Learned from meetings$/, /^Facts Quorum picked up from meeting notes/, /^The newest facts from /, /^Quorum keeps facts from meeting notes in /];
const isFact = (t) => t.startsWith('- ') && !!factKey(t);
// a block the keeper wrote: it has the keeper's heading. A block a person or another tool wrote by hand has not
export const keeperBlock = (text) => { const at = blockAt(text); return !!at && text.slice(at[0], at[1]).split('\n').some((l) => l.trim() === '## Learned from meetings'); };
// the learned lines of a file the person made, moved into the facts file: the facts the facts file does not hold yet go
// at the end of its list (newest last). The file loses only the keeper's lines: the markers, the heading, the sentence
// under it and the facts. Any other line in the block (kept) stays where the block was. to is null when the facts file
// needs no change; toText null is a facts file that does not exist yet. Pure; the keeper trims the list to its budget
// on its next run
export function moveFacts(fromText, toText) {
  const at = blockAt(fromText);
  if (!at) return { to: null, from: fromText, moved: 0, kept: [] };
  const inner = fromText.slice(at[0] + LEARNED_OPEN.length, at[1] - LEARNED_CLOSE.length).split('\n').map((l) => l.trim());
  const kept = inner.filter((t) => t && !isFact(t) && !KEEPER_TEXT.some((re) => re.test(t)));
  const have = new Set(learnedLines(toText ?? '').map(factKey));
  const add = inner.filter((t) => { if (!isFact(t)) return false; const k = factKey(t); if (have.has(k)) return false; have.add(k); return true; });
  const from = kept.length ? `${fromText.slice(0, at[0])}${kept.join('\n')}${fromText.slice(at[1])}` : dropBlock(fromText);
  if (!add.length) return { to: null, from, moved: 0, kept };
  const to = toText != null && blockAt(toText)
    ? (() => { const end = blockAt(toText)[1] - LEARNED_CLOSE.length; return `${toText.slice(0, end).replace(/\s*$/, '\n')}${add.join('\n')}\n${toText.slice(end)}`; })()
    : `${(toText ?? LEARNED_HEADER).replace(/\s*$/, '')}\n\n${[LEARNED_OPEN, '## Learned from meetings', '', ...add, LEARNED_CLOSE].join('\n')}\n`;
  return { to: withMark(to), from, moved: add.length, kept };
}
