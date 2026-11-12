// One reading of a beta access code, shared by the gate screen (src/BetaGate.tsx) and the main process (beta.js).
// The relay issues codes from [A-Z2-9], eight characters shown as XXXX-XXXX: no 0 and no 1, because they are read as
// O and I. A typed 0 or 1 is taken as the letter it looks like.

export const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export function normalizeCode(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/[^A-Z2-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
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
