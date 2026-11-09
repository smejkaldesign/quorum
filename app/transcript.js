// Speaker turns from Apple's result fragments. Apple finishes text in phrases, so a final can begin with its own
// comma or a lowercase continuation; same-channel finals inside the gap join into one turn. Turns sit in audio order
// (start seconds within the segment), not arrival order, so an answer never lands before its question.
// Each turn keeps what Apple heard as raw and the cleaned reading as text (clean.js); transcript.json holds both.
// Pure: no Electron, no timers. main.js owns the state and the settings.
import { cleanTurn } from './clean.js';

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

// Apple re-emits a final that starts with the tail of the one before it; five or more shared words at the seam are
// the same speech twice, so b loses them. Fewer than five can be a real repeat.
export function dropSeam(a, b) {
  const wa = words(a), wb = words(b);
  for (let k = Math.min(wa.length, wb.length); k >= 5; k--) {
    if (wa.slice(-k).join(' ') !== wb.slice(0, k).join(' ')) continue;
    let m, n = 0;
    const re = /[a-z0-9']+/gi;
    while (n < k && (m = re.exec(b))) n++;
    return b.slice(re.lastIndex).replace(/^[\s,;:]+/, '');
  }
  return b;
}

export function joinText(a, b) {
  const t = a ? dropSeam(a, b.trim()) : b.trim();
  if (!a) return t;
  if (!t) return a;
  return /^[,.;:!?]/.test(t) ? `${a}${t}` : `${a} ${t}`;
}

// piece: {channel, text, start, end, at}. Returns the new turn list, the turn that changed, and whether it grew
// (replace: true) or is new. A late piece that belongs just before a same-channel turn joins the front of it.
// clean: false keeps every word as spoken (the casing rule still applies).
export function addFinal(turns, piece, gap = 1.5, { clean = true } = {}) {
  const text = piece.text.trim();
  if (!text) return { turns, changed: null, replace: false };
  const texts = (raw) => ({ raw, text: cleanTurn(raw, { verbatim: !clean }) });
  let i = turns.length;
  while (i > 0 && turns[i - 1].start > piece.start) i--;
  const prev = turns[i - 1], next = turns[i];
  if (prev && prev.channel === piece.channel && piece.start - prev.end < gap) {
    const changed = { ...prev, ...texts(joinText(prev.raw ?? prev.text, text)), end: Math.max(prev.end, piece.end) };
    return { turns: [...turns.slice(0, i - 1), changed, ...turns.slice(i)], changed, replace: true };
  }
  if (next && next.channel === piece.channel && next.start - piece.end < gap) {
    const changed = { ...next, ...texts(joinText(text, next.raw ?? next.text)), start: piece.start, at: Math.min(next.at, piece.at) };
    return { turns: [...turns.slice(0, i), changed, ...turns.slice(i + 1)], changed, replace: true };
  }
  const id = turns.reduce((m, t) => Math.max(m, t.id ?? 0), 0) + 1;
  const changed = { id, channel: piece.channel, ...texts(text), start: piece.start, end: piece.end, at: piece.at };
  return { turns: [...turns.slice(0, i), changed, ...turns.slice(i)], changed, replace: false };
}

// on speakers the mic hears the far side; a "me" piece that repeats a "them" turn still sounding is echo.
// Short replies always survive: "yes, exactly" reuses their words and is real. partial is the them text not yet final.
export function isEcho(turns, piece, partial = '') {
  const mine = words(piece.text);
  if (mine.length < 4) return false;
  const theirs = new Set(words(partial));
  for (const t of turns) if (t.channel === 'them' && t.end >= piece.start - 2 && t.start <= piece.end) words(t.text).forEach((w) => theirs.add(w));
  return mine.filter((w) => theirs.has(w)).length / mine.length >= 0.9;
}

// one line per turn for a prompt; label is {me, them}
export const toText = (turns, label) => turns.map((t) => `${label[t.channel] ?? t.channel}: ${t.text}`).join('\n');

// raw is the verbatim record; text is what the notes and the transcript view show
export const toJSON = (turns) => turns.map(({ channel, text, raw, start, end, at }) => ({ channel, text, raw: raw ?? text, start, end, at }));
