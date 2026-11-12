import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN, ENFORCEMENT, classifyHook, claudeMdRules, compile, createGuardrails, discover, discoverConventions, discoverQuick, effective, frontmatterKeys, frontmatterPairs, obsidianExcluded, scopeOf, wouldBlock } from '../guardrails.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'guardrails-vault');

const vault = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'guardrails-'));
  mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
  mkdirSync(path.join(root, 'scripts/embed-bench'), { recursive: true });
  mkdirSync(path.join(root, '02-personal'), { recursive: true });
  writeFileSync(path.join(root, '.claude/hooks/opted-out-guard.py'), '#!/usr/bin/env python3\n"""Denies reads of notes naming a customer who opted out of AI."""\n');
  writeFileSync(path.join(root, '.claude/hooks/secret-guard.py'), '#!/usr/bin/env python3\n"""Blocks Bash commands that would print secrets."""\n');
  writeFileSync(path.join(root, '.claude/hooks/vault-reindex.sh'), '#!/bin/zsh\n# Reindexes the memory database after a write.\n');
  writeFileSync(path.join(root, '.claude/hooks/audit-logger.py'), '# Logs every tool call for the session audit.\n');
  writeFileSync(path.join(root, '.claude/hooks/output-secret-tripwire.py'), '"""Tripwire: fails a read whose output contains a key-like string, and logs it to the session."""\n');
  writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [{ type: 'command', command: 'python3 .claude/hooks/opted-out-guard.py' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 .claude/hooks/secret-guard.py' }] }],
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'zsh .claude/hooks/vault-reindex.sh' }] }, { matcher: 'Read|Grep', hooks: [{ type: 'command', command: 'python3 .claude/hooks/output-secret-tripwire.py' }] }],
  } }));
  writeFileSync(path.join(root, 'scripts/embed-bench/excluded.txt'), '# opted out\nnorthwind\nContoso Ltd\n');
  writeFileSync(path.join(root, 'plan.md'), '---\ntitle: Plan\nconfidential: personal\n---\n# Plan\n');
  writeFileSync(path.join(root, 'roadmap.md'), '---\ntitle: Roadmap\nvisibility: internal\n---\n# Roadmap\n');
  return root;
};

describe('classifyHook', () => {
  it('keeps read guards and output tripwires, drops Bash guards and everything that is not a guard', () => {
    expect(classifyHook({ name: 'opted-out-guard.py', text: '"""Denies reads of notes naming a customer who opted out."""', events: [{ event: 'PreToolUse', matcher: 'Read|Grep|Glob' }] })).toMatchObject({ relevant: true, mixed: false, stage: 'pre' });
    expect(classifyHook({ name: 'secret-guard.py', text: '"""Blocks Bash commands that would print secrets."""', events: [{ event: 'PreToolUse', matcher: 'Bash' }] })).toMatchObject({ relevant: false, reason: expect.stringContaining('Bash') });
    expect(classifyHook({ name: 'vault-reindex.sh', text: '# Reindexes the memory database.' })).toMatchObject({ relevant: false });
    expect(classifyHook({ name: 'turn-capture.py', text: '# Captures the turn into the session log.' }).relevant).toBe(false);
    const mixed = classifyHook({ name: 'output-secret-tripwire.py', text: '"""Tripwire: fails a read whose output contains a key-like string, and logs it to the session."""', events: [{ event: 'PostToolUse', matcher: 'Read|Grep' }] });
    expect(mixed).toMatchObject({ relevant: true, mixed: true, stage: 'post' });
    // an unwired guard file is still offered: the person decides
    expect(classifyHook({ name: 'confidential-guard.py', text: '# denies confidential notes' }).relevant).toBe(true);
  });
});

describe('discover', () => {
  it('offers the two relevant hooks, the opt-out list and the one marker key, and names what it skipped and why', async () => {
    const root = vault();
    const q = discoverQuick(root);
    expect(q.candidates.map((c) => c.id)).toEqual(['agent-os:hook:opted-out-guard.py', 'agent-os:hook:output-secret-tripwire.py', 'agent-os:terms:scripts/embed-bench/excluded.txt']);
    const d = await discover(root);
    expect(d.candidates.map((c) => c.id)).toEqual([...q.candidates.map((c) => c.id), 'agent-os:frontmatter:visibility']);
    expect(d.candidates[0]).toMatchObject({ kind: 'hook', origin: 'hook', wired: true, stage: 'pre', mixed: false });
    expect(d.candidates[2]).toMatchObject({ kind: 'term', origin: 'terms', what: expect.stringContaining('2 names') });
    // confidential: is the built-in rule, so plan.md adds nothing; roadmap.md's visibility: internal is offered
    expect(d.candidates[3]).toMatchObject({ kind: 'frontmatter', origin: 'frontmatter', value: 'visibility', count: 1, what: expect.stringContaining('1 note carries visibility:') });
    expect(d).toMatchObject({ notes: 2, truncated: false });
    expect(d.skipped.map((s) => s.name).sort()).toEqual(['audit-logger.py', 'secret-guard.py', 'vault-reindex.sh']);
    expect(d.skipped.find((s) => s.name === 'secret-guard.py').reason).toContain('Bash');
  });
});

describe('the conventions a vault follows', () => {
  it('reads frontmatter keys and values from the head of a note only', () => {
    expect(frontmatterKeys('---\ntitle: X\nConfidential: team\nnda: true\n---\n# X\nsecret: later\n')).toEqual(['title', 'confidential', 'nda']);
    expect(frontmatterPairs('---\nVisibility: "Public"\nshare: true\n---\n')).toEqual([{ key: 'visibility', value: 'public' }, { key: 'share', value: 'true' }]);
    expect(frontmatterKeys('# no frontmatter\nconfidential: x\n')).toEqual([]);
    // a body line that starts like a key is not a mark
    expect(frontmatterKeys('---\ntitle: X\n---\naccess: see the portal\n')).toEqual(['title']);
  });
  it('turns the sharing rules in a CLAUDE.md into folders and keys, and ignores the rest', () => {
    const rules = claudeMdRules('- Never surface `MyBrain/05-knowledge/clients/northwind/` in any external output.\n- Never put notes tagged `visibility: internal` into a shared workspace.\n- Never share board material outside the leadership group.\n- Use `grep | cut`, never `source .env`.\n- Keep answers short.\n');
    expect(rules).toEqual([
      { line: 'Never surface `MyBrain/05-knowledge/clients/northwind/` in any external output.', folders: ['MyBrain/05-knowledge/clients/northwind'], keys: [] },
      { line: 'Never put notes tagged `visibility: internal` into a shared workspace.', folders: [], keys: ['visibility'] },
      { line: 'Never share board material outside the leadership group.', folders: [], keys: [] },
    ]);
  });
  it('reads the folders Obsidian excludes', () => {
    expect(obsidianExcluded(path.join(FIXTURE, 'MyBrain'))).toEqual(['06-archive', 'templates-missing', '/^tmp/']);
    expect(obsidianExcluded('/nowhere')).toEqual([]);
  });
  it('proposes only rules Quorum can enforce from the fixture vault, with counts, and lists what it left out', async () => {
    const root = FIXTURE; const vaultDir = path.join(FIXTURE, 'MyBrain');
    const d = await discoverConventions(root, vaultDir);
    expect(d).toMatchObject({ notes: 18, truncated: false });
    const ids = d.candidates.map((c) => c.id);
    // CLAUDE.md names a folder and a key; the folder's notes are counted, the key's notes too
    expect(ids).toContain('agent-os:path:MyBrain/05-knowledge/clients/northwind');
    expect(d.candidates.find((c) => c.id === 'agent-os:path:MyBrain/05-knowledge/clients/northwind')).toMatchObject({ kind: 'path', origin: 'claude-md', value: 'MyBrain/05-knowledge/clients/northwind', count: 2, what: expect.stringContaining('Your CLAUDE.md says') });
    expect(d.candidates.find((c) => c.id === 'agent-os:frontmatter:visibility')).toMatchObject({ kind: 'frontmatter', origin: 'claude-md', count: 1 });
    // a key the notes carry that CLAUDE.md never mentions is offered from the notes themselves
    expect(d.candidates.find((c) => c.id === 'agent-os:frontmatter:nda')).toMatchObject({ origin: 'frontmatter', count: 5, what: expect.stringContaining('5 notes carry nda:') });
    // five of six notes in 03-legal are marked, so the whole folder is offered; 02-personal is a built-in private folder and never is
    expect(d.candidates.find((c) => c.id === 'agent-os:path:MyBrain/03-legal')).toMatchObject({ origin: 'frontmatter', count: 6, what: expect.stringContaining('5 of 6 notes') });
    expect(ids.some((i) => i.includes('02-personal'))).toBe(false);
    // confidential: is built in, so it is never offered twice
    expect(ids).not.toContain('agent-os:frontmatter:confidential');
    // 07-posts is five notes of `access: public` and `share: true`: open values never mark a note, so the folder is not
    // offered, and those two keys are named as looked at, never offered as key rules
    expect(ids.some((i) => i.includes('07-posts'))).toBe(false);
    expect(ids).not.toContain('agent-os:frontmatter:access');
    expect(ids).not.toContain('agent-os:frontmatter:share');
    // Obsidian's exclusion of an existing folder is offered; a missing folder and a pattern are named as left out
    expect(d.candidates.find((c) => c.id === 'agent-os:path:MyBrain/06-archive')).toMatchObject({ origin: 'obsidian', count: 1 });
    expect(d.skipped.map((s) => s.name)).toEqual(['CLAUDE.md', 'access:', 'share:', '.obsidian/app.json: templates-missing', '.obsidian/app.json: /^tmp/']);
    expect(d.skipped[0].reason).toContain('1 sharing rule names no folder or frontmatter key');
    expect(d.skipped[1].reason).toContain('open value');
    // every candidate is a kind compile() enforces, and nothing is on until the person includes it
    for (const c of d.candidates) expect(['path', 'frontmatter']).toContain(c.kind);
    const list = effective({}, d);
    expect(list.filter((r) => r.source === 'agent-os').every((r) => r.enabled === false && r.decision === null)).toBe(true);
    const c = compile(effective({ agentOs: { 'agent-os:path:MyBrain/03-legal': 'included', 'agent-os:frontmatter:nda': 'included' } }, d), { root });
    expect(c.denyDirs).toEqual(['MyBrain/03-legal']);
    expect(c.frontmatterKeys).toEqual(['confidential', 'nda']);
    expect(wouldBlock(c, 'MyBrain/03-legal/readme.md')).toBe('MyBrain/03-legal/ is private');
    expect(wouldBlock(c, 'MyBrain/05-knowledge/patterns.md', '---\nnda: true\n---')).toBe('marked nda: in its frontmatter');
  });
  it('runs the whole discovery on the fixture through the app handle, scanning once and keeping the result', async () => {
    const settings = {};
    let saves = 0;
    const g = createGuardrails({ settings, saveSettings: () => { saves += 1; }, brain: () => ({ root: FIXTURE, vault: path.join(FIXTURE, 'MyBrain') }) });
    // before any scan, the hot path sees the quick look only and never walks the vault
    expect(g.rules().filter((r) => r.source === 'agent-os').map((r) => r.id)).toEqual(['agent-os:hook:opted-out-guard.py', 'agent-os:terms:scripts/opt-outs.txt']);
    expect(settings.guardrails.conventions).toBeUndefined();
    const st = await g.get();
    expect(st.rules.filter((r) => r.source === 'agent-os').map((r) => r.id)).toEqual([
      'agent-os:hook:opted-out-guard.py', 'agent-os:terms:scripts/opt-outs.txt',
      'agent-os:path:MyBrain/05-knowledge/clients/northwind', 'agent-os:frontmatter:visibility', 'agent-os:frontmatter:nda', 'agent-os:path:MyBrain/03-legal', 'agent-os:path:MyBrain/06-archive',
    ]);
    expect(st.scanned).toMatchObject({ notes: 18, truncated: false });
    expect(st.summary.toReview).toBe(7);
    expect(st.skipped.map((s) => s.name)).toContain('session-start.sh');
    // the scan result is kept in settings, so the next read is served from it
    expect(settings.guardrails.conventions).toMatchObject({ root: FIXTURE, notes: 18 });
    const before = saves;
    await g.get();
    expect(saves).toBe(before);
    for (const r of st.rules) expect(r.reach).toBe(ENFORCEMENT[r.kind]);
  });
  it('keeps an included Agent OS rule enforcing after discovery stops offering it, until the person leaves it out', async () => {
    const root = vault();
    const settings = {};
    const g = createGuardrails({ settings, brain: () => ({ root, vault: root }) });
    await g.get();
    expect(g.set('agent-os:frontmatter:visibility', { enabled: true })).toEqual({ ok: true });
    expect(settings.guardrails.agentOs['agent-os:frontmatter:visibility']).toMatchObject({ decision: 'included', kind: 'frontmatter', value: 'visibility' });
    expect(g.compiled().frontmatterKeys).toEqual(['confidential', 'visibility']);
    // the note that carried the key is gone; a fresh scan no longer proposes it, and the rule stays on and is marked
    rmSync(path.join(root, 'roadmap.md'));
    const st = await g.get({ fresh: true });
    const r = st.rules.find((x) => x.id === 'agent-os:frontmatter:visibility');
    expect(r).toMatchObject({ enabled: true, stale: true, decision: 'included', kind: 'frontmatter' });
    expect(g.compiled().frontmatterKeys).toEqual(['confidential', 'visibility']);
    // leaving it out removes it; an older install's bare word is still read
    expect(g.set('agent-os:frontmatter:visibility', { enabled: false })).toEqual({ ok: true });
    expect(g.rules().find((x) => x.id === 'agent-os:frontmatter:visibility')).toBeUndefined();
    expect(effective({ agentOs: { 'agent-os:terms:x': 'included' } }, { candidates: [{ id: 'agent-os:terms:x', kind: 'term', value: '@/tmp/x', label: 'x' }] }).find((x) => x.id === 'agent-os:terms:x')).toMatchObject({ enabled: true, decision: 'included' });
  });
});

describe('scope', () => {
  it('marks built-in, Agent OS and personal rules individual and workspace rules organization', () => {
    const list = effective({ rules: [{ id: 'p', kind: 'term', value: 'x-ray', enabled: true }], workspace: [{ id: 'ws:1', kind: 'term', value: 'falcon', enabled: true }] }, { candidates: [{ id: 'agent-os:frontmatter:nda', kind: 'frontmatter', value: 'nda', label: 'nda' }] });
    expect(list.filter((r) => r.scope === 'individual').map((r) => r.source)).toEqual([...BUILT_IN.map(() => 'built-in'), 'agent-os', 'personal']);
    expect(list.filter((r) => r.scope === 'organization')).toMatchObject([{ id: 'ws:1', locked: true }]);
    expect(scopeOf('workspace')).toBe('organization');
    expect(scopeOf('personal')).toBe('individual');
  });
});

describe('effective and compile', () => {
  it('turns built-ins, included Agent OS items, personal rules and locked workspace rules into one deny set', async () => {
    const root = vault();
    const d = await discover(root);
    const state = { builtIns: { 'built-in:secrets': false }, agentOs: { 'agent-os:terms:scripts/embed-bench/excluded.txt': 'included', 'agent-os:hook:opted-out-guard.py': 'excluded' }, rules: [{ id: 'personal:1', kind: 'path', value: 'clients/acme, drafts/', label: 'Acme', enabled: true }, { id: 'personal:2', kind: 'frontmatter', value: 'visibility', enabled: true }], workspace: [{ id: 'ws:1', kind: 'term', value: 'Project Falcon, hq', enabled: true }] };
    const list = effective(state, d);
    expect(list.filter((r) => r.source === 'built-in')).toHaveLength(BUILT_IN.length);
    expect(list.find((r) => r.id === 'built-in:secrets').enabled).toBe(false);
    expect(list.find((r) => r.id === 'agent-os:hook:opted-out-guard.py')).toMatchObject({ enabled: false, decision: 'excluded' });
    expect(list.find((r) => r.id === 'agent-os:hook:output-secret-tripwire.py')).toMatchObject({ enabled: false, decision: null });
    expect(list.find((r) => r.id === 'ws:1')).toMatchObject({ source: 'workspace', locked: true, enabled: true });
    const c = compile(list, { root, privateDirs: () => ['02-personal'] });
    expect(c.denyDirs).toEqual(['02-personal', 'clients/acme', 'drafts']);
    expect(c.frontmatterKeys).toEqual(['confidential', 'visibility']);
    expect(c.secretsOff).toBe(true);
    expect(c.terms).toEqual(['project falcon']);
    expect(c.termFiles).toEqual([path.join(root, 'scripts/embed-bench/excluded.txt')]);
    expect(c.allTerms()).toEqual(['project falcon', 'northwind', 'contoso ltd']);
    expect(c.hooks).toEqual([]);
    expect(wouldBlock(c, 'clients/acme/notes.md')).toBe('clients/acme/ is private');
    expect(wouldBlock(c, '02-personal/money.md')).toBe('02-personal/ is private');
    expect(wouldBlock(c, '.env')).toBeNull(); // secrets rule is off in this state
    expect(wouldBlock(c, 'roadmap.md', '---\nvisibility: internal\n---\n')).toBe('marked visibility: in its frontmatter');
    expect(wouldBlock(c, 'notes/plain.md', '# plain')).toBeNull();
  });
  it('keeps the secrets rule on by default and lets a personal pattern extend it', () => {
    const c = compile(effective({ rules: [{ id: 'p', kind: 'secret', value: String.raw`\.sqlite$`, enabled: true }] }, { candidates: [] }));
    expect(c.secretsOff).toBe(false);
    expect(wouldBlock(c, 'config/.env.local')).toBe('looks like a secret or credential');
    expect(wouldBlock(c, 'memory/brain.sqlite')).toBe('looks like a secret or credential');
  });
});

describe('createGuardrails', () => {
  it('keeps an existing install\'s opt-out list, reviews the rest, and persists a snapshot for the CLI', async () => {
    const root = vault();
    const settings = { memory: { items: [] } };
    let saves = 0;
    const g = createGuardrails({ settings, saveSettings: () => { saves += 1; }, brain: () => ({ root, vault: root }), privateDirs: () => ['02-personal'] });
    const st = await g.get();
    expect(st.rules.find((r) => r.id === 'agent-os:terms:scripts/embed-bench/excluded.txt')).toMatchObject({ enabled: true, decision: 'included' });
    expect(st.rules.find((r) => r.id === 'agent-os:hook:opted-out-guard.py')).toMatchObject({ enabled: false, decision: null });
    expect(st.summary).toMatchObject({ toReview: 3, denyDirs: 1, terms: 2 });
    expect(st.skipped).toHaveLength(3);
    expect(settings.guardrails.compiled).toMatchObject({ denyDirs: ['02-personal'], frontmatterKeys: ['confidential'], termFiles: [path.join(root, 'scripts/embed-bench/excluded.txt')] });
    expect(g.set('agent-os:hook:opted-out-guard.py', { enabled: true })).toEqual({ ok: true });
    expect(g.compiled().hooks).toEqual([{ path: path.join(root, '.claude/hooks/opted-out-guard.py'), stage: 'pre' }]);
    expect(g.add({ kind: 'nope', value: 'x' }).error).toBeTruthy();
    expect(g.add({ kind: 'secret', value: '(' }).error).toBeTruthy();
    const added = g.add({ kind: 'path', value: 'clients/acme', label: 'Acme' });
    expect(added.ok).toBe(true);
    expect(g.test('clients/acme/call.md')).toEqual({ blocked: 'clients/acme/ is private' });
    expect(g.test('plan.md')).toEqual({ blocked: 'marked confidential: in its frontmatter' });
    expect(g.test('roadmap.md')).toEqual({ blocked: null });
    expect(g.remove('built-in:secrets').error).toBeTruthy();
    expect(g.remove(added.id)).toEqual({ ok: true });
    expect(saves).toBeGreaterThan(0);
  });
  it('pulls workspace rules through the remote and locks them', async () => {
    const root = vault();
    const settings = {};
    const g = createGuardrails({ settings, brain: () => ({ root, vault: root }) });
    g.setRemote(async () => [{ id: 'ws:1', kind: 'frontmatter', value: 'legal_hold', label: 'Legal hold', enabled: true }]);
    const st = await g.get();
    expect(st.rules.find((r) => r.id === 'ws:1')).toMatchObject({ source: 'workspace', locked: true, enabled: true });
    expect(g.compiled().frontmatterKeys).toEqual(['confidential', 'legal_hold']);
  });
});
