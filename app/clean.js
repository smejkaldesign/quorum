// Rule-based cleanup of one speaker turn. Deletion only: fillers, repeats and false starts go, capitals and digits
// are written, no word is ever replaced with a different word (model "correction" of transcripts raises the error
// rate). The raw text stays on the turn; this produces the text people and the model read.
// Pure: no Electron, no settings. transcript.js applies it when a turn changes.

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINAL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30,
};
const NUMBER_WORDS = new Set([...Object.keys(SMALL), 'hundred', 'thousand', 'point']);
// doubled words that are grammar, not stammer: "I know that that is true", "she had had enough"
const DOUBLES = new Set(['that', 'had', 'is', 'do', 'can', 'will', 'was']);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const YEAR_LEAD = new Set(['in', 'by', 'for', 'since', 'until', 'of']);
// "you may first want to" is not a date; May needs a preposition in front
const DATE_LEAD = new Set(['in', 'on', 'by', 'for', 'until', 'till', 'before', 'after', 'since', 'from', 'of', 'around', 'through', 'due']);
const MONEY = new Set(['dollar', 'dollars', 'buck', 'bucks']);
const SCALE = new Set(['thousand', 'million', 'billion', 'trillion', 'k']);
const UNITS = new Set(['percent', 'cent', 'cents', 'million', 'billion', 'trillion', 'k', 'people', 'day', 'days', 'week', 'weeks', 'month', 'months',
  'year', 'years', 'minute', 'minutes', 'hour', 'hours', 'second', 'seconds', "o'clock"]);
const meridiem = (w) => (/^[ap]\.?m$/.test(w ?? '') ? `${w[0].toUpperCase()}M` : null);
const FILLER = /(?<![\w-])(?:u[mh]+|erm|hm+|mm-hmm)(?![\w-]),?/gi;
const LONE_FILLER = /^\W*(?:u[mh]+|erm|hm+|mm-hmm)\W*$/i;
// "things I like, and" keeps its like; the filler reading needs a word in front that does not take an object
const LIKE_LEAD = /\b(?:i|you|we|they|to|would|really|do|does|did|don't|doesn't|didn't|people|kids)$/i;
const TENS_HYPHEN = new RegExp(`\\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(?=(?:${[...Object.keys(SMALL), ...Object.keys(ORDINAL)].join('|')})\\b)`, 'gi');

const collapse = (s) => s.replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[,;:]\s*/, '').trim();

// 1. fillers, "you know" / "I mean" set off by commas, "like" before a comma, immediate repeats, false starts
export function dropDisfluencies(text) {
  if (LONE_FILLER.test(text)) return text.trim();
  let s = text.replace(FILLER, '');
  s = s.replace(/,\s*(?:you know|i mean)\s*,/gi, ',').replace(/(^|[.!?;:]\s*)(?:you know|i mean),\s*/gi, '$1');
  s = s.replace(/(^|\s)like,\s*/gi, (m, lead, off) => (LIKE_LEAD.test(s.slice(0, off)) ? m : lead));
  s = s.replace(/\b([\w']+)(?:\s+\1\b)+/gi, (m, w) => (NUMBER_WORDS.has(w.toLowerCase()) || DOUBLES.has(w.toLowerCase()) ? m : w));
  s = s.replace(/\b((?:[\w']+\s+){0,2})([\w']+)[-–—]\s+\1(\2[\w']*)\b/gi, '$1$3');
  return collapse(s);
}

// 3. a capital at the start and after sentence punctuation; words that carry their own capitals are left alone
export const capitalize = (text) => text.replace(/(^|[.!?]\s+)([a-z])(?![a-z0-9']*[A-Z])/g, (m, lead, c) => lead + c.toUpperCase());

// a cardinal from number words starting at i: {value, n} for the longest well-formed prefix, null when none
function cardinal(ws, i) {
  let total = 0, cur = 0, n = 0, state = 0;
  for (; i + n < ws.length; n++) {
    const w = ws[i + n], v = SMALL[w];
    if (v !== undefined) {
      if (v > 0 && v < 10 && state === 1) { cur += v; state = 2; continue; }
      if (state === 0 || state === 3 || state === 4) { cur += v; state = v >= 20 ? 1 : 2; continue; }
      break;
    }
    if (w === 'hundred' && (state === 1 || state === 2) && cur > 0 && cur < 100) { cur *= 100; state = 3; continue; }
    if (w === 'thousand' && cur > 0 && total === 0) { total = cur * 1000; cur = 0; state = 4; continue; }
    break;
  }
  return n ? { value: total + cur, n } : null;
}

// "two point five": digits after point come one word at a time
function decimal(ws, i) {
  const c = cardinal(ws, i);
  if (!c || ws[i + c.n] !== 'point') return c;
  let n = c.n + 1, frac = '';
  while (i + n < ws.length && SMALL[ws[i + n]] !== undefined && SMALL[ws[i + n]] < 10) frac += SMALL[ws[i + n++]];
  return frac ? { value: Number(`${c.value}.${frac}`), n, text: `${c.value}.${frac}` } : c;
}

// "twenty twenty six" -> 2026, "nineteen hundred" -> 1900, "two thousand twenty" -> 2020
function year(ws, i) {
  const a = cardinal(ws, i);
  if (!a) return null;
  if (a.value >= 1000 && a.value < 3000 && a.n >= 2) return a;
  if (a.value < 10 || a.value > 99 || a.n > 2) return null;
  if (ws[i + a.n] === 'hundred') return { value: a.value * 100, n: a.n + 1 };
  const b = cardinal(ws, i + a.n);
  return b && b.value >= 10 && b.value <= 99 ? { value: a.value * 100 + b.value, n: a.n + b.n } : null;
}

function ordinal(ws, i) {
  const o = ORDINAL[ws[i]];
  if (o !== undefined) return { value: o, n: 1 };
  const t = SMALL[ws[i]], u = ORDINAL[ws[i + 1]];
  return t >= 20 && u > 0 && u < 10 ? { value: t + u, n: 2 } : null;
}

const hour12 = (w) => { const h = SMALL[w] ?? (/^\d{1,2}$/.test(w ?? '') ? Number(w) : undefined); return h >= 1 && h <= 12 ? h : null; };
const cap = (w) => w[0].toUpperCase() + w.slice(1);

// ws is the window of words from i to the next punctuation mark. Returns {n, out} to rewrite n words, {skip} to leave
// a run of number words alone (a partial parse would split it), or null when nothing applies at this word
function phrase(ws, i, prev) {
  const w = ws[i];
  if ((w === 'half' || w === 'quarter') && (ws[i + 1] === 'past' || (w === 'quarter' && ws[i + 1] === 'to'))) {
    const h = hour12(ws[i + 2]);
    if (h) return { n: 3, out: ws[i + 1] === 'to' ? `${h === 1 ? 12 : h - 1}:45` : `${h}:${w === 'half' ? 30 : 15}` };
  }
  if (MONTHS.includes(w) && (w !== 'may' || DATE_LEAD.has(prev))) {
    const d = ordinal(ws, i + 1) ?? (SMALL[ws[i + 1]] !== undefined ? cardinal(ws, i + 1) : null);
    if (d && d.value >= 1 && d.value <= 31) {
      const y = year(ws, i + 1 + d.n);
      if (y) return { n: 1 + d.n + y.n, out: `${cap(w)} ${d.value}, ${y.value}` };
      if (!NUMBER_WORDS.has(ws[i + 1 + d.n] ?? '')) return { n: 1 + d.n, out: `${cap(w)} ${d.value}` };
    }
    const y = year(ws, i + 1);
    return y ? { n: 1 + y.n, out: `${cap(w)} ${y.value}` } : null;
  }
  if (/^\d{1,2}(:\d{2})?$/.test(w) && meridiem(ws[i + 1]) && parseInt(w, 10) <= 12) return { n: 2, out: `${w} ${meridiem(ws[i + 1])}` };
  if (/^\d+$/.test(w)) return ws[i + 1] === 'percent' ? { n: 2, out: `${w}%` } : null;
  if (SMALL[w] === undefined) return null;
  let run = 0;
  while (i + run < ws.length && NUMBER_WORDS.has(ws[i + run])) run++;
  if (YEAR_LEAD.has(prev)) { const y = year(ws, i); if (y && y.n === run) return { n: y.n, out: String(y.value) }; }
  const c = decimal(ws, i);
  const shown = c.text ?? String(c.value), after = ws[i + c.n];
  if (c.n === 1 && c.value >= 1 && c.value <= 12) {
    if (meridiem(after)) return { n: 2, out: `${c.value} ${meridiem(after)}` };
    const mins = cardinal(ws, i + 1), m = mins && meridiem(ws[i + 1 + mins.n]);
    if (m && mins.value <= 59) return { n: 2 + mins.n, out: `${c.value}:${String(mins.value).padStart(2, '0')} ${m}` };
  }
  if (c.n < run) return { skip: run };
  if (after === 'percent') return { n: c.n + 1, out: `${shown}%` };
  if (MONEY.has(after)) return { n: c.n + 1, out: `$${shown}` };
  if (SCALE.has(after) && MONEY.has(ws[i + c.n + 1])) return { n: c.n + 2, out: `$${shown}${after === 'k' ? 'k' : ` ${after}`}` };
  if (after === 'k') return { n: c.n + 1, out: `${shown}k` };
  if (UNITS.has(after)) return { n: c.n + 1, out: `${shown} ${after}` };
  return c.n >= 2 || c.value >= 10 ? { n: c.n, out: shown } : null;
}

// 4. spelled numbers become digits when they form a phrase or carry a unit. Words keep their own spacing and the
// punctuation stuck to them; a mark ends the window a phrase may span. The period of a mid-sentence "p.m." goes with it
export function writeNumbers(text) {
  const toks = text.replace(TENS_HYPHEN, '$1 ').split(/(\s+)/);
  const parts = [], words = [];
  for (let k = 0; k < toks.length; k += 2) {
    const m = toks[k].match(/^([^A-Za-z0-9$]*)(.*?)([^A-Za-z0-9%]*)$/);
    parts.push(m);
    words.push(m[2].toLowerCase().replace(/’/g, "'"));
  }
  let out = '';
  for (let j = 0; j < words.length; j++) {
    if (j) out += toks[2 * j - 1];
    let end = j;
    while (end < words.length - 1 && parts[end][3] === '') end++;
    const r = words[j] ? phrase(words.slice(j, end + 1), 0, words[j - 1] ?? '') : null;
    if (!r || r.skip) {
      const n = r?.skip ?? 1;
      for (let q = 0; q < n; q++) out += (q ? toks[2 * (j + q) - 1] : '') + toks[2 * (j + q)];
      j += n - 1;
      continue;
    }
    const last = j + r.n - 1, abbr = words[last].includes('.') && parts[last][3] === '.' && last < words.length - 1;
    out += parts[j][1] + r.out + (abbr ? '' : parts[last][3]);
    j = last;
  }
  return out;
}

export function cleanTurn(text, { verbatim = false } = {}) {
  const t = text.trim();
  if (!t) return t;
  return capitalize(verbatim ? t : writeNumbers(dropDisfluencies(t)));
}
