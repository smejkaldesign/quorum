import { describe, expect, it } from 'vitest';
import { buildPlan } from '../batchPlan.js';
import { findingItem, itemLine, linkItem, linkLines, pastFixItem } from '../reviewItems.js';
import { removeFrontmatterKey, setFrontmatterKey } from '../frontmatter.js';
import { compile } from '../guardrails.js';

// synthetic issues, runs and findings; every name is made up
const noteOf = (rel) => ({ 'a.md': { links: [{ target: 'Kite', line: 2 }, { target: 'kite', line: 5 }, { target: 'Lamp', line: 5 }] } })[rel] ?? null;
const issue = (o) => ({ key: o.target.toLowerCase(), sources: ['a.md'], links: 2, reviewOnly: false, ...o });

describe('review items', () => {
  it('reads the lines of each link to a target', () => {
    expect(linkLines(noteOf, ['a.md', 'b.md'], 'KITE')).toEqual({ 'a.md': [2, 5] });
  });
  it('turns a missing link into its fix, and holds one that leaves the link', () => {
    expect(linkItem(issue({ target: 'Kite', action: 'relink', candidate: { rel: 'kites.md' } }), { noteOf })).toMatchObject({ id: 'r:link:kite', autoFix: true, ops: [{ op: 'relink', to: 'kites.md', lines: { 'a.md': [2, 5] } }] });
    expect(linkItem(issue({ target: 'Harbor', action: 'create', createIn: 'notes', reviewOnly: true })).ops).toEqual([{ op: 'create', rel: 'notes/Harbor.md', sources: ['a.md'] }]);
    expect(linkItem(issue({ target: 'Elsewhere', action: 'leave' }))).toMatchObject({ hold: 'Its fix leaves the link as it is. Archive it instead.', autoFix: false });
  });
  it('turns a flagged past fix into its corrective fix, or holds it with the reason', () => {
    const run = { id: 'fix:kite:1', key: 'kite', target: 'Kite' };
    const ok = pastFixItem({ run, res: { action: 'create' }, plan: { ok: true, kind: 'trash', files: [{ rel: 'n/Kite.md', before: null, expect: 'h' }] } });
    expect(ok).toMatchObject({ id: 'r:pastfix:fix:kite:1', group: 'trash', autoFix: true, link: 'kite', ops: [{ op: 'trash', rel: 'n/Kite.md' }] });
    expect(itemLine(ok)).toBe('Remove “n/Kite.md”, which an earlier fix wrote for “Kite”');
    expect(itemLine({ kind: 'link', target: 'Kite', agent: { line: 'Write a note about “Kite” from the 2 notes that link to it, as the agent drafts it' }, ops: [{ op: 'create', rel: 'Kite.md' }] })).toMatch(/^Write a note about “Kite”/);
    expect(itemLine({ kind: 'link', target: 'Kite', fallback: 'A quote did not check.', ops: [{ op: 'unlink', target: 'Kite' }] })).toBe('Remove the dead links to “Kite” and keep their words');
    expect(pastFixItem({ run, res: {}, plan: { ok: false, why: 'It changed.' } })).toMatchObject({ hold: 'It changed.', ops: [] });
  });
  it('turns a confidential finding into tag, move, or move and tag steps', () => {
    const f = (fix) => ({ key: 'note.confidential-folder:x', rel: 'loose/x.md', fix, autoFix: false });
    expect(findingItem(f({ kind: 'move-tag', to: 'deals/x.md', value: 'deal' })).ops).toEqual([{ op: 'tag', rel: 'loose/x.md', value: 'deal' }, { op: 'move', rel: 'loose/x.md', to: 'deals/x.md' }]);
    expect(itemLine(findingItem(f({ kind: 'move-tag', to: 'deals/x.md', value: 'deal' })))).toBe('Tag “loose/x.md” confidential: deal and move it to “deals/x.md”');
    expect(findingItem(f(null))).toMatchObject({ keep: true, ops: [{ op: 'keep' }] });
  });
  it('plans a corrective fix ahead of a relink onto the stub it removes', () => {
    const past = pastFixItem({ run: { id: 'r1', key: 'kite', target: 'Kite' }, res: { action: 'create' }, plan: { ok: true, kind: 'trash', files: [{ rel: 'n/Kite.md', before: null }] } });
    const onto = linkItem(issue({ target: 'Kites', action: 'alias', candidate: { rel: 'n/Kite.md' } }));
    const p = buildPlan([onto, past]);
    expect(p.ok).toEqual([past.id]);
    expect(p.skipped[0].id).toBe(onto.id);
  });
});

describe('confidential frontmatter and folders', () => {
  it('adds and removes the key, keeping every other byte', () => {
    const text = '---\ntitle: X\n---\n# X\n';
    const on = setFrontmatterKey(text, 'confidential', 'deal');
    expect(on).toBe('---\ntitle: X\nconfidential: deal\n---\n# X\n');
    expect(removeFrontmatterKey(on, 'confidential')).toBe(text);
    expect(removeFrontmatterKey('---\nconfidential: deal\n---\n# X\n', 'confidential')).toBe('# X\n');
    expect(removeFrontmatterKey('# no frontmatter', 'confidential')).toBe('# no frontmatter');
  });
  it('denies a marked folder while the built-in confidential rule is on', () => {
    const rule = (enabled) => [{ id: 'built-in:confidential', kind: 'frontmatter', value: 'confidential', enabled }];
    expect(compile(rule(true), { confidentialDirs: ['vault/plans/'] }).denyDirs).toEqual(['vault/plans']);
    expect(compile(rule(false), { confidentialDirs: ['vault/plans'] }).denyDirs).toEqual([]);
  });
});
