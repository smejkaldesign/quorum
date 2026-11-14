// What Record writes into an open note. A transcript turn and a screen read are appended at the end of the note, each as
// its own paragraph: your microphone as **You:**, the Mac's sound as **Others:**. A turn that grows or is cleaned up (the
// main process sends it again with the same id and replace: true) rewrites the paragraph it wrote while that paragraph
// is still the end of the note; once something follows it, the words it gained are added as a new paragraph. Words are
// never dropped: a rewrite that does not extend the earlier text adds the words after the last ones it shares with it.

export type RecordChoice = { audio: boolean; screen: boolean };
// every turn written so far: its whole text, and the part of it that sits in the note's last paragraph it wrote
export type Written = { last: number | null; turns: Record<number, { full: string; tail: string }> };
export const emptyWritten = (): Written => ({ last: null, turns: {} });
export type Turn = { id: number; channel: 'me' | 'them'; text: string; replace?: boolean };
export type ScreenRead = { app?: string; title?: string; text: string; at: number };

// Screen is offered only when the screen-context flag and the Preferences setting are both on; otherwise Record means
// transcription alone
export const recordChoices = (screenOffered: boolean, pick: Partial<RecordChoice> = {}): RecordChoice => ({
  audio: pick.audio ?? true,
  screen: screenOffered ? pick.screen ?? false : false,
});
export const canStart = (c: RecordChoice) => c.audio || c.screen;

const lineFor = (t: Turn) => `${t.channel === 'them' ? '**Others:**' : '**You:**'} ${t.text.trim()}`;
const joinEnd = (body: string, para: string) => (body.trim() ? `${body.replace(/\s+$/, '')}\n\n${para}` : para);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// the words of next that come after the last word it shares with prev, in order (a longest common subsequence over
// words, ignoring case and punctuation). A plain extension is the text past prev
export function newWords(prev: string, next: string): string {
  if (next.startsWith(prev)) return next.slice(prev.length).trim();
  const a = prev.split(/\s+/).filter(Boolean).map(norm);
  const words = next.split(/\s+/).filter(Boolean);
  const b = words.map(norm);
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, lastShared = -1;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) { lastShared = j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return words.slice(lastShared + 1).join(' ');
}

export function appendTurn(body: string, w: Written, turn: Turn): { body: string; written: Written } {
  if (!turn.text.trim()) return { body, written: w };
  const line = lineFor(turn);
  const prev = w.turns[turn.id];
  const put = (full: string, tail: string, next: string) => ({ body: next, written: { last: turn.id, turns: { ...w.turns, [turn.id]: { full, tail } } } });
  if (!prev) return put(line, line, joinEnd(body, line));
  if (line === prev.full) return { body, written: w };
  const trimmed = body.replace(/\s+$/, '');
  const atEnd = w.last === turn.id && trimmed.endsWith(prev.tail);
  const head = atEnd ? trimmed.slice(0, trimmed.length - prev.tail.length) : '';
  if (atEnd && prev.tail === prev.full) return put(line, line, `${head}${line}`);
  const extra = newWords(prev.full, line);
  if (!extra) return { body, written: { ...w, turns: { ...w.turns, [turn.id]: { ...prev, full: line } } } };
  if (atEnd) {
    const tail = line.startsWith(prev.full) ? `${prev.tail}${line.slice(prev.full.length)}` : `${prev.tail} ${extra}`;
    return put(line, tail, `${head}${tail}`);
  }
  // something came after it (your typing, a screen read, another turn): the gained words get a paragraph of their own
  return put(line, extra, joinEnd(body, extra));
}

const MAX_LINES = 30;
const MAX_CHARS = 1500;

// a screen read as a folded Obsidian callout: when and which window, then the recognized lines, capped
export function screenBlock(r: ScreenRead): string {
  const time = new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const where = [r.app, r.title].filter((s) => s && s.trim()).join(': ');
  const lines: string[] = [];
  let used = 0;
  for (const raw of r.text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (lines.length >= MAX_LINES || used + l.length > MAX_CHARS) { lines.push('…'); break; }
    lines.push(l);
    used += l.length;
  }
  return [`> [!info]- Screen at ${time}${where ? `, ${where}` : ''}`, ...lines.map((l) => `> ${l}`)].join('\n');
}

export const appendScreen = (body: string, r: ScreenRead) => (r.text.trim() ? joinEnd(body, screenBlock(r)) : body);
