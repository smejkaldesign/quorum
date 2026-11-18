// A save sweep of the contradiction rule pairs again only the subjects its notes touch (rules/contradictions.js). Its
// findings on those notes must be the ones a pass over the whole vault finds on them, on a generated vault
// (test/fixtures/sweepVault.js) and after edits, renames and deletions, with and without the agent's stored claims.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVaultIndex } from '../vindex.js';
import * as contradictions from '../rules/contradictions.js';
import { mergeFindings, runRules } from '../rules/index.js';
import { checkClaims } from '../contradictionClaims.js';
import { hashText } from '../contradictionIndex.js';
import { createContradictionAgent } from '../contradictionAgent.js';
import { writeSweepVault } from './fixtures/sweepVault.js';

function vaultOf() {
  const root = mkdtempSync(path.join(tmpdir(), 'contra-inc-'));
  const vault = path.join(root, 'v');
  const { logs } = writeSweepVault(vault, { notes: 500, logBytes: 3000 });
  const ix = createVaultIndex({ vault, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
  ix.sync();
  const ctx = (extra = {}) => ({ notes: ix.snapshot(), resolve: (t, f) => ix.resolve(t, f), tags: [], ...extra });
  const edit = (rel, fn) => { const abs = path.join(vault, rel); writeFileSync(abs, fn(readFileSync(abs, 'utf8'))); ix.syncPaths([rel]); };
  const remove = (rel) => { rmSync(path.join(vault, rel)); ix.syncPaths([rel]); };
  return { root, vault, logs, ix, ctx, edit, remove };
}
const on = (findings, only) => findings.filter((f) => f.notes.some((rel) => only.includes(rel)));
// the findings on these notes from a save sweep, and from a pass over the whole vault
const { run } = contradictions;
const both = (ctx, only) => ({ inc: on(run({ ...ctx, only }), only), full: on(run(ctx), only) });

describe('a save sweep of the contradiction rule', () => {
  it('finds on the notes it checks what a pass over the whole vault finds on them', () => {
    const v = vaultOf();
    try {
      const sets = [['projects/p5.md'], [v.logs[0]], [v.logs[3], 'projects/p0.md'], ['knowledge/k3.md'], ['decisions/2026-08-14-p0.md'], ['meetings/2026-01-01-sync-0.md'], ['gone/never.md']];
      let total = 0;
      for (const only of sets) {
        const { inc, full } = both(v.ctx(), only);
        expect(inc, only.join(', ')).toEqual(full);
        total += full.length;
      }
      expect(total).toBeGreaterThan(20);
      // a value changed, a title changed (the subject index moves), a note gone, a new note on a busy subject
      v.edit('projects/p5.md', (t) => t.replace(/^status: .*$/m, 'status: archived'));
      expect(both(v.ctx(), ['projects/p5.md']).inc).toEqual(both(v.ctx(), ['projects/p5.md']).full);
      v.edit('projects/p6.md', (t) => t.replace('# Project P6', '# Project Six'));
      for (const only of [['projects/p6.md'], [v.logs[1]]]) { const r = both(v.ctx(), only); expect(r.inc).toEqual(r.full); }
      v.remove(v.logs[2]);
      { const r = both(v.ctx(), [v.logs[2], 'projects/p0.md']); expect(r.inc).toEqual(r.full); }
      writeFileSync(path.join(v.vault, 'meetings/new.md'), '---\ndate: 2026-11-30\n---\n# New\n\n- [[p0]] status: paused\n- [[p0]] owner: Team Gold\n');
      v.ix.syncPaths(['meetings/new.md']);
      { const r = both(v.ctx(), ['meetings/new.md']); expect(r.inc).toEqual(r.full); expect(r.full.length).toBeGreaterThan(0); }
    } finally { rmSync(v.root, { recursive: true, force: true }); }
  });

  it('keeps the agent queue a pass over the whole vault would make, with stored model claims', () => {
    const v = vaultOf();
    try {
      // the agent's claims for the meeting notes, as a model call would have stored them
      const file = path.join(v.root, 'agent.json');
      const claims = {};
      for (const n of v.ix.snapshot().filter((x) => x.rel.startsWith('meetings/')).slice(0, 60)) {
        const lines = n.text.split('\n');
        const i = lines.findIndex((l) => / owner: /.test(l));
        const m = lines[i].match(/\[\[p(\d+)\]\] owner: (.+)$/);
        // two claims on one line: the project's owner, and what the team owns (a second subject on the same line)
        const got = checkClaims(n, [
          { line: i + 1, subject: `Project P${m[1]}`, attribute: 'owner', value: m[2], quote: lines[i], polarity: '+', modality: 'stated' },
          { line: i + 1, subject: m[2], attribute: 'owns', value: `p${m[1]}`, quote: lines[i], polarity: '+', modality: 'stated' },
        ]);
        expect(got.claims).toHaveLength(2);
        claims[n.rel] = { hash: hashText(n.text), claims: got.claims };
      }
      writeFileSync(file, JSON.stringify({ claims, judged: {}, failed: {} }));
      const agentOf = () => createContradictionAgent({ file, model: async () => { throw new Error('no model'); }, enabled: () => true });
      const a = agentOf();
      const b = agentOf();
      const ctxA = (extra) => v.ctx({ contradictions: { provider: a.provider }, ...extra });
      const ctxB = (extra) => v.ctx({ contradictions: { provider: b.provider }, ...extra });
      run(ctxA());
      run(ctxB());
      expect(a.provider.pending().judge).toBeGreaterThan(5);
      for (const only of [['projects/p7.md'], ['meetings/2026-02-02-sync-1.md'], ['projects/p14.md', 'knowledge/k1.md']]) {
        for (const rel of only) v.edit(rel, (t) => t.replace(/^owner: .*$/m, 'owner: Team Violet').replace(/owner: Team \w+$/m, 'owner: Team Violet'));
        const inc = on(run(ctxA({ only })), only);
        const full = on(run(ctxB()), only);
        expect(inc, only.join(', ')).toEqual(full);
        expect(a.provider.pending(), only.join(', ')).toEqual(b.provider.pending());
      }
    } finally { rmSync(v.root, { recursive: true, force: true }); }
  });

  // what memorySweep.js keeps after a save sweep: the findings it held, merged with the sweep's, against a full pass
  describe('the findings held after a save sweep', () => {
    const small = () => {
      const root = mkdtempSync(path.join(tmpdir(), 'contra-names-'));
      const put = (rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
      put('meetings/2026-01-05-a.md', '---\ndate: 2026-01-05\n---\n# A\n\n- [[Atlas Platform]] status: active\n');
      put('meetings/2026-03-05-b.md', '---\ndate: 2026-03-05\n---\n# B\n\n- [[Orion]] status: paused\n');
      put('meetings/2026-04-05-c.md', '---\ndate: 2026-04-05\n---\n# C\n\n- [[Atlas Platform]] owner: Team Red\n- [[Vega]] owner: Team Blue\n');
      put('projects/atlas.md', '---\naliases: [Orion]\n---\n# Atlas Platform\n\nSome text about the platform.\n');
      put('projects/vega.md', '# Vega\n\nSome text about Vega.\n');
      const ix = createVaultIndex({ vault: root, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: () => {} });
      ix.sync();
      const ctx = () => ({ notes: ix.snapshot(), resolve: (t, f) => ix.resolve(t, f), tags: [] });
      const rules = [contradictions];
      let held = runRules(ctx(), { rules }).findings;
      // a save sweep of these notes, merged as memorySweep.js merges it; answers it with a full pass and the rules run wide
      const save = (only) => {
        const live = new Set(ctx().notes.map((n) => n.rel));
        const r = runRules(ctx(), { only, rules });
        held = mergeFindings(held.filter((f) => f.notes.every((rel) => live.has(rel))), r.findings, only, r.whole);
        return { held: held.map((f) => f.key).sort(), full: runRules(ctx(), { rules }).findings.map((f) => f.key).sort(), whole: r.whole };
      };
      return { root, put, ix, save, sync: (rels) => ix.syncPaths(rels) };
    };
    const check = (r) => { expect(r.held).toEqual(r.full); };

    it('matches a full pass when an alias goes, comes back, a title changes, a note is deleted or renamed', () => {
      const v = small();
      try {
        v.put('projects/atlas.md', '# Atlas Platform\n\nSome text about the platform.\n'); v.sync(['projects/atlas.md']);
        check(v.save(['projects/atlas.md']));
        v.put('projects/atlas.md', '---\naliases: [Orion]\n---\n# Atlas Platform\n\nSome text about the platform.\n'); v.sync(['projects/atlas.md']);
        const added = v.save(['projects/atlas.md']);
        check(added);
        expect(added.full.length).toBeGreaterThan(0);
        expect(added.whole).toEqual(['note.contradiction']);
        v.put('projects/vega.md', '---\naliases: [Atlas Platform]\n---\n# Vega Platform\n\nSome text about Vega.\n'); v.sync(['projects/vega.md']);
        check(v.save(['projects/vega.md']));
        rmSync(path.join(v.root, 'projects/atlas.md')); v.sync(['projects/atlas.md']);
        check(v.save(['projects/atlas.md']));
        renameSync(path.join(v.root, 'projects/vega.md'), path.join(v.root, 'projects/vega-two.md')); v.sync(['projects/vega.md', 'projects/vega-two.md']);
        check(v.save(['projects/vega.md', 'projects/vega-two.md']));
        // a value change leaves every name as it was: the sweep stays on the notes it checks
        v.put('meetings/2026-04-05-c.md', '---\ndate: 2026-04-05\n---\n# C\n\n- [[Atlas Platform]] owner: Team Gold\n- [[Vega]] owner: Team Blue\n'); v.sync(['meetings/2026-04-05-c.md']);
        const value = v.save(['meetings/2026-04-05-c.md']);
        check(value);
        expect(value.whole).toEqual([]);
      } finally { rmSync(v.root, { recursive: true, force: true }); }
    });
  });
});
