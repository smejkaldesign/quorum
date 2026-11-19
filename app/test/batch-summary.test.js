import { describe, expect, it } from 'vitest';
import { batchSummary } from '../src/batchSummary';

const fixed = (title) => ({ title, status: 'success' });
describe('batchSummary', () => {
  it('names the one item that failed while the rest were fixed', () => {
    expect(batchSummary([fixed('a'), fixed('b'), { title: 'repo/_run/1', status: 'error', error: 'still opens nothing' }])).toBe('Fixed 2 of 3. 1 could not be fixed: “repo/_run/1”');
  });
  it('says the fixes were put back when the whole batch rolled back', () => {
    expect(batchSummary([{ title: 'a', status: 'error', rolledBack: true }, { title: 'b', status: 'error', rolledBack: true }, { title: 'c', status: 'error', error: 'x' }])).toBe('Fixed 0 of 3. Quorum put back the 2 items it had fixed, and 1 could not be fixed: “c”');
  });
  it('counts several failures without naming them', () => {
    expect(batchSummary([fixed('a'), { title: 'b', status: 'error' }, { title: 'c', status: 'error' }])).toBe('Fixed 1 of 3. 2 could not be fixed');
  });
  it('reports a clean run', () => { expect(batchSummary([fixed('a'), fixed('b')])).toBe('Fixed 2 of 2'); });
});
