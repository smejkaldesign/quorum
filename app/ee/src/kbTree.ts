import type { Kb, KbAccess, KbAccessDraft, KbFolder, KbFolderNode, KbImportProgress, KbImportSkipped, KbNote, KbSource } from '../../src/quorum';
import { parseGithubUrl } from '../githubUrl';

// what a finished kb-import answers; removed counts notes a refresh took out because the source no longer has them
export type KbImportResult = { kb: Kb; imported: number; skipped: KbImportSkipped[]; removed: number; kept?: number; suggested?: number };

// Pure helpers for the knowledge base screens: the folder tree, what a move may do, the rows the tree shows and how
// the arrow keys walk them, the readers line, the access list the readers editor sends, and the import lines.

const byPosition = (a: { position: number; name: string }, b: { position: number; name: string }) =>
  (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);

// flat folder rows as a tree, siblings by position then name; a folder whose parent is missing shows at the top level
export function buildFolderTree(rows: Pick<KbFolder, 'id' | 'parentId' | 'name' | 'position'>[]): KbFolderNode[] {
  const nodes = new Map<string, KbFolderNode>(rows.map((f) => [f.id, { id: f.id, parentId: f.parentId ?? null, name: f.name, position: f.position ?? 0, children: [] }]));
  const top: KbFolderNode[] = [];
  for (const n of nodes.values()) (n.parentId && nodes.has(n.parentId) ? nodes.get(n.parentId)!.children : top).push(n);
  const sort = (list: KbFolderNode[]): KbFolderNode[] => { list.sort(byPosition); for (const n of list) sort(n.children); return list; };
  return sort(top);
}

// the tree back as flat rows, parents before children
export function flattenFolders(tree: KbFolderNode[]): Omit<KbFolder, 'kbId'>[] {
  const out: Omit<KbFolder, 'kbId'>[] = [];
  const walk = (list: KbFolderNode[]) => { for (const n of list) { out.push({ id: n.id, parentId: n.parentId, name: n.name, position: n.position }); walk(n.children); } };
  walk(tree);
  return out;
}

export function findFolder(tree: KbFolderNode[], id: string): KbFolderNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findFolder(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// the tree with one folder added or replaced (by id), as the server returned it after a create, rename or move
export function withFolder(tree: KbFolderNode[], folder: Pick<KbFolder, 'id' | 'parentId' | 'name' | 'position'>): KbFolderNode[] {
  return buildFolderTree([...flattenFolders(tree).filter((f) => f.id !== folder.id), folder]);
}

// the tree without a folder and everything inside it, as kb-folder-delete leaves it
export function withoutFolder(tree: KbFolderNode[], id: string): KbFolderNode[] {
  const gone = descendantIds(tree, id);
  gone.add(id);
  return buildFolderTree(flattenFolders(tree).filter((f) => !gone.has(f.id)));
}

// the ids of every folder inside one, at any depth
export function descendantIds(tree: KbFolderNode[], id: string): Set<string> {
  const out = new Set<string>();
  const start = findFolder(tree, id);
  const walk = (list: KbFolderNode[]) => { for (const n of list) { out.add(n.id); walk(n.children); } };
  if (start) walk(start.children);
  return out;
}

// the folder names from the top of the KB down to a folder, the folder included
export function folderPath(tree: KbFolderNode[], id: string): string[] {
  const walk = (list: KbFolderNode[], trail: string[]): string[] | null => {
    for (const n of list) {
      if (n.id === id) return [...trail, n.name];
      const hit = walk(n.children, [...trail, n.name]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

// whether a folder may move under a new parent (null for the KB's top level); the reason is the sentence to show
export function moveCheck(tree: KbFolderNode[], folderId: string, parentId: string | null): { ok: true } | { ok: false; reason: string } {
  const f = findFolder(tree, folderId);
  if (!f) return { ok: false, reason: 'That folder no longer exists.' };
  if (parentId === folderId) return { ok: false, reason: 'A folder cannot move inside itself.' };
  if (parentId && descendantIds(tree, folderId).has(parentId)) return { ok: false, reason: 'A folder cannot move into one of its own folders.' };
  if (parentId && !findFolder(tree, parentId)) return { ok: false, reason: 'That folder no longer exists.' };
  if ((f.parentId ?? null) === parentId) return { ok: false, reason: 'The folder is already there.' };
  const siblings = parentId ? findFolder(tree, parentId)!.children : tree;
  if (siblings.some((s) => s.id !== f.id && s.name.trim().toLowerCase() === f.name.trim().toLowerCase())) return { ok: false, reason: 'A folder with that name is already there.' };
  return { ok: true };
}

// the places a folder can move to, for the Move menu: the top level, then every folder that passes moveCheck
export function moveTargets(tree: KbFolderNode[], folderId: string): { id: string | null; label: string; depth: number }[] {
  const out: { id: string | null; label: string; depth: number }[] = [];
  if (moveCheck(tree, folderId, null).ok) out.push({ id: null, label: 'Top level', depth: 0 });
  const walk = (list: KbFolderNode[], depth: number) => {
    for (const n of list) {
      if (n.id === folderId) continue;
      if (moveCheck(tree, folderId, n.id).ok) out.push({ id: n.id, label: n.name, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 1);
  return out;
}

// one row of the tree as it shows: a KB or a folder inside one. key is unique across KBs
export type TreeRow = { key: string; kind: 'kb' | 'folder'; kbId: string; folderId: string | null; name: string; depth: number; parentKey: string | null; hasChildren: boolean; expanded: boolean };
export const kbKey = (kbId: string) => `kb:${kbId}`;
export const folderKey = (kbId: string, folderId: string) => `f:${kbId}:${folderId}`;
export const rowKey = (kbId: string, folderId: string | null) => (folderId ? folderKey(kbId, folderId) : kbKey(kbId));

// the rows the tree shows given which keys are open, in screen order; aria-level is depth + 1
export function visibleRows(kbs: Pick<Kb, 'id' | 'name' | 'folders'>[], open: Set<string>): TreeRow[] {
  const out: TreeRow[] = [];
  for (const kb of kbs) {
    const key = kbKey(kb.id);
    const expanded = open.has(key);
    out.push({ key, kind: 'kb', kbId: kb.id, folderId: null, name: kb.name, depth: 0, parentKey: null, hasChildren: kb.folders.length > 0, expanded });
    if (!expanded) continue;
    const walk = (list: KbFolderNode[], depth: number, parentKey: string) => {
      for (const n of list) {
        const k = folderKey(kb.id, n.id);
        const isOpen = open.has(k);
        out.push({ key: k, kind: 'folder', kbId: kb.id, folderId: n.id, name: n.name, depth, parentKey, hasChildren: n.children.length > 0, expanded: isOpen });
        if (isOpen) walk(n.children, depth + 1, k);
      }
    };
    walk(kb.folders, 1, key);
  }
  return out;
}

// what an arrow key does in the tree (the WAI-ARIA tree pattern): which row gets focus and which key opens or closes
export type TreeMove = { focus: string } | { open: string } | { close: string } | null;
export function treeKey(rows: TreeRow[], current: string | null, key: string): TreeMove {
  if (!rows.length) return null;
  const i = rows.findIndex((r) => r.key === current);
  if (i === -1) return { focus: rows[0].key };
  const r = rows[i];
  switch (key) {
    case 'ArrowDown': return i < rows.length - 1 ? { focus: rows[i + 1].key } : null;
    case 'ArrowUp': return i > 0 ? { focus: rows[i - 1].key } : null;
    case 'Home': return { focus: rows[0].key };
    case 'End': return { focus: rows[rows.length - 1].key };
    case 'ArrowRight':
      if (!r.hasChildren) return null;
      if (!r.expanded) return { open: r.key };
      return i < rows.length - 1 ? { focus: rows[i + 1].key } : null;
    case 'ArrowLeft':
      if (r.hasChildren && r.expanded) return { close: r.key };
      return r.parentKey ? { focus: r.parentKey } : null;
    default: return null;
  }
}

// the keys to open so a folder shows: its KB and every folder above it
export function openPathTo(kb: Pick<Kb, 'id' | 'folders'>, folderId: string | null): string[] {
  const keys = [kbKey(kb.id)];
  if (!folderId) return keys;
  const walk = (list: KbFolderNode[], trail: string[]): string[] | null => {
    for (const n of list) {
      if (n.id === folderId) return trail;
      const hit = walk(n.children, [...trail, folderKey(kb.id, n.id)]);
      if (hit) return hit;
    }
    return null;
  };
  return [...keys, ...(walk(kb.folders, []) ?? [])];
}

// the notes directly in one folder (null: the KB's top level), by title
export const notesIn = (notes: KbNote[], folderId: string | null): KbNote[] =>
  notes.filter((n) => (n.folderId ?? null) === folderId).sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));

// who reads a KB in one line; access is null for a person who is not the KB's admin
export function readersSummary(access: KbAccess[] | null): string {
  if (!access) return 'Readers are visible to its admins';
  const people = access.filter((a) => a.principal === 'user');
  const admins = people.filter((a) => a.role === 'admin').length;
  const editors = people.filter((a) => a.role === 'editor').length;
  const readers = people.length - admins;
  const parts: string[] = [];
  const ws = access.find((a) => a.principal === 'workspace');
  if (ws) parts.push(ws.role === 'admin' ? 'Whole workspace (all can manage)' : ws.role === 'editor' ? 'Whole workspace (all can edit)' : 'Whole workspace');
  else if (readers) parts.push(`${readers} ${readers === 1 ? 'person' : 'people'}`);
  else parts.push('Owners and admins only');
  if (editors) parts.push(`${editors} ${editors === 1 ? 'editor' : 'editors'}`);
  if (admins) parts.push(`${admins} KB ${admins === 1 ? 'admin' : 'admins'}`);
  return parts.join(' · ');
}

export type ReadersMode = 'workspace' | 'people';
// which way an access list reads, the people it names as readers or editors, which of them edit (hosted KBs), and
// whether the whole workspace edits
export function readersOf(access: KbAccess[] | null): { mode: ReadersMode; people: string[]; editors: string[]; workspaceEdits: boolean } {
  const list = access ?? [];
  return {
    mode: list.some((a) => a.principal === 'workspace') ? 'workspace' : 'people',
    people: list.filter((a) => a.principal === 'user' && (a.role === 'reader' || a.role === 'editor') && a.userId).map((a) => a.userId!),
    editors: list.filter((a) => a.principal === 'user' && a.role === 'editor' && a.userId).map((a) => a.userId!),
    workspaceEdits: list.some((a) => a.principal === 'workspace' && a.role === 'editor'),
  };
}

// the whole list kb-access-set takes for a readers choice. The KB admins already on the list stay admins; teams are
// not offered yet, so team rows are left out; a person chosen who is also an admin stays an admin. On a KB hosted by
// Quorum, editors (people chosen to edit) and workspaceEdits (the whole workspace edits) give the editor role; a person
// named as an editor keeps that role with the whole workspace reading too
export function accessDraft(current: KbAccess[] | null, mode: ReadersMode, people: string[], hosted: { editors: string[]; workspaceEdits: boolean } | null = null): KbAccessDraft[] {
  const list = current ?? [];
  const admins = list.filter((a) => a.principal === 'user' && a.role === 'admin' && a.userId).map((a) => a.userId!);
  const editors = new Set(hosted?.editors ?? []);
  const out: KbAccessDraft[] = [];
  if (mode === 'workspace') {
    const was = list.find((a) => a.principal === 'workspace')?.role ?? 'reader';
    out.push({ principal: 'workspace', role: was === 'admin' ? 'admin' : hosted ? (hosted.workspaceEdits ? 'editor' : 'reader') : was === 'editor' ? 'reader' : was });
  }
  for (const id of admins) out.push({ principal: 'user', userId: id, role: 'admin' });
  if (mode === 'people') for (const id of [...new Set(people)]) if (!admins.includes(id)) out.push({ principal: 'user', userId: id, role: hosted && editors.has(id) ? 'editor' : 'reader' });
  if (mode === 'workspace' && hosted) for (const id of editors) if (!admins.includes(id)) out.push({ principal: 'user', userId: id, role: 'editor' });
  return out;
}

// who may create, rename, move and delete folders: a KB hosted by Quorum while the caller may write it (its editors
// and admins on a paid plan), and any other KB's admins
export const canArrange = (kb: Pick<Kb, 'role' | 'hosted' | 'writable'>): boolean => (kb.hosted ? !!kb.writable : kb.role === 'admin');

export const KIND_LABEL: Record<Kb['kind'], string> = { general: 'General', meetings: 'Meetings' };

// a GitHub repository address the import can take; the reason is the sentence to show
// the import form's address check, with the same parser the import runs (ee/githubUrl.js); a /tree/<branch>/<folder>
// address imports that folder
export function checkGithubUrl(url: string): { url: string } | { error: string } {
  const u = url.trim();
  if (!u) return { error: 'Paste the repository address.' };
  if (parseGithubUrl(u).error) return { error: 'Use an address like https://github.com/your-team/handbook.' };
  return { url: u.replace(/\/$/, '') };
}

const PHASE: Record<KbImportProgress['phase'], string> = { fetching: 'Downloading', reading: 'Reading files', writing: 'Saving notes', done: 'Finishing' };
// one line for an import in progress
export function progressLabel(p: KbImportProgress | null): string {
  if (!p) return 'Starting the import…';
  const of = p.total > 0 && p.phase !== 'fetching' ? ` ${Math.min(p.done, p.total)} of ${p.total}` : '';
  return `${PHASE[p.phase] ?? 'Working'}${of}…`;
}
// the share done, 0 to 1, or null when the total is not known yet
export const progressShare = (p: KbImportProgress | null): number | null => (p && p.total > 0 && p.phase !== 'fetching' ? Math.max(0, Math.min(1, p.done / p.total)) : null);

// the parts of a sync result about notes edited in Quorum
function editParts(kept: number, suggested: number, noun: 'note' | 'file'): string[] {
  const out: string[] = [];
  if (kept) out.push(`kept ${kept} edited ${kept === 1 ? `${noun} as it is` : `${noun}s as they are`}`);
  if (suggested) out.push(`kept ${suggested} ${suggested === 1 ? 'edit' : 'edits'} as ${suggested === 1 ? 'a suggestion' : 'suggestions'} on the new text`);
  return out;
}

// the result of an import as a headline and the skipped files to list (the first `limit`, then a count of the rest)
// kept counts notes edited in Quorum that stayed as they were because the source had not changed; suggested counts
// edits kept as suggestions because it had (ee/kbUpstream.js)
export function importSummary(r: Pick<KbImportResult, 'imported' | 'skipped'> & { removed?: number; kept?: number; suggested?: number }, limit = 20): { headline: string; skipped: KbImportSkipped[]; more: number } {
  const n = r.imported ?? 0;
  const skipped = r.skipped ?? [];
  const removed = r.removed ?? 0;
  const parts = [`Imported ${n} ${n === 1 ? 'note' : 'notes'}`];
  if (removed) parts.push(`removed ${removed} ${removed === 1 ? 'note' : 'notes'} the source no longer has`);
  parts.push(...editParts(r.kept ?? 0, r.suggested ?? 0, 'note'));
  if (skipped.length) parts.push(`skipped ${skipped.length} ${skipped.length === 1 ? 'file' : 'files'}`);
  return { headline: `${parts.join(', ')}.`, skipped: skipped.slice(0, limit), more: Math.max(0, skipped.length - limit) };
}

// where a KB's notes come from, in one line for the admin list; null when it has no source
export function sourceLine(s: KbSource | null): string | null {
  if (!s) return null;
  const repo = (u: string | null) => (u ?? '').replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
  if (s.kind === 'github') return `GitHub ${repo(s.url) || 'repository'}${s.subpath ? `/${s.subpath.replace(/^\/+|\/+$/g, '')}` : ''}${s.branch ? ` (${s.branch})` : ''}`;
  if (s.kind === 'hosted') return 'Hosted by Quorum';
  if (s.kind === 'zip') return `Zip ${s.name ?? (s.path ?? '').replace(/^.*\//, '')}`.trim();
  if (s.kind === 'git') return `Repository ${(s.url ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, '')}${s.branch ? ` (${s.branch})` : ''}`.trim();
  return `Folder ${(s.path ?? '').replace(/^\/Users\/[^/]+/, '~')}`.trim();
}

const compareRank = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const stripMd = (p: string) => p.replace(/\.md$/i, '');
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// a/./b/../c as a/c; a path that climbs above the top resolves to null
function normalize(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

// the note a [[link]] in `from` points at, among the KB notes loaded on this Mac. A link matches whole path segments:
// the exact path relative to the linking note, the exact path from the KB's top, a path that ends in the link's
// segments, or (for a bare name) a note whose file name is the link. The exact relative path wins; after it, a note in
// the same folder as `from`, then one in the same KB, then the closer kind of match, then the first by path
export function resolveKbLink<N extends Pick<KbNote, 'id' | 'path' | 'folderId'>>(
  target: string, from: { kbId: string; note: Pick<KbNote, 'path' | 'folderId'> | null }, byKb: Record<string, N[]>,
): { kbId: string; note: N } | null {
  const raw = stripMd(target.split('|')[0].split('#')[0].trim().replace(/\\/g, '/')).toLowerCase();
  if (!raw.replace(/[./]/g, '')) return null;
  const fromDir = from.note ? dirOf(stripMd(from.note.path).toLowerCase()) : '';
  const relative = normalize(fromDir ? `${fromDir}/${raw}` : raw);
  // from the top of the KB, a link that climbs (../) only matches relative to the linking note
  const t = normalize(raw);
  if (relative === null && t === null) return null;
  const bare = !raw.includes('/');
  let best: { kbId: string; note: N; rank: number[] } | null = null;
  for (const [kbId, notes] of Object.entries(byKb)) {
    for (const n of notes) {
      const p = stripMd(n.path).toLowerCase();
      const how = p === relative ? 0 : t === null || raw.startsWith('..') ? -1 : p === t ? 1 : p.endsWith(`/${t}`) ? 2 : bare && p.slice(p.lastIndexOf('/') + 1) === t ? 3 : -1;
      if (how === -1) continue;
      const sameFolder = kbId === from.kbId && !!from.note && (n.folderId ?? null) === (from.note.folderId ?? null);
      const rank = [how === 0 ? 0 : 1, sameFolder ? 0 : 1, kbId === from.kbId ? 0 : 1, how];
      if (!best || compareRank(rank, best.rank) < 0 || (compareRank(rank, best.rank) === 0 && n.path < best.note.path)) best = { kbId, note: n, rank };
    }
  }
  return best ? { kbId: best.kbId, note: best.note } : null;
}

// Google Drive files (ee/src/KbDrive.tsx): the folders a picked file can go into, nested by depth, top level first
export function folderChoices(kb: Kb): { id: string | null; label: string }[] {
  const out: { id: string | null; label: string }[] = [{ id: null, label: `${kb.name} (top level)` }];
  const walk = (nodes: KbFolderNode[], depth: number) => { for (const n of nodes) { out.push({ id: n.id, label: `${'\u2003'.repeat(depth)}${n.name}` }); walk(n.children, depth + 1); } };
  walk(kb.folders, 0);
  return out;
}

// where a file sits, as the folder path inside the KB, or the KB's top level
export function folderLabel(kb: Kb, folderId: string | null | undefined): string {
  if (!folderId) return `${kb.name} (top level)`;
  const segs = folderPath(kb.folders, folderId);
  return segs.length ? segs.join(' / ') : kb.name;
}

// the line after an add or a sync: how many files were written, and what was skipped
export function driveSummary(verb: string, n: number, skipped: KbImportSkipped[], unchanged = 0, kept = 0, suggested = 0): { headline: string; skipped: KbImportSkipped[] } {
  const parts = [`${verb} ${n} ${n === 1 ? 'file' : 'files'} from Google Drive`];
  if (unchanged) parts.push(`${unchanged} unchanged since the last sync`);
  parts.push(...editParts(kept, suggested, 'file'));
  if (skipped.length) parts.push(`skipped ${skipped.length}`);
  return { headline: `${parts.join(', ')}.`, skipped };
}
