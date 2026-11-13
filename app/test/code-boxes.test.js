import { describe, expect, it, vi } from 'vitest';
import { OFFLINE, createBeta } from '../beta.js';
import {
  ALPHABET_TEXT, CODE, CODE_LENGTH, CODE_SHAPE, GROUPS, LENGTH_MESSAGE, backspace, cellsCode, cellsFull, codeChars, dashBefore,
  definiteRefusal, deleteAt, emptyCells, fromInput, pasteCode, shouldSend, typeInto,
} from '../betaCode.js';

describe('the code format', () => {
  it('is derived from GROUPS and ALPHABET alone', () => {
    expect(GROUPS).toEqual([4, 4]);
    expect(CODE_LENGTH).toBe(8);
    expect(dashBefore).toEqual([4]);
    expect(CODE_SHAPE).toBe('XXXX-XXXX');
    expect(LENGTH_MESSAGE).toBe('Enter the 8-character code, like ABCD-EFGH.');
    expect(CODE.test('ABCD-EFGH')).toBe(true);
    expect(CODE.test('ABCDEFGH')).toBe(false);
    expect(CODE.test('ABCD-EFG1')).toBe(false);
    expect(typeInto(emptyCells(), 0, '!').hint).toContain(ALPHABET_TEXT);
  });
  it('reads a sign-up code the same way as the gate: 0 and 1 as O and I, dash and spaces dropped', () => {
    expect(codeChars(' abc0-1fgh ').join('')).toBe('ABCOIFGH');
  });
});

describe('the code boxes', () => {
  it('typing fills a box and moves on; 0 and 1 read as O and I; other characters are refused with a hint', () => {
    let r = typeInto(emptyCells(), 0, 'a');
    expect(r.cells[0]).toBe('A');
    expect(r.focus).toBe(1);
    r = typeInto(r.cells, 1, '0');
    expect(r.cells[1]).toBe('O');
    expect(r.hint).toBe('0 reads as O');
    r = typeInto(r.cells, 2, '!');
    expect(r.cells[2]).toBe('');
    expect(r.focus).toBe(2);
    expect(r.hint).toMatch(/cannot be in one/);
  });
  it('typing the same character into a filled box keeps it and moves on', () => {
    const r = typeInto(['A', 'B', '', '', '', '', '', ''], 0, 'a');
    expect(r.cells.slice(0, 2)).toEqual(['A', 'B']);
    expect(r.focus).toBe(1);
  });
  it('input that arrives without a keystroke replaces only this box: an insertion before its character never shifts the rest', () => {
    const cells = ['A', 'B', 'C', '', '', '', '', ''];
    const before = fromInput(cells, 1, 'XB');
    expect(before.cells.slice(0, 4)).toEqual(['A', 'X', 'C', '']);
    expect(before.focus).toBe(2);
    const after = fromInput(cells, 1, 'BX');
    expect(after.cells.slice(0, 4)).toEqual(['A', 'X', 'C', '']);
    expect(fromInput(cells, 1, 'B').cells).toEqual(cells);
    const filled = fromInput(emptyCells(), 0, 'abcd-efgh');
    expect(cellsCode(filled.cells)).toBe('ABCD-EFGH');
  });
  it('a pasted code fills every box, with or without the dash, any case, with spaces', () => {
    for (const raw of ['abcd-efgh', 'ABCDEFGH', ' ab cd ef gh ', 'abcd efgh']) {
      const r = pasteCode(emptyCells(), 5, raw);
      expect(cellsFull(r.cells)).toBe(true);
      expect(cellsCode(r.cells)).toBe('ABCD-EFGH');
      expect(r.focus).toBe(7);
    }
    expect(pasteCode(emptyCells(), 2, 'xy').cells.slice(0, 4)).toEqual(['', '', 'X', 'Y']);
  });
  it('Backspace clears the box, or moves back and clears the one before when it is empty; Delete clears and stays', () => {
    const cells = ['A', 'B', '', '', '', '', '', ''];
    expect(backspace(cells, 1)).toEqual({ cells: ['A', '', '', '', '', '', '', ''], focus: 1, hint: '' });
    expect(backspace(cells, 2)).toEqual({ cells: ['A', '', '', '', '', '', '', ''], focus: 1, hint: '' });
    expect(backspace(emptyCells(), 0).focus).toBe(0);
    expect(deleteAt(cells, 0)).toEqual({ cells: ['', 'B', '', '', '', '', '', ''], focus: 0, hint: '' });
  });
  it('sends a full code once and never while a check is in flight', () => {
    const full = [...'ABCDEFGH'];
    expect(shouldSend(full, '', false)).toBe(true);
    expect(shouldSend(full, 'ABCD-EFGH', false)).toBe(false);
    expect(shouldSend(full, '', true)).toBe(false);
    expect(shouldSend([...'ABCDEFG', ''], '', false)).toBe(false);
  });
  it('clears the boxes only for a refusal of the code itself', () => {
    for (const r of ['unknown', 'revoked', 'expired', 'used', 'bad_request']) expect(definiteRefusal(r)).toBe(true);
    for (const r of ['server', 'rate_limit', undefined, '']) expect(definiteRefusal(r)).toBe(false);
  });
});

describe('the gate check', () => {
  const make = (fetchImpl) => createBeta({ settings: {}, edition: 'cloud', version: '0.3.1', env: { QUORUM_RELAY_URL: 'https://relay.example.com' }, fetchImpl, timers: { set: () => 0, clear: () => {} } });

  it('sends the code alone, with no email', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, plan: 'cloud' }) }));
    const r = await make(fetchImpl).check('abcd-efgh');
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('email');
    expect(body.code).toBe('ABCD-EFGH');
  });
  it('shows the relay sentence and marks a refusal of the code itself', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, reason: 'used', error: 'That access code is already in use on another Mac.' }) }));
    expect(await make(fetchImpl).check('ABCD-EFGH')).toEqual({ ok: false, refused: true, reason: 'That access code is already in use on another Mac.' });
  });
  it('keeps the code on a server error, and falls back to the reason only when there is no sentence', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, reason: 'server' }) }));
    expect(await make(fetchImpl).check('ABCD-EFGH')).toEqual({ ok: false, refused: false, reason: 'server' });
  });
  it('keeps the code and says the server could not be reached on a network failure or a timeout', async () => {
    expect(await make(vi.fn(async () => { throw new Error('fetch failed'); })).check('ABCD-EFGH')).toEqual({ ok: false, refused: false, reason: OFFLINE });
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    expect(await make(vi.fn(async () => { throw timeout; })).check('ABCD-EFGH')).toEqual({ ok: false, refused: false, reason: OFFLINE });
  });
  it('a code of the wrong length is refused before anything is sent, with the length from GROUPS', async () => {
    const fetchImpl = vi.fn();
    expect(await make(fetchImpl).check('ABC')).toEqual({ ok: false, refused: true, reason: LENGTH_MESSAGE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
