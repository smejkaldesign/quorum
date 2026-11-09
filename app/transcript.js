// Speaker turns from Apple's result fragments. Apple finishes text in phrases, so a final can begin with its own
// comma or a lowercase continuation; same-channel finals inside the gap join into one turn. Turns sit in audio order
// (start seconds within the segment), not arrival order, so an answer never lands before its question.
// Pure: no Electron, no timers. main.js owns the state and the settings.

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);

export function joinText(a, b) {
  const t = b.trim();
  if (!a) return t;
  return /^[,.;:!?]/.test(t) ? `${a}${t}` : `${a} ${t}`;
}

// piece: {channel, text, start, end, at}. Returns the new turn list, the turn that changed, and whether it grew
// (replace: true) or is new. A late piece that belongs just before a same-channel turn joins the front of it.
export function addFinal(turns, piece, gap = 1.5) {
  const text = piece.text.trim();
  if (!text) return { turns, changed: null, replace: false };
  let i = turns.length;
  while (i > 0 && turns[i - 1].start > piece.start) i--;
  const prev = turns[i - 1], next = turns[i];
  if (prev && prev.channel === piece.channel && piece.start - prev.end < gap) {
    const changed = { ...prev, text: joinText(prev.text, text), end: Math.max(prev.end, piece.end) };
    return { turns: [...turns.slice(0, i - 1), changed, ...turns.slice(i)], changed, replace: true };
  }
  if (next && next.channel === piece.channel && next.start - piece.end < gap) {
    const changed = { ...next, text: joinText(text, next.text), start: piece.start, at: Math.min(next.at, piece.at) };
    return { turns: [...turns.slice(0, i), changed, ...turns.slice(i + 1)], changed, replace: true };
  }
  const id = turns.reduce((m, t) => Math.max(m, t.id ?? 0), 0) + 1;
  const changed = { id, channel: piece.channel, text, start: piece.start, end: piece.end, at: piece.at };
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

export const toJSON = (turns) => turns.map(({ channel, text, start, end, at }) => ({ channel, text, start, end, at }));
