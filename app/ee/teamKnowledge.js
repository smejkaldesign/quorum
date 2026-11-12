// Team knowledge (Cloud edition): where a workspace's shared knowledge comes from, and a read-only index over it for
// the Knowledge tab. An admin picks one source for the workspace (migration 0020): the notes Quorum sync pulls, a
// folder every member has on their Mac (a shared drive, a checkout they keep), or a git repository each Mac clones.
// The choice is one row every member reads; the folder or clone stays on each Mac, and nothing here writes to it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plain } from './account.js';
import { readTeamNote } from './knowledge.js';
import { createVaultIndex } from '../vindex.js';
import { vaultTree, walk } from '../vault.js';

export const SOURCE_KINDS = ['sync', 'folder', 'git'];
export const SOURCE_LABEL = { sync: 'Quorum sync', folder: 'A folder on each Mac', git: 'A git repository' };

// an https or ssh clone address with nothing a shell would read; a local path is a folder source, never a git one
const GIT_URL = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+|git@[\w.-]+:[\w./~-]+|ssh:\/\/[\w.-]+@[\w.-]+(:\d+)?\/[\w./~-]+)$/;

// what the admin typed, as the row Quorum stores; an error names what is wrong in a sentence for the page
export function validateSource(draft = {}) {
  const kind = draft.kind ?? 'sync';
  if (!SOURCE_KINDS.includes(kind)) return { error: 'Pick one of the three sources.' };
  if (kind === 'sync') return { source: { kind, url: null, path: null } };
  if (kind === 'git') {
    const url = String(draft.url ?? '').trim();
    if (!url) return { error: 'Enter the repository address.' };
    if (!GIT_URL.test(url)) return { error: 'Enter an https:// or git@ clone address.' };
    return { source: { kind, url, path: null } };
  }
  const p = String(draft.path ?? '').trim();
  if (!p) return { error: 'Choose the folder.' };
  if (!path.isAbsolute(p) || p.split(path.sep).includes('..')) return { error: 'The folder has to be a full path on this Mac.' };
  return { source: { kind, url: null, path: p } };
}

export const shapeSource = (row) => {
  if (!row || typeof row !== 'object' || !SOURCE_KINDS.includes(row.kind)) return { kind: 'sync', url: null, path: null, setAt: null };
  return { kind: row.kind, url: row.url ?? null, path: row.path ?? null, setAt: row.set_at ?? null };
};

// each Mac clones a git source under Quorum's own data folder, one clone per workspace and address, so a changed
// address never reads an old clone
export const cloneDir = (dataDir, workspaceId, url) => path.join(dataDir, 'team-knowledge', `${String(workspaceId).replace(/[^\w-]/g, '')}-${createHash('sha256').update(String(url ?? '')).digest('hex').slice(0, 12)}`);

// the folder the index reads on this Mac: the sync vault, the admin's folder (or the one this person chose instead
// of it, since a shared drive mounts under different paths), or the clone
export function sourceRoot(source, { workspaceId, dataDir, syncRoot, override = null }) {
  if (source.kind === 'git') return cloneDir(dataDir, workspaceId, source.url);
  if (source.kind === 'folder') return override || source.path || null;
  return syncRoot ?? null;
}

const isDir = (p) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };
const yieldNow = () => new Promise((r) => setImmediate(r));

// git on this Mac, with prompts off so a private repository fails with a message instead of hanging
export const runGit = (args, cwd, timeout = 120000) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
    if (err) { const e = new Error(String(errOut || err.message).trim().split('\n').pop() || 'git failed'); e.code = 'GIT'; reject(e); return; }
    resolve(String(out));
  });
});

export function createTeamKnowledge({ account, settings = {}, saveSettings = () => {}, dataDir, log = () => {}, pickFolder = async () => null, git = runGit, makeIndex = createVaultIndex, onChange = () => {} }) {
  const fail = (err, fallback) => { log('team', err?.message ?? err); return { error: err?.code === 'GIT' ? err.message : plain(err, fallback) }; };
  const ready = (admin = false) => {
    if (!account.client()) return { error: 'Hosted accounts are not set up in this build.' };
    const s = account.state();
    if (!s.signedIn) return { error: 'Sign in first.' };
    if (!s.workspace) return { error: 'Pick a workspace first.' };
    if (admin && s.workspace.role === 'member') return { error: 'Only owners and admins can change the knowledge source.' };
    return null;
  };
  const ws = () => account.state().workspace.id;
  // per-Mac state for each workspace: the folder this person chose, the last pull, the last error, and which row
  // version the choice belongs to (an admin changing the source drops the per-Mac folder)
  const local = () => { settings.teamKnowledge ??= {}; return (settings.teamKnowledge[ws()] ??= {}); };
  const syncRoot = () => account.sync?.team?.()?.root ?? null;

  let source = { kind: 'sync', url: null, path: null, setAt: null };
  let sourceFor = null;
  const readSource = async () => {
    const { data, error } = await account.client().from('workspaces').select('team_source').eq('id', ws()).maybeSingle();
    if (error) throw error;
    source = shapeSource(data?.team_source);
    sourceFor = ws();
    const l = local();
    if (l.setAt !== source.setAt) { l.path = undefined; l.lastError = null; l.lastPullAt = null; l.setAt = source.setAt; saveSettings(); }
    return source;
  };
  const current = async () => (sourceFor === ws() ? source : readSource());
  const rootOf = () => sourceRoot(source, { workspaceId: ws(), dataDir, syncRoot: syncRoot(), override: source.kind === 'folder' ? local().path ?? null : null });

  // one read-only index per root, built on the first read that needs it and never for the sync source (the Knowledge
  // tab lists that one from the pull records). The first scan yields once so queued IPC runs before it
  let idx = null, idxRoot = null, pulling = false;
  const dropIndex = () => { idx?.stop(); idx = null; idxRoot = null; };
  const index = async () => {
    const root = rootOf();
    if (source.kind === 'sync' || !isDir(root)) { dropIndex(); return null; }
    if (idx && idxRoot === root) return idx;
    dropIndex();
    const next = makeIndex({ vault: root, isExcludedPath: () => false, isExcludedText: () => false, redact: (t) => t, onChange: (rels) => onChange(rels), log: (...a) => log('team-index', ...a) });
    await yieldNow();
    next.start();
    idx = next; idxRoot = root;
    return idx;
  };
  // only a found git is remembered; a Mac that gets git later is asked again
  let gitAvailable = false;
  const hasGit = async () => { if (!gitAvailable) { try { await git(['--version'], undefined, 5000); gitAvailable = true; } catch { gitAvailable = false; } } return gitAvailable; };

  const countNotes = (root) => { try { return walk(root, '', () => false, []).length; } catch { return 0; } };
  const status = async () => {
    const root = rootOf();
    const l = local();
    const exists = source.kind !== 'sync' && isDir(root);
    return { kind: source.kind, root, exists, lastPullAt: l.lastPullAt ?? null, lastError: l.lastError ?? null, gitAvailable: source.kind === 'git' ? await hasGit() : true, notes: exists ? (idx && idxRoot === root ? idx.size() : countNotes(root)) : 0, pulling };
  };

  // clone once (into a scratch folder, moved into place only when whole), then pull; a clone whose address no longer
  // matches the row is replaced. A failure is kept for the page, and a pull already running is left alone
  const pull = async () => {
    if (pulling) return;
    pulling = true;
    const l = local();
    if (source.kind === 'git') {
      const dir = cloneDir(dataDir, ws(), source.url);
      try {
        if (!(await hasGit())) { l.lastError = 'git is not installed on this Mac. Install the Xcode command line tools, then pull again.'; return; }
        let fresh = !isDir(path.join(dir, '.git'));
        if (!fresh) {
          const remote = (await git(['remote', 'get-url', 'origin'], dir).catch(() => '')).trim();
          if (remote !== source.url) { dropIndex(); rmSync(dir, { recursive: true, force: true }); fresh = true; }
        }
        if (fresh) {
          dropIndex();
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(path.dirname(dir), { recursive: true });
          const scratch = path.join(tmpdir(), `quorum-clone-${process.pid}-${Date.now()}`);
          try { await git(['clone', '--depth', '1', source.url, scratch], tmpdir()); renameSync(scratch, dir); }
          finally { rmSync(scratch, { recursive: true, force: true }); }
        } else await git(['pull', '--ff-only'], dir);
        l.lastPullAt = new Date().toISOString(); l.lastError = null;
      } catch (err) { l.lastError = err.message; log('team', err.message); }
      finally { pulling = false; saveSettings(); }
    } else {
      l.lastError = isDir(rootOf()) ? null : 'The folder is not on this Mac. Choose the folder here, or ask an admin to check the path.';
      l.lastPullAt = new Date().toISOString();
      pulling = false;
      saveSettings();
    }
    (await index())?.rebuild();
  };

  const handlers = {
    'team-source': async () => {
      const no = ready(); if (no) return no;
      try { await readSource(); return { source, local: await status() }; } catch (err) { return fail(err, 'The knowledge source could not be read.'); }
    },
    'team-source-set': async (draft) => {
      const no = ready(true); if (no) return no;
      const v = validateSource(draft);
      if (v.error) return { error: v.error };
      try {
        const { data, error } = await account.client().rpc('workspace_team_source_set', { workspace_id: ws(), source: v.source });
        if (error) return fail(error, 'The knowledge source could not be saved.');
        source = shapeSource(data); sourceFor = ws();
        dropIndex();
        const l = local(); l.path = undefined; l.lastError = null; l.lastPullAt = null; l.setAt = source.setAt; saveSettings();
        if (source.kind !== 'sync') await pull();
        return { source, local: await status() };
      } catch (err) { return fail(err, 'The knowledge source could not be saved.'); }
    },
    // the folder as it is on this Mac (a shared drive, a checkout); an admin picking it also sets it for the workspace
    'team-source-pick': async () => {
      const no = ready(); if (no) return no;
      const picked = await pickFolder();
      if (!picked) return {};
      const v = validateSource({ kind: 'folder', path: picked });
      if (v.error) return { error: v.error };
      try {
        await current();
        if (source.kind === 'folder') { dropIndex(); local().path = picked; saveSettings(); await pull(); return { path: picked, local: await status() }; }
        return { path: picked };
      } catch (err) { return fail(err, 'The folder could not be used.'); }
    },
    'team-pull': async () => {
      const no = ready(); if (no) return no;
      try { await current(); await pull(); return { local: await status() }; } catch (err) { return fail(err, 'The knowledge source could not be refreshed.'); }
    },
    'team-tree': async () => {
      const no = ready(); if (no) return no;
      try { await current(); const root = rootOf(); return { tree: source.kind !== 'sync' && isDir(root) ? vaultTree(root, () => false) : [] }; } catch (err) { return fail(err, 'The folder could not be read.'); }
    },
    'team-search': async (q, limit) => {
      const no = ready(); if (no) return no;
      try { await current(); return { hits: (await index())?.search(String(q ?? ''), Math.min(Number(limit) || 30, 200)) ?? [] }; } catch (err) { return fail(err, 'Search could not run.'); }
    },
    'team-graph': async () => {
      const no = ready(); if (no) return no;
      try { await current(); return { graph: (await index())?.graph() ?? null }; } catch (err) { return fail(err, 'The graph could not be built.'); }
    },
    // a wikilink inside a team note, resolved the way the index resolves every link (names, aliases, folders)
    'team-resolve': async (target, from) => {
      const no = ready(); if (no) return no;
      try { await current(); return { rel: (await index())?.resolve(String(target ?? ''), String(from ?? '')) ?? null }; } catch (err) { return fail(err, 'The link could not be followed.'); }
    },
    'team-note': async (rel) => {
      const no = ready(); if (no) return no;
      try {
        await current();
        const doc = readTeamNote(rootOf(), rel);
        return doc ? { doc } : { error: 'That note is not in the team knowledge.' };
      } catch (err) { return fail(err, 'The note could not be read.'); }
    },
  };
  return { handlers, stop: dropIndex };
}

export function registerTeamKnowledge({ ipcMain, account, settings, saveSettings, dataDir, log, pickFolder, toUI = () => {} }) {
  const t = createTeamKnowledge({ account, settings, saveSettings, dataDir, log, pickFolder, onChange: (rels) => toUI('team-changed', rels) });
  for (const [name, fn] of Object.entries(t.handlers)) ipcMain.handle(name, (_e, ...a) => fn(...a));
  return t;
}
