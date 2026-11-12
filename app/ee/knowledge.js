import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
// Company knowledge (Cloud edition): the admin review queue and auto-include (migration 0012). A note a member marks
// public becomes a contribution on the server; here admins list, include or decline, and members see their own.
import { plain } from './account.js';
import { bondOf, parseFrontmatter, stripFrontmatter } from './sync.js';

export const shapeQueueItem = (r) => ({ id: r.id, noteId: r.note_id, path: r.path, title: r.title || String(r.path ?? '').replace(/^.*\//, '').replace(/\.md$/, ''), authorEmail: r.author_email ?? null, authorName: r.author_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at ?? null });
// the workspace vault on disk (ee/sync.js pulls teammates' included notes there): every shared note with its title,
// when it was pulled and whether the person's own edit holds a newer team version back. Dot folders (.updates) and the
// "(removed)" copies sync leaves behind stay out
const titleOf = (text, rel) => stripFrontmatter(text).match(/^#\s+(.+)$/m)?.[1]?.trim() || rel.replace(/^.*\//, '').replace(/\.md$/, '');
const REMOVED = /\((removed|behind)( \d+)?\)\.md$/;
// a path the tab may list or read: a .md file, no dot folder on the way, none of sync's "(removed)" copies
const listable = (rel) => rel.endsWith('.md') && !REMOVED.test(rel) && !rel.split('/').some((seg) => seg.startsWith('.'));
export function listTeamNotes(root) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.name.endsWith('.md') || REMOVED.test(e.name)) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const text = readFileSync(abs, 'utf8');
      const fm = parseFrontmatter(text);
      const bond = bondOf(text);
      out.push({ rel, title: titleOf(text, rel), pulledAt: fm.team_pulled_at ?? null, behind: !!bond?.behind, item: bond?.item ?? null });
    }
  };
  walk(root);
  return out.sort((a, b) => String(b.pulledAt ?? '').localeCompare(String(a.pulledAt ?? '')) || a.title.localeCompare(b.title));
}
// one shared note, by its path inside the vault; anything that resolves outside the root is refused
// a symlink that points out of the vault is refused too: both sides are compared as real paths. A note the person's
// own edit holds behind also carries the team's newer text (sync keeps it under .updates/), so the tab can show it
export function readTeamNote(root, rel) {
  if (!root || typeof rel !== 'string' || !listable(rel) || !existsSync(root)) return null;
  const abs = path.resolve(root, rel);
  if (!existsSync(abs)) return null;
  const real = realpathSync(abs), base = realpathSync(root);
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  const text = readFileSync(real, 'utf8');
  const fm = parseFrontmatter(text);
  const body = (t) => stripFrontmatter(t).replace(/^\s*#\s+.+\n?/, '').trim();
  const behind = bondOf(text)?.behind === true;
  const updateFile = path.join(base, '.updates', rel);
  const update = behind && existsSync(updateFile) && realpathSync(updateFile).startsWith(base + path.sep) ? body(readFileSync(updateFile, 'utf8')) : null;
  return { rel, title: titleOf(text, rel), body: body(text), pulledAt: fm.team_pulled_at ?? null, behind, update };
}
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
    // the Knowledge tab: what the workspace vault holds, and one note from it
    'knowledge-list': async () => {
      const no = ready(); if (no) return no;
      const root = account.sync?.team?.()?.root ?? null;
      try { return { root, notes: listTeamNotes(root) }; } catch (err) { return fail(err, 'The workspace vault could not be read.'); }
    },
    'knowledge-read': async (rel) => {
      const no = ready(); if (no) return no;
      const root = account.sync?.team?.()?.root ?? null;
      try {
        const doc = readTeamNote(root, rel);
        return doc ? { doc } : { error: 'That note is not in the workspace vault.' };
      } catch (err) { return fail(err, 'The note could not be read.'); }
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
