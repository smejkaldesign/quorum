import { describe, expect, it } from 'vitest';
import { NO_SELECTION, bulkView, keepOnPage, selectedIds, toggleAcross, toggleOne, togglePage } from '../src/bulkSelect.ts';

const page = Array.from({ length: 50 }, (_, i) => `r${i}`);
const all = Array.from({ length: 273 }, (_, i) => `r${i}`);

describe('bulk bar selection', () => {
  it('labels the header checkbox with the page size and offers nothing else while empty', () => {
    const v = bulkView(page, NO_SELECTION, 273);
    expect(v).toMatchObject({ pageOn: false, count: 0, text: 'Select 50', checkLabel: 'Select 50', offerAll: false });
  });

  it('picks the page, then offers every matching item', () => {
    const s = togglePage(page, NO_SELECTION);
    const v = bulkView(page, s, 273);
    expect(v).toMatchObject({ pageOn: true, count: 50, text: '50 selected', offerAll: true, allLabel: 'Select all 273' });
    expect(selectedIds(s, page, all)).toHaveLength(50);
  });

  it('selects across pages and back to the page on a second press', () => {
    const across = toggleAcross(page, togglePage(page, NO_SELECTION));
    expect(across.across).toBe(true);
    expect(bulkView(page, across, 273)).toMatchObject({ count: 273, text: '273 selected', offerAll: true });
    expect(selectedIds(across, page, all)).toEqual(all);
    const back = toggleAcross(page, across);
    expect(back.across).toBe(false);
    expect(bulkView(page, back, 273).text).toBe('50 selected');
  });

  it('does not offer Select all when the page holds every match', () => {
    expect(bulkView(page.slice(0, 12), togglePage(page.slice(0, 12), NO_SELECTION), 12).offerAll).toBe(false);
  });

  it('a partial pick shows its count and no Select all', () => {
    const s = toggleOne('r3', toggleOne('r1', NO_SELECTION, page), page);
    expect(bulkView(page, s, 273)).toMatchObject({ pageOn: false, count: 2, text: '2 selected', offerAll: false });
  });

  it('the header checkbox clears a page or cross-page selection', () => {
    expect(togglePage(page, togglePage(page, NO_SELECTION))).toEqual(NO_SELECTION);
    expect(togglePage(page, toggleAcross(page, togglePage(page, NO_SELECTION)))).toEqual(NO_SELECTION);
  });

  it('unticking one row while everything is selected keeps the rest of the page', () => {
    const s = toggleOne('r0', toggleAcross(page, togglePage(page, NO_SELECTION)), page);
    expect(s.across).toBe(false);
    expect(bulkView(page, s, 273)).toMatchObject({ count: 49, pageOn: false, offerAll: false });
  });

  it('a reload drops picks that left the page and keeps across on', () => {
    const s = { picked: new Set(['r1', 'gone']), across: false };
    expect([...keepOnPage(s, page).picked]).toEqual(['r1']);
    const a = toggleAcross(page, togglePage(page, NO_SELECTION));
    expect(keepOnPage(a, page)).toBe(a);
  });
});
