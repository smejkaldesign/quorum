// GitHub for the sync worker: a repository, or one folder in it, on one branch (the default branch when none is set),
// read with the GitHub App's user token of the admin who attached it, so private repositories the app is installed on
// sync too. The change marker is the branch's head commit: an unchanged head ends the run after one call. Each markdown
// file keeps its blob sha as kb_source_sha, so only the files that changed are read. kb_source is the file's address on
// GitHub, the same one app/ee/kbImport.js writes for a public import.
import { call, SyncError } from '../http.js';

const API = 'https://api.github.com';
const MARKDOWN = /\.(md|markdown)$/i;
export const MAX_FILES = 2000;

// a rate limit: 429, or a 403 that is GitHub's primary limit (no requests left), its secondary limit or abuse detection
// (a Retry-After header, or a body that says so). Any other 403 is an access answer
const limited = async (r) => {
  if (r.status === 429) return true;
  if (r.status !== 403) return false;
  if (r.headers?.get?.('x-ratelimit-remaining') === '0' || r.headers?.get?.('retry-after')) return true;
  try { const t = JSON.stringify(await r.clone().json()); return /secondary rate limit|abuse/i.test(t); } catch { return false; }
};
const failure = (r, what = 'The repository') => {
  if (r.status === 401) return new SyncError('GitHub no longer accepts this connection. Attach it again to keep it in sync.', 'auth', { status: r.status });
  // 404 is GitHub's answer for a repository that is gone and for one the app cannot see; a 403 that is no rate limit is
  // an access refusal. Neither removes notes: the worker keeps them and asks an admin to look
  if (r.status === 404) return new SyncError(`${what} was not found, or the GitHub App cannot read it. Check the app's repository access.`, 'gone', { status: r.status });
  if (r.status === 403) return new SyncError('GitHub refused access to the repository. Check the GitHub App\'s repository access.', 'access', { status: r.status });
  return new SyncError('GitHub refused the request. The sync runs again later.', 'provider', { status: r.status });
};
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export const github = {
  id: 'github',
  where: 'GitHub',
  sourceOf: (file) => file.url,
  unchanged: (note, file) => !!file.sha && note.frontmatter?.kb_source_sha === file.sha,

  async list({ token, attachment, cursor, fetchImpl, sleep }) {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'quorum-relay', 'x-github-api-version': '2022-11-28' };
    const get = (url) => call(fetchImpl, url, { headers }, { limited, label: 'GitHub', sleep });
    const json = async (r, what) => { if (!r.ok) throw failure(r, what); const b = await r.json().catch(() => null); if (!b) throw new SyncError('GitHub sent an answer Quorum could not read.', 'provider'); return b; };
    const repo = attachment.remote_id;
    const sub = String(attachment.options?.path ?? '').replace(/^\/+|\/+$/g, '');
    let branch = attachment.options?.branch ?? null;
    if (!branch) branch = (await json(await get(`${API}/repos/${enc(repo)}`))).default_branch || 'main';
    const head = await json(await get(`${API}/repos/${enc(repo)}/branches/${enc(branch)}`), `The branch ${branch}`);
    const sha = head?.commit?.sha;
    if (!sha) throw new SyncError('GitHub sent an answer Quorum could not read.', 'provider');
    if (cursor?.sha === sha && cursor?.complete) return { unchanged: true, cursor };
    const tree = await json(await get(`${API}/repos/${enc(repo)}/git/trees/${sha}?recursive=1`));
    const files = [];
    let complete = !tree.truncated;
    for (const e of tree.tree ?? []) {
      if (e.type !== 'blob' || !MARKDOWN.test(e.path)) continue;
      if (sub && !e.path.startsWith(`${sub}/`)) continue;
      const rel = sub ? e.path.slice(sub.length + 1) : e.path;
      const parts = rel.split('/');
      if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) continue;
      if (files.length >= MAX_FILES) { complete = false; break; }
      files.push({ remoteId: e.path, name: parts.at(-1), segs: parts.slice(0, -1), sha: e.sha, size: Number(e.size) || 0, url: `https://github.com/${repo}/blob/${branch}/${e.path}` });
    }
    return { files, complete, cursor: { sha, branch, complete } };
  },

  async read({ token, attachment, file, fetchImpl, sleep }) {
    if (file.size > 5 * 1024 * 1024) throw new SyncError('The file is larger than 5 MB.', 'size');
    const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'quorum-relay', 'x-github-api-version': '2022-11-28' };
    const r = await call(fetchImpl, `${API}/repos/${enc(attachment.remote_id)}/git/blobs/${file.sha}`, { headers }, { limited, label: 'GitHub', sleep });
    if (!r.ok) throw failure(r, 'The file');
    const b = await r.json().catch(() => null);
    if (typeof b?.content !== 'string') throw new SyncError('GitHub sent an answer Quorum could not read.', 'provider');
    const buf = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8');
    if (buf.length > 5 * 1024 * 1024) throw new SyncError('The file is larger than 5 MB.', 'size');
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  },
};
