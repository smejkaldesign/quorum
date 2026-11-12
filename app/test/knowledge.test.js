import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createKnowledge, listTeamNotes, readTeamNote, shapeMine, shapeQueueItem } from '../ee/knowledge.js';

describe('the review queue in the app', () => {
  it('shapes queue rows with a title fallback from the path', () => {
    expect(shapeQueueItem({ id: 'c1', note_id: 'n1', path: 'notes/Plan for Q1.md', title: null, author_email: 'a@example.com', created_at: 't' })).toMatchObject({ id: 'c1', title: 'Plan for Q1', authorEmail: 'a@example.com', authorName: null });
    expect(shapeMine({ note_id: 'n1', path: 'p.md', status: 'pending', created_at: 't' })).toEqual({ noteId: 'n1', path: 'p.md', status: 'pending', reviewedAt: null, createdAt: 't' });
  });
  it('refuses members on admin calls and passes decisions to the RPC', async () => {
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: name === 'review_contribution' ? { status: 'included' } : [], error: null }; }, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { auto_include: true }, error: null }) }) }) }) };
    const member = createKnowledge({ account: { client: () => client, state: () => ({ signedIn: true, workspace: { id: 'w', role: 'member' } }) } });
    expect(await member.handlers['knowledge-queue']()).toEqual({ error: 'Only owners and admins can review contributions.' });
    expect(await member.handlers['knowledge-status']()).toEqual({ autoInclude: true, mine: [], team: null });
    const admin = createKnowledge({ account: { client: () => client, state: () => ({ signedIn: true, workspace: { id: 'w', role: 'admin' } }) } });
    expect(await admin.handlers['knowledge-review']('c1', 'include')).toEqual({ status: 'included' });
    expect(calls.at(-1)).toEqual(['review_contribution', { id: 'c1', decision: 'include' }]);
    await admin.handlers['knowledge-review']('c1', 'anything else');
    expect(calls.at(-1)[1].decision).toBe('decline');
  });
});

describe('the workspace vault behind the Knowledge tab', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'quorum-team-'));
  mkdirSync(path.join(root, '05-knowledge'), { recursive: true });
  mkdirSync(path.join(root, '.updates'), { recursive: true });
  writeFileSync(path.join(root, '05-knowledge', 'onboarding.md'), '---\ntitle: x\nteam_item: t1\nteam_version: v1\nteam_pulled_at: 2026-11-10T00:00:00Z\n---\n# Onboarding guide\n\nStart here.\n');
  writeFileSync(path.join(root, 'roadmap.md'), '---\nteam_item: t2\nteam_version: v2\nteam_pulled_at: 2026-11-11T00:00:00Z\nteam_behind: true\n---\nNo heading here.\n');
  writeFileSync(path.join(root, 'roadmap (removed).md'), 'gone');
  writeFileSync(path.join(root, '.updates', 'roadmap.md'), 'newer');
  writeFileSync(path.join(root, 'notes.txt'), 'not a note');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists shared notes newest first with a title from the heading or the file name, skipping removed copies and dot folders', () => {
    const notes = listTeamNotes(root);
    expect(notes.map((n) => n.rel)).toEqual(['roadmap.md', '05-knowledge/onboarding.md']);
    expect(notes[0]).toMatchObject({ title: 'roadmap', behind: true, item: 't2', pulledAt: '2026-11-11T00:00:00Z' });
    expect(notes[1]).toMatchObject({ title: 'Onboarding guide', behind: false, item: 't1' });
    expect(listTeamNotes(null)).toEqual([]);
    expect(listTeamNotes(path.join(root, 'missing'))).toEqual([]);
  });

  it('reads one note with its frontmatter and title line stripped, and refuses paths outside the vault', () => {
    expect(readTeamNote(root, '05-knowledge/onboarding.md')).toEqual({ rel: '05-knowledge/onboarding.md', title: 'Onboarding guide', body: 'Start here.', pulledAt: '2026-11-10T00:00:00Z', behind: false });
    expect(readTeamNote(root, '../outside.md')).toBeNull();
    expect(readTeamNote(root, '/etc/passwd')).toBeNull();
    expect(readTeamNote(root, 'notes.txt')).toBeNull();
    expect(readTeamNote(root, 'nope.md')).toBeNull();
  });

  it('answers the tab handlers from the sync module\'s team root, and without one lists nothing', async () => {
    const account = { client: () => ({}), state: () => ({ signedIn: true, workspace: { id: 'w', role: 'member' } }), sync: { team: () => ({ root }) } };
    const k = createKnowledge({ account });
    expect((await k.handlers['knowledge-list']()).notes.length).toBe(2);
    expect((await k.handlers['knowledge-read']('roadmap.md')).doc.title).toBe('roadmap');
    expect(await k.handlers['knowledge-read']('../x.md')).toEqual({ error: 'That note is not in the workspace vault.' });
    const none = createKnowledge({ account: { ...account, sync: null } });
    expect(await none.handlers['knowledge-list']()).toEqual({ root: null, notes: [] });
  });
});
