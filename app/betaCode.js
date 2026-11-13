// One reading of a beta access code, shared by the gate screen (src/BetaGate.tsx, src/CodeBoxes.tsx) and the main
// process (beta.js). The relay issues codes from [A-Z2-9]: no 0 and no 1, because they are read as O and I. A typed 0
// or 1 is taken as the letter it looks like. GROUPS is the one place the layout lives: eight characters shown as
// XXXX-XXXX today; [2, 2, 2] would make a six-character code shown as XX-XX-XX everywhere at once.

export const GROUPS = [4, 4];
export const CODE_LENGTH = GROUPS.reduce((a, b) => a + b, 0);
const ALPHABET = /[A-Z2-9]/;

export const CODE = new RegExp(`^${GROUPS.map((n) => `[A-Z2-9]{${n}}`).join('-')}$`);

// one character as the code reads it: uppercase, 0 as O, 1 as I; anything outside the alphabet is null
export function codeChar(c) {
  const u = String(c ?? '').toUpperCase().replace('0', 'O').replace('1', 'I');
  return u.length === 1 && ALPHABET.test(u) ? u : null;
}

// the characters of a code, in order, with the dash, spaces and anything else dropped
export const codeChars = (raw) => [...String(raw ?? '')].map(codeChar).filter(Boolean);

// a complete code with its dashes; a shorter one stays as the characters typed so far
export function normalizeCode(raw) {
  const s = codeChars(raw).join('');
  if (s.length !== CODE_LENGTH) return s;
  let at = 0;
  return GROUPS.map((n) => { const part = s.slice(at, at + n); at += n; return part; }).join('-');
}

export const isCode = (raw) => CODE.test(normalizeCode(raw));

// what to tell the person while they type: a swapped digit, a character outside the alphabet, or nothing
export function codeHint(raw) {
  const s = String(raw ?? '').toUpperCase();
  const swapped = [...new Set([...s].filter((c) => c === '0' || c === '1'))].map((c) => (c === '0' ? '0 reads as O' : '1 reads as I'));
  if (swapped.length) return swapped.join(', ');
  const outside = [...new Set([...s.replace(/[\s-]/g, '')].filter((c) => !/[A-Z2-9]/.test(c)))];
  return outside.length ? `Codes use letters and the digits 2 to 9; ${outside.join(' ')} cannot be in one` : '';
}

// the box index where each group starts after the first, so the screen knows where to draw a dash
export const dashBefore = GROUPS.slice(0, -1).reduce((acc, n) => [...acc, (acc.at(-1) ?? 0) + n], []);

export const emptyCells = () => Array(CODE_LENGTH).fill('');

// typing into box `index`: one character fills that box and moves on; several (autofill, a fast typist, a paste
// that reached one box) fill from there. Characters outside the alphabet are dropped and named in the hint.
export function typeInto(cells, index, raw) {
  const next = [...cells];
  const chars = codeChars(raw);
  let i = index;
  for (const c of chars) { if (i >= CODE_LENGTH) break; next[i] = c; i += 1; }
  const rejected = String(raw ?? '').replace(/[\s-]/g, '').length > chars.length;
  return { cells: next, focus: Math.min(i, CODE_LENGTH - 1), hint: rejected ? codeHint(raw) || 'Codes use letters and the digits 2 to 9' : codeHint(raw) };
}

// a paste of a whole code, with or without its dash, any case, with spaces: it fills every box from the first
export function pasteCode(cells, index, raw) {
  return codeChars(raw).length >= CODE_LENGTH ? typeInto(emptyCells(), 0, raw) : typeInto(cells, index, raw);
}

// Backspace: clear the box, or when it is already empty, move back one and clear that one
export function backspace(cells, index) {
  const next = [...cells];
  if (next[index]) { next[index] = ''; return { cells: next, focus: index }; }
  const back = Math.max(0, index - 1);
  next[back] = '';
  return { cells: next, focus: back };
}

export const cellsCode = (cells) => normalizeCode(cells.join(''));
export const cellsFull = (cells) => cells.length === CODE_LENGTH && cells.every(Boolean);

// whether the gate sends the code now: every box filled, nothing in flight, and this exact code not sent already
export const shouldSend = (cells, sent, busy) => !busy && cellsFull(cells) && cellsCode(cells) !== sent;
