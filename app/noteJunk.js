// Junk-note detection: a note with no recording and no transcript whose text has almost no real words, such as a test
// note titled "kjhkjhkjh". Rules only, no model call, so the save dialog and upkeep can both run it on every note.
//
// The rules lean toward keeping a note: a short real note ("call Ana re pricing", a URL, a list of names) must pass,
// so a word counts as junk only when it shows a clear sign of random typing, and words the rules can not judge
// (other scripts, numbers, acronyms) count as real.

const VOWELS = 'aeiouy';
// each keyboard row, so a run of neighbouring keys ("asdf", "lkjh") reads as a mash. The top row needs five keys in
// a row because four occur in real words ("property" holds "erty", "strewn" holds "trew")
const ROWS = [['qwertyuiop', 5], ['asdfghjkl', 4], ['zxcvbnm', 4]];
const SHORT_ROWS = ['asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz'];
// words people type to try the app out; a note made only of these is a placeholder
const PLACEHOLDERS = new Set(['test', 'tests', 'testing', 'tester', 'asdf', 'qwerty', 'hello', 'hi', 'hey', 'foo', 'bar', 'baz', 'blah', 'lorem', 'ipsum', 'xxx', 'abc', 'untitled', 'new', 'note']);
// letter groups that sound as one consonant, so "sch" in German or "ngth" in English do not count toward a long run
const DIGRAPHS = /sch|ch|sh|th|ph|ck|ng|gh|wh/g;
// a word this long with no space is a run of typing; the longest common German compounds stay under it
const LONG_WORD = 25;
const CONSONANT_RUN = 5;

// the text a person typed: no frontmatter, no markdown syntax, link text kept and link targets kept as URLs
export function plainText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, '$1 $2')
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])(\s+|$)(\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*(```|~~~|---+|\*\*\*+)\s*$/gm, '')
    .replace(/[*_~`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isUrl = (t) => /^(https?:\/\/|www\.)\S+/i.test(t) || /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(t) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(t) || /^[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co)$/i.test(t);
const bare = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const hasVowel = (w) => [...w].some((c) => VOWELS.includes(c));
const longestConsonants = (w) => {
  let n = 0;
  let best = 0;
  for (const c of w.replace(DIGRAPHS, 'c')) { n = VOWELS.includes(c) ? 0 : n + 1; best = Math.max(best, n); }
  return best;
};
const keyRun = (w) => ROWS.some(([row, min]) => [row, [...row].reverse().join('')].some((r) => {
  for (let i = 0; i + min <= r.length; i++) if (w.includes(r.slice(i, i + min))) return true;
  return false;
}));
// the same two to four letters three times or more ("kjhkjhkjh", "fjfjfj"), with at most a few letters after
const repeats = (w) => {
  const m = w.match(/^(.{2,4})\1{2,}/);
  return !!m && w.length - m[0].length < 4;
};

// one word as real, junk, or unsure. Unsure is a short word the rules can not call either way ("pls", "jkl", "w");
// url is a link or an email address, which on its own makes a note real
export function wordOf(token) {
  const t = String(token).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}/]+$/gu, '');
  if (!t) return null;
  if (isUrl(t)) return 'url';
  if (/\p{N}/u.test(t)) return 'real';
  const w = bare(t).replace(/['’-]/g, '');
  if (!w) return null;
  if (/[^a-z]/.test(w)) return /\p{L}/u.test(w) ? 'real' : null;
  const acronym = /^\p{Lu}{2,6}$/u.test(t);
  if (w.length >= 4 && (repeats(w) || /(.)\1{3,}/.test(w) || keyRun(w))) return 'junk';
  // three neighbouring keys of the lower rows on their own ("jkl", "sdf"); the top row is left out, since "tre" and
  // "poi" are words
  if (w.length === 3 && SHORT_ROWS.some((r) => r.includes(w))) return 'junk';
  if (!hasVowel(w)) return acronym ? 'real' : w.length >= 4 ? 'junk' : 'unsure';
  if (longestConsonants(w) >= CONSONANT_RUN || w.length >= LONG_WORD) return 'junk';
  if (w.length === 1) return 'unsure';
  return 'real';
}

const quote = (s) => `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;

// null when the note looks real, else { reason } in one plain line. A note with a recording or a transcript is never
// junk: what was heard is the content even when the typed text is empty.
// The text is junk when it has no real word at all, when it is only placeholder words ("test"), or when it has fewer
// than three real words and at least as many junk words as real ones (an unsure word counts as half a real one)
export function junkOf({ title = '', body = '', hasRecording = false, hasTranscript = false } = {}) {
  if (hasRecording || hasTranscript) return null;
  const text = [plainText(title), plainText(body)].filter(Boolean).join(' ').trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return { reason: 'It has no recording and no text.' };
  let real = 0;
  let junk = 0;
  let words = 0;
  let placeholders = 0;
  for (const tok of text.split(/\s+/)) {
    const kind = wordOf(tok);
    if (!kind) continue;
    if (kind === 'url') return null;
    words++;
    if (PLACEHOLDERS.has(bare(tok).replace(/[^a-z]/g, ''))) { placeholders++; continue; }
    if (kind === 'real') real++;
    else if (kind === 'unsure') real += 0.5;
    else junk++;
  }
  if (!words) return { reason: 'It has no recording and no text.' };
  if (placeholders === words) return { reason: `It has no recording and only says ${quote(text)}.` };
  if (real === 0 || (junk > 0 && junk >= real && real < 3)) return { reason: `It has no recording, and ${quote(text)} does not read as words.` };
  return null;
}
