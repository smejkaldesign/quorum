// What Record writes into an open note. A transcript turn and a screen read are appended at the end of the note, each as
// its own paragraph. A turn that grows (the main process sends it again with the same id and replace: true) rewrites the
// paragraph it wrote last while that paragraph is still the end of the note; once something follows it, only the
// words it gained are added, as a new paragraph.

export type RecordChoice = { audio: boolean; screen: boolean };
// the turn written last: its whole text, and the part of it that sits at the end of the note
export type Written = { id: number; full: string; tail: string } | null;
export type Turn = { id: number; channel: 'me' | 'them'; text: string; replace?: boolean };
export type ScreenRead = { app?: string; title?: string; text: string; at: number };

// Screen is offered only when the screen-context flag and the Preferences setting are both on; otherwise Record means
// transcription alone
export const recordChoices = (screenOffered: boolean, pick: Partial<RecordChoice> = {}): RecordChoice => ({
  audio: pick.audio ?? true,
  screen: screenOffered ? pick.screen ?? false : false,
});
export const canStart = (c: RecordChoice) => c.audio || c.screen;

const lineFor = (t: Turn) => (t.channel === 'them' ? `**Others:** ${t.text.trim()}` : t.text.trim());
const joinEnd = (body: string, para: string) => (body.trim() ? `${body.replace(/\s+$/, '')}\n\n${para}` : para);

export function appendTurn(body: string, last: Written, turn: Turn): { body: string; last: Written } {
  const line = lineFor(turn);
  if (!turn.text.trim()) return { body, last };
  if (!turn.replace || !last || last.id !== turn.id) return turn.replace ? { body, last } : { body: joinEnd(body, line), last: { id: turn.id, full: line, tail: line } };
  const trimmed = body.replace(/\s+$/, '');
  const gain = line.startsWith(last.full) ? line.slice(last.full.length) : null;
  if (trimmed.endsWith(last.tail)) {
    const tail = last.tail === last.full ? line : gain !== null ? `${last.tail}${gain}` : null;
    if (tail === null) return { body, last: { ...last, full: line } };
    return { body: `${trimmed.slice(0, trimmed.length - last.tail.length)}${tail}`, last: { id: turn.id, full: line, tail } };
  }
  // something came after it (your typing, a screen read): the words the turn gained go in a paragraph of their own
  const extra = gain?.trim() ?? '';
  return extra ? { body: joinEnd(body, extra), last: { id: turn.id, full: line, tail: extra } } : { body, last: { ...last, full: line } };
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
