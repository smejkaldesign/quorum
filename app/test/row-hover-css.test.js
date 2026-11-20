import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rulesFor = (needle) => css.split('\n').filter((l) => l.includes(needle) && l.includes('{'));

describe('row hover layout', () => {
  it('takes the time out of the row only on rows that have hover buttons', () => {
    const timeRules = rulesFor('.hist-time { position: absolute');
    expect(timeRules).toHaveLength(1);
    const selectors = timeRules[0].slice(0, timeRules[0].indexOf('{')).split(/,\s*(?=\.hist-row)/).map((s) => s.trim());
    for (const sel of selectors) expect(sel).toContain(':has(.hist-hover)');
  });
  it('puts the hover buttons in the row on hover, focus and an open menu', () => {
    const [rule] = rulesFor('.hist-hover { position: relative');
    expect(rule).toContain('.hist-row:is(:hover, :focus-within) .hist-hover');
    expect(rule).toContain('.hist-row.menu-open .hist-hover');
  });
});
