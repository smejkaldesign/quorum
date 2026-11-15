// Who said each word, for the on-device engine. The helper sends voice spans (LS-EEND, per channel) and Apple's word
// times; a final splits wherever the voice changes. Words where two voices talk at once read as mixed, a piece Apple
// was unsure of is marked unclear, and sound hits (laughter, crosstalk) become their own short lines.
// Pure: main.js owns the state.

export const MIX = 'mix';
export const SOUND = 'sound';

// per channel: finalized spans accumulate, tentative ones are replaced by each update
export function addVoices(state, segments = []) {
  const prev = state ?? { final: [], tentative: [] };
  return { final: [...prev.final, ...segments.filter((s) => s.final)].slice(-4000), tentative: segments.filter((s) => !s.final) };
}
export const spansOf = (state) => (state ? [...state.final, ...state.tentative] : []);

// seconds of [s, e] that a voice's spans cover, counting each instant once
function covered(spans, s, e) {
  const parts = spans.map((p) => [Math.max(s, p.start), Math.min(e, p.end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of parts) { if (b <= end) continue; total += b - Math.max(a, end); end = b; }
  return total;
}

// the voice for one word: the voice covering most of it, MIX when two voices each cover 40% of it, null when none does
export function voiceAt(spans, s, e) {
  if (e - s < 0.1) { const m = (s + e) / 2; s = m - 0.05; e = m + 0.05; }
  const byVoice = new Map();
  for (const p of spans) byVoice.set(p.voice, [...(byVoice.get(p.voice) ?? []), p]);
  const ranked = [...byVoice].map(([v, ps]) => [v, covered(ps, s, e) / (e - s)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[1][1] >= 0.4) return MIX;
  return ranked[0][0];
}

// a piece is unclear when Apple gave most of its words low confidence: far-off, quiet or talked-over speech
const LOW = 0.5;
const unclear = (ws) => { const c = ws.map((w) => w.c).filter((x) => typeof x === 'number'); return c.length > 0 && c.filter((x) => x < LOW).length / c.length >= 0.5; };

// one final from the helper → one piece per run of a voice. Without word times or spans the final passes through whole.
export function splitPiece(piece, spans) {
  const { words, ...base } = piece;
  if (!words?.length) return [base];
  const flag = (ws) => (unclear(ws) ? { unclear: true } : {});
  if (!spans.length) return [{ ...base, ...flag(words) }];
  const v = words.map((w) => voiceAt(spans, w.s, w.e));
  // a word no span covers (a pause, a clipped edge) takes the voice before it, or after it at the start
  for (let i = 1; i < v.length; i++) if (v[i] == null) v[i] = v[i - 1];
  for (let i = v.length - 2; i >= 0; i--) if (v[i] == null) v[i] = v[i + 1];
  if (v[0] == null) return [{ ...base, ...flag(words) }];
  // one word between two runs of the same voice belongs to that voice
  for (let i = 1; i < v.length - 1; i++) if (v[i - 1] === v[i + 1] && v[i] !== v[i - 1]) v[i] = v[i - 1];
  const out = [];
  let from = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i < words.length && v[i] === v[from]) continue;
    const ws = words.slice(from, i);
    const text = ws.map((w) => w.t).join('').trim();
    if (text) out.push({ ...base, text, start: ws[0].s, end: ws[ws.length - 1].e, voice: v[from], ...flag(ws) });
    from = i;
  }
  return out.length ? out : [base];
}

// a sound hit joins the same sound on its channel when it is within gap seconds, or becomes its own line in audio order
export function addSound(turns, hit, gap = 1.5) {
  const i = turns.findIndex((t) => t.voice === SOUND && t.channel === hit.channel && t.text === hit.label && hit.start - t.end <= gap && t.start - hit.end <= gap);
  if (i >= 0) {
    const changed = { ...turns[i], start: Math.min(turns[i].start, hit.start), end: Math.max(turns[i].end, hit.end) };
    return { turns: turns.map((t, k) => (k === i ? changed : t)), changed, replace: true };
  }
  const id = turns.reduce((m, t) => Math.max(m, t.id ?? 0), 0) + 1;
  const changed = { id, channel: hit.channel, voice: SOUND, text: hit.label, raw: hit.label, start: hit.start, end: hit.end, at: hit.at ?? Date.now() };
  let k = turns.length;
  while (k > 0 && turns[k - 1].start > hit.start) k--;
  return { turns: [...turns.slice(0, k), changed, ...turns.slice(k)], changed, replace: false };
}

// what a mixed stretch sounded like, for the decision model after the recording stops; each is a yes/no question
export const TONES = [
  { name: 'debating', label: 'debating', instructions: 'Are these people debating or disagreeing about something?' },
  { name: 'joking', label: 'joking', instructions: 'Are these people joking around or teasing each other?' },
  { name: 'arguing', label: 'arguing', instructions: 'Is this a heated argument?' },
  { name: 'agreeing', label: 'agreeing', instructions: 'Are these people agreeing with and building on each other?' },
];
export function pickTone(answers, min = 0.6) {
  const best = TONES.map((t) => [t.label, answers?.[t.name]?.probability ?? 0]).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= min ? best[0] : null;
}
