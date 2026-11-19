// Supersession of single-valued facts (graph/temporal.js).
import { describe, expect, it } from 'vitest';
import { subjectOf, supersessions } from '../graph/temporal.js';

const e = (id, over) => ({ id, src: 'person:ana', dst: 'company:acme', kind: 'member_of', provenance: 'explicit', source_rel: 'a.md', valid_from: null, superseded_by: null, props: null, ...over });

describe('supersessions', () => {
  it('ends the older company when a later note names another', () => {
    const old = e(1, { valid_from: 100, source_rel: 'old.md' });
    const neu = e(2, { dst: 'company:globex', valid_from: 200, source_rel: 'new.md' });
    expect(supersessions([old], neu)).toEqual([{ old: 1, by: 2, at: 200 }]);
    // an older fact learned later is the one that ends
    expect(supersessions([neu], { ...old, id: 3 })).toEqual([{ old: 3, by: 2, at: 200 }]);
  });

  it('replaces on an edit to the same note with no dates, and never across notes with no dates', () => {
    expect(supersessions([e(1)], e(2, { dst: 'company:globex' }), 50)).toEqual([{ old: 1, by: 2, at: 50 }]);
    expect(supersessions([e(1)], e(2, { dst: 'company:globex', source_rel: 'b.md' }))).toEqual([]);
  });

  it('leaves facts that agree, and kinds that hold many values, alone', () => {
    expect(supersessions([e(1, { valid_from: 100 })], e(2, { valid_from: 200 }))).toEqual([]);
    expect(subjectOf({ kind: 'works_on', src: 'p', dst: 'x', props: null })).toBe(null);
    expect(subjectOf({ kind: 'attended', src: 'p', dst: 'm' })).toBe(null);
    const a = { id: 1, kind: 'works_on', src: 'person:ana', dst: 'project:atlas', props: { role: 'lead' }, valid_from: 100, superseded_by: null };
    expect(supersessions([a], { ...a, id: 2, dst: 'project:zeus', props: { role: 'advisor' }, valid_from: 200 })).toEqual([]);
    expect(supersessions([a], { ...a, id: 2, props: { role: 'advisor' }, valid_from: 200 })).toEqual([{ old: 1, by: 2, at: 200 }]);
  });

  it('replaces a decision about the same subject only when the key matches', () => {
    const d = (id, src, key, t) => ({ id, src, dst: 'project:atlas', kind: 'decision_about', props: key ? { key } : null, valid_from: t, superseded_by: null, source_rel: `${src}.md` });
    expect(supersessions([d(1, 'decision:a', 'database', 100)], d(2, 'decision:b', 'database', 200))).toEqual([{ old: 1, by: 2, at: 200 }]);
    expect(supersessions([d(1, 'decision:a', 'database', 100)], d(2, 'decision:b', 'hosting', 200))).toEqual([]);
    expect(supersessions([d(1, 'decision:a', null, 100)], d(2, 'decision:b', null, 200))).toEqual([]);
  });
});
