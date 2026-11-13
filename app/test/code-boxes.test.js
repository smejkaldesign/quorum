import { describe, expect, it, vi } from 'vitest';
import { createBeta } from '../beta.js';
import { CODE, CODE_LENGTH, GROUPS, backspace, cellsCode, cellsFull, dashBefore, emptyCells, pasteCode, shouldSend, typeInto } from '../betaCode.js';

describe('the code boxes', () => {
  it('derive the layout from GROUPS', () => {
    expect(GROUPS).toEqual([4, 4]);
    expect(CODE_LENGTH).toBe(8);
    expect(dashBefore).toEqual([4]);
    expect(CODE.test('ABCD-EFGH')).toBe(true);
    expect(CODE.test('ABCDEFGH')).toBe(false);
  });

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

  it('a pasted code fills every box, with or without the dash, any case, with spaces', () => {
    for (const raw of ['abcd-efgh', 'ABCDEFGH', ' ab cd ef gh ', 'abcd efgh']) {
      const r = pasteCode(emptyCells(), 5, raw);
      expect(cellsFull(r.cells)).toBe(true);
      expect(cellsCode(r.cells)).toBe('ABCD-EFGH');
      expect(r.focus).toBe(7);
    }
    expect(pasteCode(emptyCells(), 2, 'xy').cells.slice(0, 4)).toEqual(['', '', 'X', 'Y']);
  });

  it('Backspace clears the box, or moves back and clears the one before when it is empty', () => {
    const cells = ['A', 'B', '', '', '', '', '', ''];
    expect(backspace(cells, 1)).toEqual({ cells: ['A', '', '', '', '', '', '', ''], focus: 1 });
    expect(backspace(cells, 2)).toEqual({ cells: ['A', '', '', '', '', '', '', ''], focus: 1 });
    expect(backspace(emptyCells(), 0).focus).toBe(0);
  });

  it('sends a full code once, never while a check is in flight, and again after a refusal resets what was sent', () => {
    const full = [...'ABCDEFGH'];
    expect(shouldSend(full, '', false)).toBe(true);
    expect(shouldSend(full, 'ABCD-EFGH', false)).toBe(false);
    expect(shouldSend(full, '', true)).toBe(false);
    expect(shouldSend([...'ABCDEFG', ''], '', false)).toBe(false);
  });
});

describe('the gate check', () => {
  it('sends the code alone when no account email is known', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, plan: 'cloud' }) }));
    const beta = createBeta({ settings: {}, edition: 'cloud', version: '0.3.1', env: { QUORUM_RELAY_URL: 'https://relay.example.com' }, fetchImpl, timers: { set: () => 0, clear: () => {} } });
    const r = await beta.check('abcd-efgh');
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.email).toBeUndefined();
    expect(body.code).toBe('ABCD-EFGH');
  });
});
