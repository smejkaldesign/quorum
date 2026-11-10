import { describe, expect, it } from 'vitest';
import { createKnowledge, shapeMine, shapeQueueItem } from '../ee/knowledge.js';

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
    expect(await member.handlers['knowledge-status']()).toEqual({ autoInclude: true, mine: [] });
    const admin = createKnowledge({ account: { client: () => client, state: () => ({ signedIn: true, workspace: { id: 'w', role: 'admin' } }) } });
    expect(await admin.handlers['knowledge-review']('c1', 'include')).toEqual({ status: 'included' });
    expect(calls.at(-1)).toEqual(['review_contribution', { id: 'c1', decision: 'include' }]);
    await admin.handlers['knowledge-review']('c1', 'anything else');
    expect(calls.at(-1)[1].decision).toBe('decline');
  });
});
