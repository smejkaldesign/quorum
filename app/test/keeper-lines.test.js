// Quorum writes into the vault only the files it owns (issue 196, section 3): the keeper lines rule and its movefacts
// step, and a vault in git that stays clean after a keeper run and after a batch fix
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseNote } from '../linkparse.js';
import { runRules } from '../rules/index.js';
import * as keeperLines from '../rules/keeperLines.js';
import { findingItem, itemLine } from '../reviewItems.js';
import { buildPlan } from '../batchPlan.js';
import { runSetupOp } from '../memorySetup.js';
import { sha } from '../fixUndo.js';
import { LEARNED_HEADER, LEARNED_OPEN, createKeeper, learnedLines } from '../keeper.js';
import { moveFacts } from '../cli/learned.mjs';
import { plan as starterPlan, writeStarter } from '../starter.js';

const put = (dir, rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
const text = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const block = (...lines) => `${LEARNED_OPEN}\n## Learned from meetings\n\n${lines.join('\n')}\n<!-- /quorum:learned -->`;
const FACTS = 'Quorum/learned-facts.md';
const CLAUDE = `# My rules\n\nShip small.\n\n${block('- Ada owns the launch page ([[2026-11-01-plan]], 2026-11-01)', '- Bo owns pricing ([[2026-11-02-sync]], 2026-11-02)')}\n\n## Later\n\nMore of my rules.\n`;
const notesOf = (dir, rels) => rels.filter((rel) => existsSync(path.join(dir, rel))).map((rel) => { const t = text(dir, rel); return { rel, text: t, note: parseNote(rel, t), mtime: 0, size: t.length }; });
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
const gitVault = (dir) => {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'vault@example.com');
  git(dir, 'config', 'user.name', 'Vault Owner');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'vault');
};
const porcelain = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
// one batch step at a time, the way main.js runBatch hands a finding's setup ops to runSetupOp
const runFix = async (dir, findings) => {
  const items = findings.map(findingItem).map((i) => ({ ...i, hashes: Object.fromEntries(i.notes.filter((r) => existsSync(path.join(dir, r))).map((r) => [r, sha(text(dir, r))])) }));
  const plan = buildPlan(items);
  const kept = [];
  for (const s of plan.steps) await runSetupOp(items.find((i) => i.id === s.item), s.op, { step: async () => {}, keep: (rel) => kept.push(rel), vault: dir }, { vindex: { sync: () => {}, rels: () => [] }, trash: async () => {} });
  return { plan, kept };
};

describe('moveFacts', () => {
  it('adds only the lines the facts file lacks, newest last, and takes out only the block', () => {
    const facts = `${LEARNED_HEADER}\n${block('- bo owns pricing.')}\n`;
    const m = moveFacts(CLAUDE, facts);
    expect(m.moved).toBe(1);
    expect(learnedLines(m.to)).toEqual(['- bo owns pricing.', '- Ada owns the launch page ([[2026-11-01-plan]], 2026-11-01)']);
    expect(m.from).toBe('# My rules\n\nShip small.\n\n## Later\n\nMore of my rules.\n');
    // a new facts file starts with its header; a pointer block with no lines moves nothing
    expect(moveFacts(CLAUDE, null).to.startsWith(LEARNED_HEADER)).toBe(true);
    expect(moveFacts(`# R\n\n${block('Quorum keeps facts elsewhere.')}\n`, null)).toEqual({ to: null, from: '# R\n', moved: 0 });
  });
});

describe('the keeper lines rule', () => {
  it('finds a block in a file the person made, and none in Quorum\'s own files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-rule-'));
    put(dir, 'CLAUDE.md', CLAUDE);
    put(dir, 'AGENTS.md', '# Agents\n');
    put(dir, FACTS, `${LEARNED_HEADER}\n${block('- x is y today')}\n`);
    put(dir, '05-knowledge/quorum-learned.md', `${LEARNED_HEADER}\n${block('- an old Quorum note')}\n`);
    const notes = notesOf(dir, ['CLAUDE.md', 'AGENTS.md', FACTS, '05-knowledge/quorum-learned.md']);
    const { findings } = runRules({ notes, resolve: () => null, tags: [], learned: FACTS }, { rules: [keeperLines] });
    expect(findings.map((f) => f.target)).toEqual(['CLAUDE.md']);
    const f = findings[0];
    expect(f.evidence).toEqual(['Ada owns the launch page ([[2026-11-01-plan]], 2026-11-01)', 'Bo owns pricing ([[2026-11-02-sync]], 2026-11-02)']);
    expect(f.fix.ops).toEqual([{ op: 'movefacts', rel: 'CLAUDE.md', to: FACTS }]);
    expect(f.autoFix).toBe(false);
    expect(itemLine(findingItem(f))).toBe(`Move the learned facts in “CLAUDE.md” into “${FACTS}”`);
  });
  it('offers no fix while a note of the person\'s sits where the facts file goes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-blocked-'));
    put(dir, 'CLAUDE.md', CLAUDE);
    put(dir, FACTS, '# My own facts\n');
    const { findings } = runRules({ notes: notesOf(dir, ['CLAUDE.md', FACTS]), resolve: () => null, tags: [], learned: FACTS }, { rules: [keeperLines] });
    expect(findings).toHaveLength(1);
    expect(findings[0].fix).toBeUndefined();
    expect(findings[0].proposal).toContain('Pick another Quorum folder');
  });
  it('moves the facts on Approve, keeps a version of both files, and leaves the rest of CLAUDE.md as it was', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-fix-'));
    put(dir, 'CLAUDE.md', CLAUDE);
    put(dir, 'AGENTS.md', `# Agents\n\n${block('- Bo owns pricing ([[2026-11-02-sync]], 2026-11-02)', '- Cy runs support ([[2026-11-03-x]], 2026-11-03)')}\n`);
    const { findings } = runRules({ notes: notesOf(dir, ['CLAUDE.md', 'AGENTS.md']), resolve: () => null, tags: [], learned: FACTS }, { rules: [keeperLines] });
    const { plan, kept } = await runFix(dir, findings);
    // two files of the person's move into one facts file in one batch, without holding either back
    expect(plan.held).toEqual([]);
    expect(text(dir, 'CLAUDE.md')).toBe('# My rules\n\nShip small.\n\n## Later\n\nMore of my rules.\n');
    expect(text(dir, 'AGENTS.md')).toBe('# Agents\n');
    expect(learnedLines(text(dir, FACTS))).toEqual(['- Ada owns the launch page ([[2026-11-01-plan]], 2026-11-01)', '- Bo owns pricing ([[2026-11-02-sync]], 2026-11-02)', '- Cy runs support ([[2026-11-03-x]], 2026-11-03)']);
    expect([...new Set(kept)].sort()).toEqual(['AGENTS.md', 'CLAUDE.md', FACTS]);
  });
  it('writes nothing when the file changed after the plan, or the facts file is the person\'s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-stale-'));
    put(dir, 'CLAUDE.md', CLAUDE);
    const { findings } = runRules({ notes: notesOf(dir, ['CLAUDE.md']), resolve: () => null, tags: [], learned: FACTS }, { rules: [keeperLines] });
    const item = { ...findingItem(findings[0]), hashes: { 'CLAUDE.md': sha(CLAUDE) } };
    put(dir, 'CLAUDE.md', `${CLAUDE}\nA line written since.\n`);
    const args = [item, item.ops[0], { step: async () => {}, keep: () => {}, vault: dir }, { vindex: { sync: () => {}, rels: () => [] }, trash: async () => {} }];
    await expect(runSetupOp(...args)).rejects.toThrow(/changed after Quorum checked it/);
    put(dir, 'CLAUDE.md', CLAUDE);
    put(dir, FACTS, '# My own facts\n');
    await expect(runSetupOp(...args)).rejects.toThrow(/is a note of yours/);
    expect(text(dir, 'CLAUDE.md')).toBe(CLAUDE);
    expect(text(dir, FACTS)).toBe('# My own facts\n');
  });
});

describe('a vault in git', () => {
  const NOTE = (title, date) => `---\ntitle: ${title}\ndate: ${date}T15:00:00-08:00\nparticipants:\n  - Ada Lovelace\nsource: quorum\n---\n\n# ${title}\n\nAda owns the launch page for Launch.\n`;
  it('stays clean after a keeper run with nothing new, and Quorum writes only its own files on the first one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-git-'));
    writeStarter(dir, starterPlan({ name: 'Studio', answers: { people: ['Ada Lovelace'], projects: ['Launch'] } }));
    const meetings = starterPlan({ name: 'Studio', answers: {} }).meetings;
    put(dir, `${meetings}/2026-11-10-plan.md`, NOTE('Plan', '2026-11-10'));
    gitVault(dir);
    const claude = text(dir, 'CLAUDE.md');
    const k = createKeeper({ brain: () => ({ root: dir, vault: dir }), dataDir: mkdtempSync(path.join(tmpdir(), 'kl-data-')), settings: { brainMade: 'quorum' }, hasModel: () => true, runText: async () => '- Ada owns the launch page', owner: () => 'Rick Bot' });
    expect((await k.run()).filed).toBe(1);
    const changed = porcelain(dir).map((l) => l.slice(3));
    expect(changed).toContain(FACTS);
    expect(changed.filter((rel) => rel.startsWith('.quorum/') || rel === 'CLAUDE.md' || rel === 'AGENTS.md')).toEqual([]);
    expect(text(dir, 'CLAUDE.md')).toBe(claude);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'filed');
    // a second run and a third, with nothing new: no state file, changelog or log shows up in git
    await k.run();
    await k.run({ allowCreate: true });
    expect(porcelain(dir)).toEqual([]);
  });
  it('shows only the files a batch fix changed, with no plan or journal in the vault', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kl-git-fix-'));
    put(dir, 'CLAUDE.md', CLAUDE);
    put(dir, 'notes/a.md', '# A\n');
    gitVault(dir);
    const { findings } = runRules({ notes: notesOf(dir, ['CLAUDE.md', 'notes/a.md']), resolve: () => null, tags: [], learned: FACTS }, { rules: [keeperLines] });
    await runFix(dir, findings);
    expect(porcelain(dir).sort()).toEqual([' M CLAUDE.md', `?? ${FACTS}`]);
  });
});
