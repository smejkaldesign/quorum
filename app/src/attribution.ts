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

export function speakerLabels(turns: TimedTurn[], reads: SpeakerRead[], { self = [], slack = 2000 }: { self?: string[]; slack?: number } = {}): Record<number, string> {
  const others = new Set<string>();
  for (const r of reads) for (const n of r.names) if (n.trim() && !isSelf(n, self)) others.add(clean(n));
  const only = others.size === 1 ? [...others][0] : null;
  const numbers = new Map<string, number>();
  const out: Record<number, string> = {};
  for (const t of [...turns].sort((a, b) => a.startMs - b.startMs)) {
    if (t.channel === 'me') { out[t.id] = 'You'; continue; }
    if (t.speaker && t.speaker.trim()) { out[t.id] = t.speaker.trim(); continue; }
    const votes = new Map<string, number>();
    for (const r of reads) {
      if (r.at < t.startMs - slack || r.at > t.endMs + slack) continue;
      for (const n of r.active) if (n.trim() && !isSelf(n, self)) votes.set(clean(n), (votes.get(clean(n)) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) { out[t.id] = best[0]; continue; }
    if (only) { out[t.id] = only; continue; }
    const key = t.cluster ?? 'channel';
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    out[t.id] = `Speaker ${numbers.get(key)}`;
  }
  return out;
}

// a final turn as the renderer receives it: start and end are seconds into the capture, arrival is when it came in, so
// the turn's time on the wall clock is the arrival minus its length
export const timedTurn = (e: { id?: number; channel: 'me' | 'them'; start: number; end: number; cluster?: string | null; speaker?: string | null }, arrival: number): TimedTurn => {
  const len = Math.max(0, (Number(e.end) - Number(e.start)) * 1000) || 0;
  return { id: e.id ?? 0, channel: e.channel, startMs: arrival - len, endMs: arrival, cluster: e.cluster ?? null, speaker: e.speaker ?? null };
};
