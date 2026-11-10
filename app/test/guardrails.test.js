import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILT_IN, classifyHook, compile, createGuardrails, discover, effective, wouldBlock } from '../guardrails.js';

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
  it('offers the two relevant hooks and the opt-out list, and names what it skipped and why', () => {
    const root = vault();
    const d = discover(root);
    expect(d.candidates.map((c) => c.id)).toEqual(['agent-os:hook:opted-out-guard.py', 'agent-os:hook:output-secret-tripwire.py', 'agent-os:terms:scripts/embed-bench/excluded.txt']);
    expect(d.candidates[0]).toMatchObject({ kind: 'hook', wired: true, stage: 'pre', mixed: false });
    expect(d.candidates[2]).toMatchObject({ kind: 'term', what: expect.stringContaining('2 names') });
    expect(d.skipped.map((s) => s.name).sort()).toEqual(['audit-logger.py', 'secret-guard.py', 'vault-reindex.sh']);
    expect(d.skipped.find((s) => s.name === 'secret-guard.py').reason).toContain('Bash');
  });
});

describe('effective and compile', () => {
  it('turns built-ins, included Agent OS items, personal rules and locked workspace rules into one deny set', () => {
    const root = vault();
    const d = discover(root);
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
    expect(st.summary).toMatchObject({ toReview: 2, denyDirs: 1, terms: 2 });
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
