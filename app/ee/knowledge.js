import { mkdirSync } from 'node:fs';
// Company knowledge (Cloud edition): the admin review queue and auto-include (migration 0012). A note a member marks
// public becomes a contribution on the server; here admins list, include or decline, and members see their own.
import { plain } from './account.js';

export const shapeQueueItem = (r) => ({ id: r.id, noteId: r.note_id, path: r.path, title: r.title || String(r.path ?? '').replace(/^.*\//, '').replace(/\.md$/, ''), authorEmail: r.author_email ?? null, authorName: r.author_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at ?? null });
export const shapeMine = (r) => ({ noteId: r.note_id, path: r.path, status: r.status, reviewedAt: r.reviewed_at ?? null, createdAt: r.created_at });

export function createKnowledge({ account, log = () => {}, shell = null }) {
  const fail = (err, fallback) => { log('knowledge', err?.message ?? err); return { error: plain(err, fallback) }; };
  const ready = (admin = false) => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    if (admin && s.workspace.role === 'member') return { error: 'Only owners and admins can review contributions.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  const handlers = {
    'knowledge-status': async () => {
      const no = ready(); if (no) return no;
      try {
        const { data, error } = await account.client().from('workspaces').select('auto_include').eq('id', ws()).maybeSingle();
        if (error) return fail(error);
        const mine = await account.client().rpc('my_contributions', { workspace_id: ws() });
        return { autoInclude: data?.auto_include === true, mine: (mine.data ?? []).map(shapeMine), team: account.sync?.team?.() ?? null };
      } catch (err) { return fail(err); }
    },
    // the workspace vault folder in Finder, created when the first shared note has yet to arrive
    'knowledge-team-open': async () => {
      const root = account.sync?.team?.()?.root;
      if (!root || !shell) return { error: 'No workspace vault yet.' };
      mkdirSync(root, { recursive: true });
      await shell.openPath(root);
      return {};
    },
    'knowledge-queue': async () => {
      const no = ready(true); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('review_queue', { workspace_id: ws() });
        if (error) return fail(error);
        return { queue: (data ?? []).map(shapeQueueItem) };
      } catch (err) { return fail(err); }
    },
    'knowledge-review': async (id, decision) => {
      const no = ready(true); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('review_contribution', { id: String(id ?? ''), decision: decision === 'include' ? 'include' : 'decline' });
        if (error) return fail(error, 'The contribution could not be reviewed.');
        return { status: data?.status };
      } catch (err) { return fail(err, 'The contribution could not be reviewed.'); }
    },
    'knowledge-auto-include-set': async (on) => {
      const no = ready(true); if (no) return no;
      try {
        const { data, error } = await account.client().rpc('workspace_auto_include_set', { workspace_id: ws(), on_: on === true });
        if (error) return fail(error, 'Auto-include could not be changed.');
        return { autoInclude: data === true };
      } catch (err) { return fail(err, 'Auto-include could not be changed.'); }
    },
  };
  return { handlers };
}

export function registerKnowledge({ ipcMain, account, log, shell = null }) {
  const k = createKnowledge({ account, log, shell });
  for (const [name, fn] of Object.entries(k.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return k;
}
