// the learned facts list, shared by app/keeper.js, the review rule for keeper lines (rules/keeperLines.js) and the
// quorum CLI. The CLI ships outside app.asar next to this file, so this module imports nothing from the app
import { createHash } from 'node:crypto';
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

// the keeper's state for one vault (keeper.json, changelog.md, kept-notes.json) lives in Quorum's data folder, outside
// the vault, so it never shows as a changed file in the vault's git. Keyed the way memoryVersions.js keys a vault
export const keeperHome = (dataDir, vault) => path.join(dataDir, 'keeper', createHash('sha1').update(path.resolve(vault)).digest('hex').slice(0, 16));

// the file that holds the list, vault-relative: where the keeper last wrote it (factsNoteAt in keeper.json), else the
// default facts file in the Quorum folder
export const learnedFileIn = (state) => (typeof state?.factsNoteAt === 'string' && state.factsNoteAt) || `${QUORUM_FOLDER}/${FACTS_NAME}`;

export function blockAt(text) {
  const a = text.indexOf(LEARNED_OPEN);
  const b = text.indexOf(LEARNED_CLOSE);
  return a >= 0 && b > a ? [a, b + LEARNED_CLOSE.length] : null;
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
// the learned lines of a file the person made, moved into the facts file: the lines the facts file does not hold yet go
// at the end of its list (newest last), the file loses only its block. to is null when the facts file needs no change;
// toText null is a facts file that does not exist yet. Pure; the keeper trims the list to its budget on its next run
export function moveFacts(fromText, toText) {
  const have = new Set(learnedLines(toText ?? '').map(factKey));
  const add = learnedLines(fromText).filter((l) => { const k = factKey(l); if (!k || have.has(k)) return false; have.add(k); return true; });
  const from = dropBlock(fromText);
  if (!add.length) return { to: null, from, moved: 0 };
  const at = toText == null ? null : blockAt(toText);
  const to = at
    ? `${toText.slice(0, at[1] - LEARNED_CLOSE.length).replace(/\s*$/, '\n')}${add.join('\n')}\n${toText.slice(at[1] - LEARNED_CLOSE.length)}`
    : `${(toText ?? LEARNED_HEADER).replace(/\s*$/, '')}\n\n${[LEARNED_OPEN, '## Learned from meetings', '', ...add, LEARNED_CLOSE].join('\n')}\n`;
  return { to, from, moved: add.length };
}
