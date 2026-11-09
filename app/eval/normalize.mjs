// Shared text normalizer for scoring. Reference and hypothesis go through the same rules so WER counts words and
// names, not formatting. Each rule is listed in order; the order matters because later rules see earlier output.

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINAL = { first: 'one', second: 'two', third: 'three', fifth: 'five', eighth: 'eight', ninth: 'nine', twelfth: 'twelve' };
const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'hmm', 'mm', 'mhm', 'ah', 'er', 'erm']);

// spelled numbers under one hundred become digits: "twenty five" -> 25, "fifteen" -> 15. Larger spelled numbers
// stay as words; references are written with digits above that range, as the engines also tend to output them.
function collapseNumberWords(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t in TENS) {
      const next = tokens[i + 1];
      if (next in ONES && ONES[next] < 10) { out.push(String(TENS[t] + ONES[next])); i++; } else out.push(String(TENS[t]));
    } else if (t in ONES) out.push(String(ONES[t]));
    else out.push(t);
  }
  return out;
}

export function normalize(text, { fillers = false } = {}) {
  let s = text.toLowerCase();
  // 1. percent: "%" and "percent" score the same
  s = s.replace(/%/g, ' percent ');
  // 2. currency: "$1,200" -> "1200 dollars"; "$3 million" -> "3 million dollars" so the unit follows the number
  s = s.replace(/\$\s?([\d.,]+)(\s+(?:thousand|million|billion|k|m)\b)?/g, (_, n, scale) => `${n}${scale ?? ''} dollars`);
  // 3. digit groups lose their commas: 1,200 -> 1200
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  // 4. ordinals lose their suffix: 14th -> 14; spelled ordinals become cardinals: third -> three
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1');
  s = s.replace(/\b(first|second|third|fifth|eighth|ninth|twelfth)\b/g, (m) => ORDINAL[m]);
  s = s.replace(/\b([a-z]+)(ieth|th)\b/g, (m, stem, suf) => (suf === 'ieth' ? `${stem}y` : stem in ONES || stem in TENS ? stem : m));
  // 4b. clock times become one number: 14:05, 14.05 and 1405 all score as 1405; 10:30 -> 1030
  s = s.replace(/\b(\d{1,2})[:.](\d{2})\b/g, '$1$2');
  // 5. "a.m." and "p.m." and other dotted abbreviations drop the dots: a.m. -> am
  s = s.replace(/\b([a-z])\.([a-z])\.?/g, '$1$2');
  // 6. decimal numbers keep their point; every other punctuation mark and hyphen becomes a space; apostrophes inside
  //    words survive so "we'll" stays one token
  s = s.replace(/(\d)\.(\d)/g, '$1decimalpoint$2');
  s = s.replace(/[^a-z0-9'\s]/g, ' ').replace(/decimalpoint/g, '.');
  s = s.replace(/(^|\s)'+|'+(\s|$)/g, ' ');
  // 7. spelled numbers under one hundred become digits, then "42 thousand" becomes 42000 so it matches "$42,000"
  let tokens = collapseNumberWords(s.split(/\s+/).filter(Boolean));
  tokens = tokens.flatMap((t, i, all) => (t === 'thousand' && /^\d+$/.test(all[i - 1] ?? '') ? [] : /^\d+$/.test(t) && all[i + 1] === 'thousand' ? [String(Number(t) * 1000)] : [t]));
  // 8. fillers leave only when the caller asks (clean mode), so a raw engine is scored on what it heard
  if (fillers) tokens = tokens.filter((t) => !FILLERS.has(t));
  return tokens.join(' ');
}

export const words = (text, opts) => normalize(text, opts).split(' ').filter(Boolean);
