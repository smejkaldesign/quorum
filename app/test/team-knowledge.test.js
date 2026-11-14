// Team knowledge: the source an admin sets, where it lands on this Mac, and the read-only index the tab reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cloneDir, createTeamKnowledge, shapeSource, sourceRoot, validateSource } from '../ee/teamKnowledge.js';
import { describeSource, teamEnabledOf, teamGate } from '../src/mainTabs.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/team-knowledge', import.meta.url));

describe('the knowledge source an admin sets', () => {
  it('accepts the three kinds and refuses anything a shell could read', () => {
    expect(validateSource({ kind: 'sync' })).toEqual({ source: { kind: 'sync', url: null, path: null } });
    expect(validateSource({ kind: 'git', url: ' https://github.com/example/knowledge.git ' })).toEqual({ source: { kind: 'git', url: 'https://github.com/example/knowledge.git', path: null } });
    expect(validateSource({ kind: 'git', url: 'git@example.com:team/knowledge.git' }).source.kind).toBe('git');
    expect(validateSource({ kind: 'git', url: '' }).error).toMatch(/address/);
    expect(validateSource({ kind: 'git', url: 'https://example.com/x; rm -rf ~' }).error).toMatch(/https/);
    expect(validateSource({ kind: 'git', url: '/tmp/me/notes' }).error).toMatch(/https/);
    expect(validateSource({ kind: 'folder', path: '/Volumes/Shared/Knowledge' }).source.path).toBe('/Volumes/Shared/Knowledge');
    expect(validateSource({ kind: 'folder', path: 'relative/notes' }).error).toMatch(/full path/);
    expect(validateSource({ kind: 'folder', path: '/tmp/me/../etc' }).error).toMatch(/full path/);
    expect(validateSource({ kind: 'dropbox' }).error).toMatch(/three/);
  });

  it('reads the row defensively and names the source in one line', () => {
    expect(shapeSource(null)).toEqual({ kind: 'sync', url: null, path: null, setAt: null });
    expect(shapeSource({ kind: 'git', url: 'https://x.example/y', set_at: 't' })).toEqual({ kind: 'git', url: 'https://x.example/y', path: null, setAt: 't' });
    expect(shapeSource({ kind: 'what' }).kind).toBe('sync');
    expect(describeSource(null)).toMatch(/share through Quorum/);
    expect(describeSource({ kind: 'git', url: 'https://github.com/example/kb.git', path: null })).toBe('Repository github.com/example/kb');
    expect(describeSource({ kind: 'folder', url: null, path: '/Volumes/Shared/Team' })).toBe('Folder /Volumes/Shared/Team');
  });

  it('puts each source where it lives on this Mac, one clone per address', () => {
    const base = { workspaceId: 'ws 1', dataDir: '/data', syncRoot: '/sync' };
    expect(sourceRoot({ kind: 'sync' }, base)).toBe('/sync');
    expect(sourceRoot({ kind: 'folder', path: '/Volumes/S' }, base)).toBe('/Volumes/S');
    expect(sourceRoot({ kind: 'folder', path: '/Volumes/S' }, { ...base, override: '/tmp/me/S' })).toBe('/tmp/me/S');
    expect(sourceRoot({ kind: 'git', url: 'https://x.example/a' }, base)).toBe(cloneDir('/data', 'ws 1', 'https://x.example/a'));
    expect(cloneDir('/data', 'ws 1', 'https://x.example/a')).not.toBe(cloneDir('/data', 'ws 1', 'https://x.example/b'));
    expect(cloneDir('/data', 'ws/../1', 'u')).toMatch(new RegExp(`^${path.join('/data', 'team-knowledge', 'ws1-')}[0-9a-f]{12}$`));
  });
});

describe('the gates in front of the tab', () => {
  const signed = { signedIn: true, workspace: { id: 'w', name: 'W', domain: null, domainJoin: false, role: 'member' } };
  it('opens only for a signed-in member of a workspace with service and a team switched on', () => {
    expect(teamGate(null, true, true)).toBe('account');
    expect(teamGate({ signedIn: true, workspace: null }, true, true)).toBe('account');
    expect(teamGate(signed, null, true)).toBe('plan');
    expect(teamGate(signed, false, true)).toBe('plan');
    expect(teamGate(signed, true, false)).toBe('team');
    expect(teamGate(signed, true, true)).toBe('open');
  });
  it('reads the team switch from the workspace, and never from its absence', () => {
    expect(teamEnabledOf(null)).toBe(false);
    expect(teamEnabledOf(signed)).toBe(false);
    expect(teamEnabledOf({ ...signed, workspace: { ...signed.workspace, teamEnabled: true } })).toBe(true);
    expect(teamEnabledOf({ ...signed, workspace: { ...signed.workspace, teamEnabled: 'yes' } })).toBe(false);
  });
});

describe('the index over a team source', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'quorum-team-data-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  const rpcs = [];
  let row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  // the default KB's source as kb_list returns it, next to a KB that is not the default; null means no default KB
  const client = {
    rpc: async (name, args) => {
      rpcs.push([name, args]);
      const other = { id: 'k2', is_default: false, source: { kind: 'github', url: 'https://github.com/example/other' } };
      if (name === 'kb_list') return { data: row === null ? [other] : [{ id: 'k1', is_default: true, source: row }, other], error: null };
      if (name === 'kb_default_source_set') { row = args.source.kind === 'sync' ? null : { ...args.source, set_at: 'now' }; return { data: { id: 'k1', is_default: true, source: row }, error: null }; }
      return { data: null, error: { message: `Could not find the function public.${name}`, code: 'PGRST202' } };
    },
  };
  const noGit = async () => { throw Object.assign(new Error('no git in tests'), { code: 'GIT' }); };
  const make = (role, extra = {}) => {
    const settings = {};
    const t = createTeamKnowledge({ account: { client: () => client, state: () => ({ signedIn: true, workspace: { id: 'w1', role } }), sync: { team: () => ({ root: '/nowhere' }) } }, settings, saveSettings: () => {}, dataDir, git: noGit, ...extra });
    return { t, settings };
  };

  it('lists, searches, graphs, resolves and reads the fixture folder, read-only', async () => {
    const { t } = make('member');
    const src = await t.handlers['team-source']();
    expect(src.source.kind).toBe('folder');
    expect(src.local).toMatchObject({ root: FIXTURE, exists: true, notes: 3, pulling: false });
    const tree = (await t.handlers['team-tree']()).tree;
    expect(tree.map((i) => i.path)).toEqual(['guides', 'Onboarding.md', 'README.md']);
    const hits = (await t.handlers['team-search']('access')).hits;
    expect(hits.map((h) => h.rel)).toEqual(['Onboarding.md']);
    expect(hits[0].snippet).toMatch(/ops@example.com/);
    const g = (await t.handlers['team-graph']()).graph;
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['Onboarding.md', 'README.md', 'guides/release process.md']);
    expect(g.links.length).toBe(3);
    expect((await t.handlers['team-resolve']('release process', 'Onboarding.md')).rel).toBe('guides/release process.md');
    expect((await t.handlers['team-resolve']('nothing here', 'Onboarding.md')).rel).toBe(null);
    const doc = (await t.handlers['team-note']('Onboarding.md')).doc;
    expect(doc.title).toBe('Onboarding');
    expect(doc.body).toMatch(/Ask ops@example.com/);
    expect(await t.handlers['team-note']('../secret.md')).toEqual({ error: 'That note is not in the team knowledge.' });
    t.stop();
  });

  it('reads the source from the default KB and never from the 0020 column or RPC', async () => {
    const before = rpcs.length;
    const { t } = make('member');
    expect((await t.handlers['team-source']()).source).toMatchObject({ kind: 'folder', path: FIXTURE, setAt: 't1' });
    expect(rpcs.slice(before)).toEqual([['kb_list', { workspace_id: 'w1' }]]);
    // a workspace with no default KB, or one whose default KB holds an import source, reads Quorum sync
    row = null;
    expect((await t.handlers['team-source']()).source).toEqual({ kind: 'sync', url: null, path: null, setAt: null });
    row = { kind: 'github', url: 'https://github.com/example/handbook' };
    expect((await t.handlers['team-source']()).source.kind).toBe('sync');
    t.stop();
    row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  });

  it('shows the server sentence when the database refuses the source', async () => {
    const refusing = { rpc: async (name) => (name === 'kb_list' ? { data: [], error: null } : { data: null, error: { message: 'Switch the team on first. The knowledge source belongs to the workspace\'s default knowledge base', code: 'P0001' } }) };
    const t = createTeamKnowledge({ account: { client: () => refusing, state: () => ({ signedIn: true, workspace: { id: 'w1', role: 'owner' } }) }, settings: {}, dataDir, git: noGit });
    expect(await t.handlers['team-source-set']({ kind: 'git', url: 'https://x.example/kb.git' })).toEqual({ error: 'Switch the team on first. The knowledge source belongs to the workspace\'s default knowledge base.' });
    t.stop();
  });

  it('builds no index for the sync source', async () => {
    row = { kind: 'sync' };
    let built = 0;
    const { t } = make('member', { makeIndex: () => { built++; return { start() {}, stop() {}, size: () => 0 }; } });
    const src = await t.handlers['team-source']();
    expect(src.local).toMatchObject({ kind: 'sync', exists: false, notes: 0 });
    expect((await t.handlers['team-tree']()).tree).toEqual([]);
    expect((await t.handlers['team-search']('x')).hits).toEqual([]);
    expect(built).toBe(0);
    t.stop();
    row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  });

  it('lets only admins change the source, clones nothing without git, and asks for git again later', async () => {
    const member = make('member');
    expect(await member.t.handlers['team-source-set']({ kind: 'git', url: 'https://x.example/kb' })).toEqual({ error: 'Only owners and admins can change the knowledge source.' });
    let gitCalls = 0;
    const admin = make('admin', { git: async (args) => { gitCalls++; if (args[0] === '--version' && gitCalls > 2) return 'git version 2.0'; throw Object.assign(new Error('no git'), { code: 'GIT' }); } });
    expect(await admin.t.handlers['team-source-set']({ kind: 'git', url: 'nope' })).toEqual({ error: 'Enter an https:// or git@ clone address.' });
    const r = await admin.t.handlers['team-source-set']({ kind: 'git', url: 'https://x.example/kb.git' });
    expect(rpcs.find(([n]) => n === 'kb_default_source_set')).toEqual(['kb_default_source_set', { workspace_id: 'w1', source: { kind: 'git', url: 'https://x.example/kb.git', path: null } }]);
    expect(r.source.kind).toBe('git');
    expect(r.local).toMatchObject({ exists: false, gitAvailable: false, notes: 0 });
    expect(r.local.lastError).toMatch(/git is not installed/);
    expect(admin.settings.teamKnowledge.w1.lastError).toMatch(/git is not installed/);
    // a Mac that gets git later is probed again instead of remembering the miss
    const again = await admin.t.handlers['team-pull']();
    expect(again.local.gitAvailable).toBe(true);
    expect(again.local.lastError).toMatch(/no git/);
    admin.t.stop(); member.t.stop();
    row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  });

  it('keeps the folder a person chose on this Mac until an admin changes the source', async () => {
    row = { kind: 'folder', path: '/Volumes/Elsewhere/Knowledge', set_at: 't2' };
    const { t, settings } = make('member', { pickFolder: async () => FIXTURE });
    const before = await t.handlers['team-source']();
    expect(before.local).toMatchObject({ exists: false, root: '/Volumes/Elsewhere/Knowledge' });
    const picked = await t.handlers['team-source-pick']();
    expect(picked.path).toBe(FIXTURE);
    expect(picked.local).toMatchObject({ exists: true, root: FIXTURE, notes: 3 });
    expect(settings.teamKnowledge.w1.path).toBe(FIXTURE);
    expect((await t.handlers['team-source']()).local.root).toBe(FIXTURE);
    // the admin points the workspace somewhere new: the per-Mac choice no longer applies
    row = { kind: 'folder', path: '/Volumes/New/Knowledge', set_at: 't3' };
    expect((await t.handlers['team-source']()).local).toMatchObject({ root: '/Volumes/New/Knowledge', exists: false });
    expect(settings.teamKnowledge.w1.path).toBeUndefined();
    expect(rpcs.filter(([n]) => n === 'kb_default_source_set').length).toBe(1);
    t.stop();
    row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  });

  it('replaces a clone whose address changed, clones into scratch space, and runs one pull at a time', async () => {
    const url = 'https://x.example/team.git';
    row = { kind: 'git', url, set_at: 't4' };
    const dir = cloneDir(dataDir, 'w1', url);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    writeFileSync(path.join(dir, 'old.md'), '# Old');
    const calls = [];
    let pulls = 0;
    const git = async (args, cwd) => {
      calls.push(args[0]);
      if (args[0] === '--version') return 'git version 2.0';
      if (args[0] === 'remote') return 'https://x.example/other.git\n';
      if (args[0] === 'clone') { const into = args[4]; expect(args[3]).toBe(url); mkdirSync(path.join(into, '.git'), { recursive: true }); writeFileSync(path.join(into, 'fresh.md'), '# Fresh\n\nNew text.'); expect(cwd).toBe(tmpdir()); return ''; }
      if (args[0] === 'pull') { pulls++; await new Promise((r) => setTimeout(r, 30)); return ''; }
      return '';
    };
    const { t } = make('member', { git });
    const r = await t.handlers['team-pull']();
    expect(calls).toEqual(['--version', 'remote', 'clone']);
    expect(r.local).toMatchObject({ exists: true, notes: 1, lastError: null });
    expect((await t.handlers['team-tree']()).tree.map((i) => i.path)).toEqual(['fresh.md']);
    // two refreshes at once: the second returns while the first still runs, and only one pull reaches git
    writeFileSync(path.join(dir, 'config'), '');
    const gitFine = async (args) => (args[0] === 'remote' ? `${url}\n` : git(args));
    const t2 = make('member', { git: gitFine }).t;
    await Promise.all([t2.handlers['team-pull'](), t2.handlers['team-pull']()]);
    expect(pulls).toBe(1);
    t.stop(); t2.stop();
    row = { kind: 'folder', path: FIXTURE, set_at: 't1' };
  });
});
