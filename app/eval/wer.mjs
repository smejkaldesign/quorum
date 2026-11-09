// Word error rate, entity error rate and cpWER. Inputs are turn lists: [{ speaker | channel, text }]. All text goes
// through normalize() first, with the same options for reference and hypothesis.
import { normalize, words } from './normalize.mjs';

// Levenshtein over word arrays, with the three error types split out
export function editOps(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  let i = n, j = m, sub = 0, del = 0, ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { if (ref[i - 1] !== hyp[j - 1]) sub++; i--; j--; }
    else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { del++; i--; }
    else { ins++; j--; }
  }
  return { sub, del, ins, errors: sub + del + ins, refWords: n };
}

const speakerOf = (t) => t.speaker ?? t.channel;
const joined = (turns) => turns.map((t) => t.text).join(' ');

export function wer(refTurns, hypTurns, opts) {
  const ops = editOps(words(joined(refTurns), opts), words(joined(hypTurns), opts));
  return { ...ops, wer: ops.refWords ? ops.errors / ops.refWords : 0 };
}

// fraction of entities whose normalized form is absent from the hypothesis, as a word sequence
export function entityErrorRate(entities, hypTurns, opts) {
  if (!entities?.length) return { missing: [], total: 0, eer: 0 };
  const hyp = ` ${normalize(joined(hypTurns), opts)} `;
  const missing = entities.filter((e) => !hyp.includes(` ${normalize(e, opts)} `));
  return { missing, total: entities.length, eer: missing.length / entities.length };
}

function* permutations(list) {
  if (list.length <= 1) { yield list; return; }
  for (let i = 0; i < list.length; i++) for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) yield [list[i], ...rest];
}

// concatenated minimum-permutation WER: each speaker's words joined in order, hypothesis speakers mapped onto
// reference speakers by the permutation with the fewest total errors. Unmatched speakers score every word as an error.
export function cpWER(refTurns, hypTurns, opts) {
  const bySpeaker = (turns) => {
    const map = new Map();
    for (const t of turns) map.set(speakerOf(t), [...(map.get(speakerOf(t)) ?? []), ...words(t.text, opts)]);
    return map;
  };
  const ref = bySpeaker(refTurns), hyp = bySpeaker(hypTurns);
  const refNames = [...ref.keys()], hypNames = [...hyp.keys()];
  const size = Math.max(refNames.length, hypNames.length);
  const padded = [...hypNames, ...Array(size - hypNames.length).fill(null)];
  let best = null;
  for (const perm of permutations(padded)) {
    let errors = 0;
    const mapping = {};
    for (let i = 0; i < size; i++) {
      const r = refNames[i], h = perm[i];
      const rw = r ? ref.get(r) : [], hw = h ? hyp.get(h) : [];
      errors += editOps(rw, hw).errors;
      if (h && r) mapping[h] = r;
    }
    if (!best || errors < best.errors) best = { errors, mapping };
  }
  const refWords = [...ref.values()].reduce((n, w) => n + w.length, 0);
  return { ...best, refWords, cpwer: refWords ? best.errors / refWords : 0 };
}

// corpus level: error and word counts summed across items before dividing
export function aggregate(items) {
  const sum = (k) => items.reduce((n, it) => n + it[k], 0);
  const refWords = sum('refWords'), entities = sum('entities');
  return {
    items: items.length,
    wer: refWords ? sum('errors') / refWords : 0,
    eer: entities ? sum('entitiesMissing') / entities : 0,
    cpwer: refWords ? sum('cpErrors') / refWords : 0,
  };
}
