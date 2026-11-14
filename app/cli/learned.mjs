// the learned facts list, shared by app/keeper.js and the quorum CLI. The CLI ships outside app.asar next to this
// file, so this module imports nothing from the app
import path from 'node:path';

export const LEARNED_OPEN = '<!-- quorum:learned -->';
export const LEARNED_CLOSE = '<!-- /quorum:learned -->';
export const LEARNED_FILE = path.join('.quorum', 'learned.md');

// the file that holds the list, vault-relative: the vault note the keeper last wrote it to (factsNoteAt in
// .quorum/keeper.json), else .quorum/learned.md
export const learnedFileIn = (state) => (typeof state?.factsNoteAt === 'string' && state.factsNoteAt) || LEARNED_FILE;

export function blockAt(text) {
  const a = text.indexOf(LEARNED_OPEN);
  const b = text.indexOf(LEARNED_CLOSE);
  return a >= 0 && b > a ? [a, b + LEARNED_CLOSE.length] : null;
}
export function learnedLines(text) {
  const at = blockAt(text);
  return at ? text.slice(at[0] + LEARNED_OPEN.length, at[1] - LEARNED_CLOSE.length).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')) : [];
}
