// Team knowledge: the source an admin sets, where it lands on this Mac, and the read-only index the tab reads.
import { mkdtempSync, rmSync } from 'node:fs';
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

  it('puts each source where it lives on this Mac', () => {
    const base = { workspaceId: 'ws 1', dataDir: '/data', syncRoot: '/sync' };
    expect(sourceRoot({ kind: 'sync' }, base)).toBe('/sync');
    expect(sourceRoot({ kind: 'folder', path: '/Volumes/S' }, base)).toBe('/Volumes/S');
    expect(sourceRoot({ kind: 'folder', path: '/Volumes/S' }, { ...base, override: '/tmp/me/S' })).toBe('/tmp/me/S');
    expect(sourceRoot({ kind: 'git', url: 'https://x' }, base)).toBe(cloneDir('/data', 'ws 1'));
    expect(cloneDir('/data', 'ws/../1')).toBe(path.join('/data', 'team-knowledge', 'ws1'));
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
  it('reads the team flag from either place it may arrive, and never from its absence', () => {
    expect(teamEnabledOf(null)).toBe(false);
    expect(teamEnabledOf({ ...signed })).toBe(false);
    expect(teamEnabledOf({ ...signed, teamEnabled: true })).toBe(true);
    expect(teamEnabledOf({ ...signed, workspace: { ...signed.workspace, teamEnabled: true } })).toBe(true);
    expect(teamEnabledOf({ ...signed, teamEnabled: 'yes' })).toBe(false);
  });
});

describe('the index over a team source', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'quorum-team-data-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
  const rpcs = [];
  let row = { kind: 'folder', path: FIXTURE, set_at: 't' };
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { team_source: row }, error: null }) }) }) }),
    rpc: async (name, args) => { rpcs.push([name, args]); row = { ...args.source, set_at: 'now' }; return { data: row, error: null }; },
  };
  const make = (role, extra = {}) => {
    const settings = {};
    const t = createTeamKnowledge({ account: { client: () => client, state: () => ({ signedIn: true, workspace: { id: 'w1', role } }), sync: { team: () => ({ root: '/nowhere' }) } }, settings, saveSettings: () => {}, dataDir, git: async () => { throw Object.assign(new Error('no git in tests'), { code: 'GIT' }); }, ...extra });
    return { t, settings };
  };

  it('lists, searches, graphs and reads the fixture folder, read-only', async () => {
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
    const doc = (await t.handlers['team-note']('Onboarding.md')).doc;
    expect(doc.title).toBe('Onboarding');
    expect(doc.body).toMatch(/Ask ops@example.com/);
    expect(await t.handlers['team-note']('../secret.md')).toEqual({ error: 'That note is not in the team knowledge.' });
    t.stop();
  });

  it('lets only admins change the source, and clones nothing without git', async () => {
    const member = make('member');
    expect(await member.t.handlers['team-source-set']({ kind: 'git', url: 'https://x.example/kb' })).toEqual({ error: 'Only owners and admins can change the knowledge source.' });
    const admin = make('admin');
    expect(await admin.t.handlers['team-source-set']({ kind: 'git', url: 'nope' })).toEqual({ error: 'Enter an https:// or git@ clone address.' });
    const r = await admin.t.handlers['team-source-set']({ kind: 'git', url: 'https://x.example/kb.git' });
    expect(rpcs.at(-1)).toEqual(['workspace_team_source_set', { workspace_id: 'w1', source: { kind: 'git', url: 'https://x.example/kb.git', path: null } }]);
    expect(r.source.kind).toBe('git');
    expect(r.local).toMatchObject({ exists: false, gitAvailable: false, notes: 0 });
    expect(r.local.lastError).toMatch(/git is not installed/);
    expect(admin.settings.teamKnowledge.w1.lastError).toMatch(/git is not installed/);
    admin.t.stop(); member.t.stop();
  });

  it('keeps the folder a person chose on this Mac when the admin path is elsewhere', async () => {
    row = { kind: 'folder', path: '/Volumes/Elsewhere/Knowledge', set_at: 't' };
    const { t, settings } = make('member', { pickFolder: async () => FIXTURE });
    const before = await t.handlers['team-source']();
    expect(before.local).toMatchObject({ exists: false, root: '/Volumes/Elsewhere/Knowledge' });
    const picked = await t.handlers['team-source-pick']();
    expect(picked.path).toBe(FIXTURE);
    expect(picked.local).toMatchObject({ exists: true, root: FIXTURE, notes: 3 });
    expect(settings.teamKnowledge.w1.path).toBe(FIXTURE);
    expect(rpcs.filter(([n]) => n === 'workspace_team_source_set').length).toBe(1);
    t.stop();
  });
});
