import { describe, expect, it } from 'vitest';
import { parseNote } from '../linkparse.js';
import { RULES, mergeFindings, runRules } from '../rules/index.js';
import * as orphans from '../rules/orphans.js';
import * as duplicates from '../rules/duplicates.js';
import * as frontmatter from '../rules/frontmatter.js';
import * as oversized from '../rules/oversized.js';
import * as confidential from '../rules/confidential.js';
import * as secrets from '../rules/secrets.js';
import * as stale from '../rules/stale.js';

// Synthetic notes for each rule. Every name and line is made up.
const NOW = Date.UTC(2026, 10, 15);
const DAY = 86400000;
const note = (rel, text, extra = {}) => ({ rel, text, note: parseNote(rel, text), mtime: NOW - DAY, size: text.length, inbound: 1, outbound: 1, ...extra });
const ctx = (notes, extra = {}) => ({ notes, resolve: (t) => notes.find((n) => n.rel.replace(/\.md$/, '').split('/').pop() === t)?.rel ?? null, now: NOW, ...extra });
const rels = (fs) => fs.flatMap((f) => f.notes);
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
const words = (n, seed = 'orbit') => Array.from({ length: n }, (_, i) => `${seed}${i % 37}`).join(' ');

describe('every rule', () => {
  it('has an id, a version, a readable label, and offers no automatic fix', () => {
    for (const r of RULES) {
      expect(r.rule.id).toMatch(/^note\.[a-z-]+$/);
      expect(r.rule.version).toBeGreaterThanOrEqual(1);
      expect(r.rule.label).toMatch(/^[A-Z][^.]+$/);
    }
    const { findings } = runRules(ctx([note('a/x.md', `${fm({ status: 'draft', updated: '2026-01-01' })}# X`)]));
    expect(findings.every((f) => f.autoFix === false && f.proposal && f.problem && f.evidence.length)).toBe(true);
  });
  it('skips generated reports and logs', () => {
    const report = note('ops/drift-report.md', `${fm({ status: 'draft', updated: '2026-01-01' })}# Drift`, { inbound: 0, outbound: 0 });
    expect(runRules(ctx([report])).findings).toEqual([]);
  });
  it('keeps the findings on other notes when it runs for some notes only', () => {
    const prev = [{ key: 'a', notes: ['a.md'] }, { key: 'b', notes: ['b.md'] }];
    expect(mergeFindings(prev, [{ key: 'b2', notes: ['b.md'] }], ['b.md']).map((f) => f.key)).toEqual(['a', 'b2']);
    expect(mergeFindings(prev, [{ key: 'c', notes: ['c.md'] }], null).map((f) => f.key)).toEqual(['c']);
  });
});

describe('orphans', () => {
  const linked = (i) => note(`projects/linked-${i}.md`, `# Linked ${i}`);
  it('flags a note with no links in or out in a folder where most notes are linked', () => {
    const lone = note('projects/lone-idea.md', '# Lone idea', { inbound: 0, outbound: 0 });
    expect(rels(orphans.run(ctx([...[1, 2, 3, 4].map(linked), lone])))).toEqual(['projects/lone-idea.md']);
  });
  it('leaves entry points, dated notes, inbox, archive and log-style folders alone', () => {
    const notes = [1, 2, 3, 4].map(linked);
    const zero = { inbound: 0, outbound: 0 };
    const quiet = [
      note('projects/README.md', '# Read me', zero), note('projects/2026-03-01-plan.md', '# Plan', zero),
      note('inbox/raw-thought.md', '# Raw', zero), note('projects/old-archive/kept.md', '# Kept', zero),
      ...[1, 2, 3].map((i) => note(`logs/run-${i}.md`, `# Run ${i}`, zero)),
    ];
    expect(orphans.run(ctx([...notes, ...quiet]))).toEqual([]);
  });
  it('counts a note named in another note’s frontmatter as linked', () => {
    const lone = note('projects/lone-idea.md', '# Lone idea', { inbound: 0, outbound: 0 });
    const parent = note('projects/parent.md', `${fm({ related: '"[[lone-idea]]"' })}# Parent`);
    expect(orphans.run(ctx([...[1, 2, 3].map(linked), parent, lone]))).toEqual([]);
  });
  it('leaves a note that links out', () => {
    expect(orphans.run(ctx([...[1, 2, 3, 4].map(linked), note('projects/hub.md', '# Hub', { inbound: 0, outbound: 3 })]))).toEqual([]);
  });
});

describe('duplicates', () => {
  const body = `# Orbit notes\n${words(60)}`;
  it('flags two notes with the same body, frontmatter aside', () => {
    const f = duplicates.run(ctx([note('a/orbit.md', `${fm({ tags: 'x' })}${body}`), note('b/orbit copy.md', body)]));
    expect(f).toHaveLength(1);
    expect(f[0].notes).toEqual(['a/orbit.md', 'b/orbit copy.md']);
  });
  it('leaves near-empty notes that share only template lines', () => {
    const tpl = (d) => `# Weekly sync ${d}\n## Agenda\n## Notes\n## Actions`;
    expect(duplicates.run(ctx(['01', '08', '15'].map((d) => note(`meetings/2026-01-${d}.md`, tpl(d)))))).toEqual([]);
  });
  it('leaves a folder that mirrors another on purpose', () => {
    const notes = [];
    for (let i = 0; i < 6; i++) { const b = `# Topic ${i}\n${words(60, `t${i}x`)}`; notes.push(note(`seed/topic-${i}.md`, b), note(`staging/topic-${i}.md`, b)); }
    expect(duplicates.run(ctx(notes))).toEqual([]);
  });
});

describe('frontmatter schema', () => {
  const folder = (n, props) => Array.from({ length: n }, (_, i) => note(`specs/spec-${i}.md`, `${fm(props)}# Spec ${i}`));
  it('learns expected keys and types from the folder and flags a note that misses one or has the wrong type', () => {
    const notes = [...folder(5, { status: 'draft', date: '2026-01-02' }), note('specs/odd.md', `${fm({ date: 'soon' })}# Odd`)];
    const [f] = frontmatter.run(ctx(notes));
    expect(f.notes).toEqual(['specs/odd.md']);
    expect(f.evidence.join(' ')).toMatch(/Missing “status”.*“date” is text; the notes in specs use date/);
  });
  it('flags a key written twice', () => {
    const [f] = frontmatter.run(ctx([note('a/x.md', '---\nsummary: one\nsummary: two\n---\n# X')]));
    expect(f.evidence).toEqual(['“summary” is written 2 times; only the last one counts']);
  });
  it('learns nothing from a small folder or from keys under 80%, and skips index notes and the confidential key', () => {
    expect(frontmatter.run(ctx([...folder(3, { status: 'x' }), note('specs/bare.md', '# Bare')]))).toEqual([]);
    const mixed = [...folder(4, { owner: 'ana' }), ...[1, 2].map((i) => note(`specs/plain-${i}.md`, '# Plain'))];
    expect(frontmatter.run(ctx(mixed))).toEqual([]);
    expect(frontmatter.run(ctx([...folder(5, { owner: 'ana', confidential: 'team' }), note('specs/README.md', '# Read me'), note('specs/z.md', `${fm({ owner: 'bo' })}# Z`)]))).toEqual([]);
  });
});

describe('oversized notes', () => {
  it('flags a note over the vault’s own limit and never under the floor', () => {
    const big = note('notes/huge.md', `# Huge\n## One\n${'a'.repeat(70000)}\n## Two\nend`);
    const f = oversized.run(ctx([big, ...Array.from({ length: 20 }, (_, i) => note(`notes/n${i}.md`, `# N\n${'b'.repeat(2000)}`))]));
    expect(rels(f)).toEqual(['notes/huge.md']);
    expect(f[0].proposal).toMatch(/Split it into 2 notes/);
    expect(oversized.run(ctx([note('notes/mid.md', 'c'.repeat(oversized.FLOOR - 10))]))).toEqual([]);
  });
  it('leaves dated logs and index notes', () => {
    expect(oversized.run(ctx([note('logs/2026-01-01.md', 'd'.repeat(90000)), note('index.md', 'e'.repeat(90000))]))).toEqual([]);
  });
});

describe('confidential tag versus folder', () => {
  const tags = (list) => list.map(([rel, value]) => ({ rel, value }));
  const home = Array.from({ length: 8 }, (_, i) => [`work/acme/n${i}.md`, 'acme-internal']);
  it('flags a note with a value outside the folders that hold it, from the vault’s own values', () => {
    const f = confidential.run(ctx([], { tags: tags([...home, ['projects/side.md', 'acme-internal'], ['projects/open.md', null]]) }));
    expect(f.map((x) => x.key)).toEqual(['note.confidential-folder:outside:projects/side.md']);
    expect(f[0].evidence[1]).toMatch(/8 notes with that mark are in work\/acme/);
  });
  it('flags an untagged note inside a folder where most notes carry one value', () => {
    const f = confidential.run(ctx([], { tags: tags([...home, ['work/acme/stub.md', null]]) }));
    expect(f.map((x) => x.key)).toEqual(['note.confidential-folder:untagged:work/acme/stub.md']);
  });
  it('leaves explicit off values, rare values and a second folder that holds the value on purpose', () => {
    const second = Array.from({ length: 4 }, (_, i) => [`projects/ledger/l${i}.md`, 'acme-internal']);
    const list = [...home, ...second, ['projects/a.md', 'false'], ['projects/b.md', 'none'], ['work/acme/off.md', 'no'], ['x/rare.md', 'oddball']];
    expect(confidential.run(ctx([], { tags: tags(list) }))).toEqual([]);
  });
  it('falls back to the notes in the index when no tag list is given', () => {
    const notes = Array.from({ length: 6 }, (_, i) => note(`team/t${i}.md`, `${fm({ confidential: 'team-only' })}# T`));
    expect(rels(confidential.run(ctx([...notes, note('team/new.md', '# New')])))).toEqual(['team/new.md']);
  });
});

describe('secrets', () => {
  const token = 'ghp_' + 'a1B2c3D4'.repeat(5);
  const setting = 'API_KEY=' + 'Zq8x' + 'Lm3Pw9Rt7Vb2Nc6Hj4Kd1Fg5';
  it('names the line and the kind, never the value', () => {
    const [f] = secrets.run(ctx([note('notes/setup.md', `# Setup\nplain line\n${token}\n${setting}`)]));
    expect(f.evidence).toEqual(['Line 3: GitHub token', 'Line 4: Password or key in a setting']);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(JSON.stringify(f)).not.toContain('Lm3Pw9');
  });
  it('skips placeholders and low-entropy values', () => {
    expect(secrets.secretKind('API_KEY=your-api-key-goes-here-123')).toBeNull();
    expect(secrets.secretKind('token: xxxxxxxxxxxxxxxxxxxxxxxx')).toBeNull();
    expect(secrets.secretKind('password = aaaaaaaaaaaaaaaaaaaa1')).toBeNull();
    expect(secrets.entropy('abababab')).toBe(1);
  });
});

describe('stale notes', () => {
  it('flags an open status with no update in 90 days, a past due date, and an old last_verified', () => {
    const notes = [
      note('p/plan.md', `${fm({ status: 'planned', updated: '2026-04-01' })}# Plan`),
      note('p/due.md', `${fm({ status: 'in progress', updated: '2026-11-10', due: '2026-10-01' })}# Due`),
      note('k/fact.md', `${fm({ last_verified: '2026-01-01' })}# Fact`),
    ];
    const f = stale.run(ctx(notes));
    expect(rels(f)).toEqual(['p/plan.md', 'p/due.md', 'k/fact.md']);
    expect(f[1].evidence).toEqual(['Due 2026-10-01, and the status is still “in progress”']);
  });
  it('leaves active and done notes, and a recent update', () => {
    const notes = [
      note('p/evergreen.md', `${fm({ status: 'active', updated: '2026-01-01' })}# Evergreen`),
      note('p/shipped.md', `${fm({ status: 'done', updated: '2026-01-01', due: '2026-02-01' })}# Shipped`),
      note('p/fresh.md', `${fm({ status: 'draft', updated: '2026-11-01' })}# Fresh`),
    ];
    expect(stale.run(ctx(notes))).toEqual([]);
  });
  it('uses the folder’s verify_every as the interval', () => {
    const notes = [1, 2].map((i) => note(`k/f${i}.md`, `${fm({ verify_every: 400, last_verified: '2026-01-01' })}# F`));
    expect(stale.run(ctx(notes))).toEqual([]);
  });
});
