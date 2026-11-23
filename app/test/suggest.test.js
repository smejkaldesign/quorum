import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSuggester } from '../suggest.js';

const vault = mkdtempSync(path.join(tmpdir(), 'suggest-'));
const note = (rel, text) => { writeFileSync(path.join(vault, rel), text); return path.join(vault, rel); };

function make(hits) {
  const cards = [];
  const prompts = [];
  const queries = [];
  const s = createSuggester({
    runClaude: async (prompt) => { prompts.push(prompt); return prompts.length === 1 ? JSON.stringify({ suggestions: [{ kind: 'topic', text: 'Pricing', query: 'pricing plan' }] }) : 'Answer [1]'; },
    toUI: (ch, v) => { if (ch === 'suggestion') cards.push(v); },
    log: () => {},
    getTranscript: () => [{ who: 'them', text: 'What about the pricing plan?' }],
    getSettings: () => ({ vaultPath: vault, workspace: { optOuts: [{ name: 'Globex' }] } }),
    owner: 'Ana',
    noteLink: () => ({ app: 'quorum', url: null }),
    search: (q) => { queries.push(q); return typeof hits === 'function' ? hits(q) : hits; },
  });
  return { s, cards, prompts, queries };
}

describe('meeting suggestions', () => {
  it('finds notes with the search it is given and answers from them', async () => {
    const abs = note('pricing.md', '# Pricing\n\nThe plan is $25 a seat.\n');
    const { s, cards, prompts, queries } = make([{ rel: 'pricing.md', abs, title: 'Pricing', line: 2, snippet: 'The plan is $25 a seat.' }]);
    await s.detect();
    expect(queries).toEqual(['pricing plan']);
    expect(cards).toHaveLength(1);
    expect(cards[0].caption).toBe('Using your memory · 1 note');
    const r = await s.accept(cards[0].id);
    expect(r.sources).toEqual([{ n: 1, title: 'Pricing', rel: 'pricing.md', abs, app: 'quorum', url: null }]);
    expect(prompts[1]).toContain('The plan is $25 a seat.');
  });
  it('leaves out notes that name an opted-out customer and offers nothing without notes', async () => {
    const abs = note('globex.md', '# Globex pricing\n');
    const { s, cards } = make([{ rel: 'globex.md', abs, title: 'Globex pricing', line: -1, snippet: '' }]);
    await s.detect();
    expect(cards).toEqual([]);
  });

  it('tries the longest word alone when the whole query finds no note', async () => {
    const abs = note('pricing-2.md', '# Pricing\n\nSeats cost $25.\n');
    const { s, cards, queries } = make((q) => (q === 'pricing' ? [{ rel: 'pricing-2.md', abs, title: 'Pricing', line: 2, snippet: 'Seats cost $25.' }] : []));
    await s.detect();
    expect(queries).toEqual(['pricing plan', 'pricing']);
    expect(cards.length).toBeGreaterThan(0);
  });

  it('leaves session logs out of suggestions', async () => {
    const { s, cards } = make([{ rel: 'memory/sessions/2026-11-17.md', abs: path.join(vault, 'memory/sessions/2026-11-17.md'), title: 'Session', line: 0, snippet: 'pricing plan' }]);
    await s.detect();
    expect(cards).toEqual([]);
  });
});
