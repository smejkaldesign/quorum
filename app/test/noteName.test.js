import { describe, expect, it } from 'vitest';
import { isUntitled, parseName } from '../noteName.js';

describe('naming an untitled note', () => {
  it('knows an untitled note', () => {
    for (const t of ['', '  ', 'Untitled', 'untitled note', undefined]) expect(isUntitled(t)).toBe(true);
    expect(isUntitled('Grocery list')).toBe(false);
  });
  it('reads the title and summary lines', () => {
    expect(parseName('Title: "Launch checklist."\nSummary: Steps left before Monday.')).toEqual({ title: 'Launch checklist', summary: 'Steps left before Monday.' });
    expect(parseName('Summary: only this')).toBeNull();
    expect(parseName('Title: Untitled')).toBeNull();
  });
});
