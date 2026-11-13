// One reading of a beta access code, shared by the gate screen (src/BetaGate.tsx, src/CodeBoxes.tsx), the main
// process (beta.js) and the Cloud sign-up (ee/account.js). The relay issues codes from ALPHABET: no 0 and no 1,
// because they are read as O and I, and a typed 0 or 1 is taken as the letter it looks like. GROUPS and ALPHABET are
// the only places the format lives: [2, 2, 2] would make a six-character code shown as XX-XX-XX everywhere at once.

export const GROUPS = [4, 4];
// the character class the relay issues from, and the same alphabet in words for the hint
export const ALPHABET = '[A-Z2-9]';
export const ALPHABET_TEXT = 'letters and the digits 2 to 9';
export const CODE_LENGTH = GROUPS.reduce((a, b) => a + b, 0);

const ONE = new RegExp(`^${ALPHABET}$`);
export const CODE = new RegExp(`^${GROUPS.map((n) => `${ALPHABET}{${n}}`).join('-')}$`);

// a code as it is shown: XXXX-XXXX for GROUPS [4, 4]
export const CODE_SHAPE = GROUPS.map((n) => 'X'.repeat(n)).join('-');
export const LENGTH_MESSAGE = `Enter the ${CODE_LENGTH}-character code, like ${GROUPS.map((n, g) => 'ABCDEFGHJKLMNPQR'.slice(g * n, g * n + n)).join('-')}.`;

// one character as the code reads it: uppercase, 0 as O, 1 as I; anything outside the alphabet is null
export function codeChar(c) {
  const u = String(c ?? '').toUpperCase().replace('0', 'O').replace('1', 'I');
  return u.length === 1 && ONE.test(u) ? u : null;
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
  const outside = [...new Set([...s.replace(/[\s-]/g, '')].filter((c) => !ONE.test(c)))];
  return outside.length ? `Codes use ${ALPHABET_TEXT}; ${outside.join(' ')} cannot be in one` : '';
}

// the box index where each group starts after the first, so the screen knows where to draw a dash
export const dashBefore = GROUPS.slice(0, -1).reduce((acc, n) => [...acc, (acc.at(-1) ?? 0) + n], []);

export const emptyCells = () => Array(CODE_LENGTH).fill('');

// typing into box `index`: one character fills that box and moves on, also when it equals what the box held; several
// (autofill, a paste that reached one box) fill from there. Characters outside the alphabet are dropped and named.
export function typeInto(cells, index, raw) {
  const next = [...cells];
  const chars = codeChars(raw);
  let i = index;
  for (const c of chars) { if (i >= CODE_LENGTH) break; next[i] = c; i += 1; }
  const rejected = String(raw ?? '').replace(/[\s-]/g, '').length > chars.length;
  return { cells: next, focus: Math.min(i, CODE_LENGTH - 1), hint: rejected ? codeHint(raw) || `Codes use ${ALPHABET_TEXT}` : codeHint(raw) };
}

// input that arrived without a keystroke the screen caught (autofill, dictation, an input method): a run of three or
// more characters is a code and fills from this box; otherwise the new character replaces this box only, with what
// the box already held taken out, so a character inserted before it never shifts the rest
export function fromInput(cells, index, raw) {
  if (codeChars(raw).length >= 3) return typeInto(cells, index, raw);
  const had = cells[index] ?? '';
  const s = String(raw ?? '');
  const at = had ? s.indexOf(had) : -1;
  const typed = at >= 0 ? s.slice(0, at) + s.slice(at + had.length) : s;
  return typed ? typeInto(cells, index, typed.slice(-1)) : { cells: [...cells], focus: index, hint: '' };
}

// a paste of a whole code, with or without its dash, any case, with spaces: it fills every box from the first
export function pasteCode(cells, index, raw) {
  return codeChars(raw).length >= CODE_LENGTH ? typeInto(emptyCells(), 0, raw) : typeInto(cells, index, raw);
}

// Backspace: clear the box, or when it is already empty, move back one and clear that one
export function backspace(cells, index) {
  const next = [...cells];
  if (next[index]) { next[index] = ''; return { cells: next, focus: index, hint: '' }; }
  const back = Math.max(0, index - 1);
  next[back] = '';
  return { cells: next, focus: back, hint: '' };
}

// Delete: clear this box and stay on it
export function deleteAt(cells, index) {
  const next = [...cells];
  next[index] = '';
  return { cells: next, focus: index, hint: '' };
}

export const cellsCode = (cells) => normalizeCode(cells.join(''));
export const cellsFull = (cells) => cells.length === CODE_LENGTH && cells.every(Boolean);

// whether the gate sends the code now: every box filled, nothing in flight, and this exact code not sent already
export const shouldSend = (cells, sent, busy) => !busy && cellsFull(cells) && cellsCode(cells) !== sent;

// a refusal that means the code itself is wrong, so the boxes clear; anything else (no connection, a timeout, a
// server error) keeps the code so it can be sent again
export const DEFINITE_REFUSALS = ['unknown', 'revoked', 'expired', 'used', 'bad_request'];
export const definiteRefusal = (reason) => DEFINITE_REFUSALS.includes(String(reason ?? ''));
