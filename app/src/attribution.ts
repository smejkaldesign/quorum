// Who said each transcript paragraph in a Record session. Pure: timed turns and timed reads of the call app in, one
// label per turn out.
//   - the microphone is You
//   - a turn on the Mac's sound takes the name the call app showed as speaking while it was said (the most frequent one
//     inside the turn's time, widened by `slack` on both sides)
//   - with no speaker shown, and exactly one other person ever named, it is that person
//   - otherwise Speaker 1, Speaker 2 and so on, by the diarization cluster when there is one, else one number for the
//     whole channel, numbered in the order they first speak
// Your own tile ("Ada Lovelace (me)", "You", or your name) is never a candidate.

export type TimedTurn = { id: number; channel: 'me' | 'them'; startMs: number; endMs: number; cluster?: string | null; speaker?: string | null };
export type SpeakerRead = { at: number; names: string[]; active: string[] };

const SELF_MARK = /\s*\((me|you|host|co-host|guest)\)\s*$/i;
const clean = (n: string) => n.replace(SELF_MARK, '').trim();
const isSelf = (n: string, self: string[]) => /\((me|you)\)\s*$/i.test(n) || /^you$/i.test(n.trim()) || self.some((s) => s && clean(n).toLowerCase() === s.trim().toLowerCase());

type Opts = { self?: string[]; slack?: number };

// the label for one turn: only the reads inside its time window are looked at. prior is the turns before it, for the
// Speaker N numbering; others is everyone named so far besides you
export function labelFor(t: TimedTurn, prior: TimedTurn[], reads: SpeakerRead[], others: Set<string>, { self = [], slack = 2000 }: Opts = {}): string {
  if (t.channel === 'me') return 'You';
  if (t.speaker && t.speaker.trim()) return t.speaker.trim();
  const votes = new Map<string, number>();
  for (const r of reads) {
    if (r.at < t.startMs - slack || r.at > t.endMs + slack) continue;
    for (const n of r.active) if (n.trim() && !isSelf(n, self)) votes.set(clean(n), (votes.get(clean(n)) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  if (others.size === 1) return [...others][0];
  const order: string[] = [];
  for (const p of prior) if (p.channel === 'them' && !p.speaker) { const k = p.cluster ?? 'channel'; if (!order.includes(k)) order.push(k); }
  const key = t.cluster ?? 'channel';
  return `Speaker ${(order.includes(key) ? order.indexOf(key) : order.length) + 1}`;
}

export const othersIn = (reads: SpeakerRead[], self: string[] = []) => {
  const out = new Set<string>();
  for (const r of reads) for (const n of r.names) if (n.trim() && !isSelf(n, self)) out.add(clean(n));
  return out;
};

// every turn's label at once, in the order the turns were said
export function speakerLabels(turns: TimedTurn[], reads: SpeakerRead[], opts: Opts = {}): Record<number, string> {
  const others = othersIn(reads, opts.self);
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const out: Record<number, string> = {};
  sorted.forEach((t, i) => { out[t.id] = labelFor(t, sorted.slice(0, i), reads, others, opts); });
  return out;
}

// the renderer keeps this many of each, as the main process does
export const MAX_READS = 5000;
export const MAX_TURNS = 5000;

// a final turn as the renderer receives it: start and end are seconds into the capture, arrival is when it came in, so
// the turn's time on the wall clock is the arrival minus its length
export const timedTurn = (e: { id?: number; channel: 'me' | 'them'; start: number; end: number; cluster?: string | null; speaker?: string | null }, arrival: number): TimedTurn => {
  const len = Math.max(0, (Number(e.end) - Number(e.start)) * 1000) || 0;
  return { id: e.id ?? 0, channel: e.channel, startMs: arrival - len, endMs: arrival, cluster: e.cluster ?? null, speaker: e.speaker ?? null };
};
