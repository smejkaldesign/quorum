// GitHub repository addresses, read the same way everywhere: the import (ee/kbImport.js), folder sync (ee/kbSync.js)
// and the renderer's checks (ee/src/kbTree.ts, ee/src/kbSyncUi.ts). Plain JavaScript with no imports, so the main
// process and the renderer share it; githubUrl.d.ts types it for the renderer.

export const ADDRESS = 'Enter a GitHub repository address, like https://github.com/owner/repository.';

// https://github.com/<owner>/<repo>, with an optional .git, trailing slash or /tree/<branch>[/<folder>]. Which part of
// the tree path is the branch is settled against the repository's branches (names can hold slashes) by resolveTree
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100})(?:\/tree\/([^?#]+?))?\/?$/;

export function checkBranch(b) {
  const s = String(b ?? '').trim();
  if (!s) return { branch: null };
  if (s.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(s) || s.startsWith('-') || s.startsWith('/') || s.endsWith('/') || s.endsWith('.lock') || s.includes('..') || s.includes('//')) return { error: 'That branch name is not valid.' };
  return { branch: s };
}

// the /tree/ part of an address: plain path segments, none of them "." or ".."
function checkTree(raw) {
  let s;
  try { s = decodeURIComponent(raw); } catch { return { error: ADDRESS }; }
  const segs = s.split('/');
  if (s.length > 500 || segs.some((p) => !p || p === '.' || p === '..' || /[\p{Cc}\\]/u.test(p))) return { error: ADDRESS };
  return { tree: segs.join('/') };
}

export function parseGithubUrl(url, branch) {
  const raw = String(url ?? '').trim();
  if (!raw) return { error: 'Enter the repository address.' };
  const m = raw.match(GITHUB);
  if (!m) return { error: ADDRESS };
  const repo = m[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return { error: ADDRESS };
  const b = checkBranch(branch);
  if (b.error) return b;
  const t = m[3] ? checkTree(m[3]) : { tree: null };
  if (t.error) return t;
  return { owner: m[1], repo, branch: b.branch, tree: t.tree, url: `https://github.com/${m[1]}/${repo}` };
}

// a /tree/ path split into the branch and the folder inside it. With a branch given, the path has to start with it.
// Otherwise the repository's branches that start with the path's first segment are asked for (request(url) answers a
// Response; it carries whatever credentials the caller has) and the longest one the path begins with is the branch.
// Resolves to { branch, path } or { error }; a rate limit or an unreachable GitHub is { error, code: 'limited' | 'network' }
export async function resolveTree({ owner, repo, tree, branch = null }, request) {
  if (!tree) return { branch, path: null };
  if (branch) {
    if (tree !== branch && !tree.startsWith(`${branch}/`)) return { error: 'The branch does not match the branch in the address.' };
    return { branch, path: tree === branch ? null : tree.slice(branch.length + 1) };
  }
  const first = tree.split('/')[0];
  let res;
  try { res = await request(`https://api.github.com/repos/${owner}/${repo}/git/matching-refs/heads/${encodeURIComponent(first)}`); }
  catch { return { error: 'GitHub could not be reached. Check your connection and try again.', code: 'network' }; }
  if (res.status === 403 || res.status === 429) return { error: 'GitHub is limiting requests from this network. Try again in an hour.', code: 'limited' };
  const names = res.ok ? ((await res.json().catch(() => [])) ?? []).map((r) => String(r?.ref ?? '').replace(/^refs\/heads\//, '')) : [];
  const match = names.filter((n) => n && (tree === n || tree.startsWith(`${n}/`))).sort((a, b) => b.length - a.length)[0];
  if (!match) return { error: 'The branch in that address was not found in the repository.' };
  return { branch: match, path: tree === match ? null : tree.slice(match.length + 1) };
}
