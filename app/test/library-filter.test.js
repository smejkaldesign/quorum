import { describe, expect, it } from 'vitest';
import { AREAS, CONNECTORS, areaOf } from '../connectors/library.js';
import { libraryAreas } from '../src/libraryFilter.ts';

// what the library sheet treats as connectable here: built, and not one of the two marked as missing from this build
const ready = (x) => x.status === 'available' && !['notion', 'zoom'].includes(x.id);
const rank = () => 0;
const ids = (areas) => areas.flatMap((a) => a.items.map((x) => x.id));

describe('the connector library', () => {
  it('hides every connector that cannot be connected by default, and drops an area left empty', () => {
    const shown = libraryAreas(CONNECTORS, AREAS, { areaOf, ready, rank, showHidden: false });
    expect(ids(shown)).toContain('granola');
    expect(ids(shown)).not.toContain('otter');
    expect(ids(shown)).not.toContain('notion');
    expect(shown.every((a) => a.items.length > 0 && a.items.every(ready))).toBe(true);
    const onlySoon = libraryAreas(CONNECTORS.filter((x) => x.id === 'otter' || x.id === 'granola'), AREAS, { areaOf, ready, rank, showHidden: false });
    expect(onlySoon.map((a) => a.area.id)).toEqual(['meeting-notes']);
  });
  it('Show hidden brings them back, after the ones that can be connected', () => {
    const all = libraryAreas(CONNECTORS, AREAS, { areaOf, ready, rank, showHidden: true });
    expect(ids(all)).toHaveLength(CONNECTORS.length);
    const notes = all.find((a) => a.area.id === 'meeting-notes').items;
    const firstHidden = notes.findIndex((x) => !ready(x));
    expect(firstHidden).toBeGreaterThan(0);
    expect(notes.slice(firstHidden).every((x) => !ready(x))).toBe(true);
  });
});
