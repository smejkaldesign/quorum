// What Record writes into an open note: each transcript turn is appended at the end of the note as its own paragraph,
// labeled by who said it (src/attribution.ts: **You:** for the microphone, a name from the call app, or **Speaker 1:**). A turn that grows or is cleaned up (the
// main process sends it again with the same id and replace: true) rewrites the paragraph it wrote while that paragraph
// is still the end of the note; once something follows it, the words it gained are added as a new paragraph. Words are
// never dropped: a rewrite that does not extend the earlier text adds the words after the last ones it shares with it.

export type RecordChoice = { audio: boolean; screen: boolean };
// every turn written so far: its whole text, and the part of it that sits in the note's last paragraph it wrote
export type Written = { last: number | null; turns: Record<number, { full: string; tail: string }> };
export const emptyWritten = (): Written => ({ last: null, turns: {} });
// label: who said it; without one the microphone is You and the Mac's sound is Speaker 1
export type Turn = { id: number; channel: 'me' | 'them'; text: string; replace?: boolean; label?: string };

// Screen is offered only when the screen-context flag and the Preferences setting are both on; otherwise Record means
// transcription alone
export const recordChoices = (screenOffered: boolean, pick: Partial<RecordChoice> = {}): RecordChoice => ({
  audio: pick.audio ?? true,
  screen: screenOffered ? pick.screen ?? false : false,
});
export const canStart = (c: RecordChoice) => c.audio || c.screen;

const lineFor = (t: Turn) => `**${t.label ?? (t.channel === 'me' ? 'You' : 'Speaker 1')}:** ${t.text.trim()}`;
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

// one turn against what was written for it before: insert a new paragraph at the end, replace the paragraph it wrote
// (in place, only while it is untouched and still last), or nothing. The text is raw markdown, kept apart from what a
// serializer would write, so a turn that grows is matched by what Record wrote rather than by the note's current text
export type Plan = { op: 'insert' | 'replace' | 'none'; text: string; full: string; tail: string };
export function planTurn(prev: { full: string; tail: string } | undefined, line: string, atEnd: boolean): Plan {
  if (!prev) return { op: 'insert', text: line, full: line, tail: line };
  if (line === prev.full) return { op: 'none', text: '', full: prev.full, tail: prev.tail };
  if (atEnd && prev.tail === prev.full) return { op: 'replace', text: line, full: line, tail: line };
  const extra = newWords(prev.full, line);
  if (!extra) return { op: 'none', text: '', full: line, tail: prev.tail };
  if (atEnd) {
    const tail = line.startsWith(prev.full) ? `${prev.tail}${line.slice(prev.full.length)}` : `${prev.tail} ${extra}`;
    return { op: 'replace', text: tail, full: line, tail };
  }
  // something came after it (your typing, a screen read, another turn): the gained words get a paragraph of their own
  return { op: 'insert', text: extra, full: line, tail: extra };
}

export const turnLine = (turn: Turn) => (turn.text.trim() ? lineFor(turn) : '');

export function appendTurn(body: string, w: Written, turn: Turn): { body: string; written: Written } {
  const line = turnLine(turn);
  if (!line) return { body, written: w };
  const prev = w.turns[turn.id];
  const trimmed = body.replace(/\s+$/, '');
  const atEnd = !!prev && w.last === turn.id && trimmed.endsWith(prev.tail);
  const plan = planTurn(prev, line, atEnd);
  const turns = { ...w.turns, [turn.id]: { full: plan.full, tail: plan.tail } };
  if (plan.op === 'none') return { body, written: { ...w, turns } };
  const next = plan.op === 'replace' ? `${trimmed.slice(0, trimmed.length - prev!.tail.length)}${plan.text}` : joinEnd(body, plan.text);
  return { body: next, written: { last: turn.id, turns } };
}
