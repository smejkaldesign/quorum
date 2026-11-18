// GitHub read tools with the person's GitHub App user token: the repositories across their installations, code search
// limited to those repositories, and one text file at a path and ref.
import { ProviderError, readJson, request } from './http.js';

const API = 'https://api.github.com';
export const MAX_FILE_BYTES = 200 * 1024;
// GitHub rejects a search query longer than this
const MAX_QUERY = 256;
const RECONNECT = 'GitHub needs to be connected again. In Quorum, open Settings > Connectors > GitHub, choose Disconnect, then Connect.';
const NOT_INSTALLED = (repo) => `The Quorum GitHub App is not installed on ${repo}. Add the repository under Settings > Connectors > GitHub, Manage repositories.`;

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function createGithub({ token, fetchImpl, wait }) {
  async function call(route, { accept = 'application/vnd.github+json' } = {}) {
    const r = await request('GitHub', `${API}${route}`, { headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'Quorum' } }, { fetchImpl, wait });
    const data = await readJson(r);
    if (r.status === 401) throw new ProviderError(RECONNECT, { code: 'reauth', status: 401 });
    if (r.status === 404) throw new ProviderError('GitHub found nothing there, or the Quorum GitHub App is not installed on that repository.', { code: 'not_found', status: 404 });
    if (r.status === 422) throw new ProviderError(`GitHub could not run that search: ${data?.message ?? 'the query is not valid'}.`, { status: 422 });
    if (!r.ok || !data) throw new ProviderError(`GitHub refused the request (${r.status}).`, { status: r.status });
    return data;
  }

  async function installations() {
    return (await call('/user/installations?per_page=100')).installations ?? [];
  }

  async function reposOf(inst) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const d = await call(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
      out.push(...(d.repositories ?? []));
      if ((d.repositories ?? []).length < 100) break;
    }
    return out;
  }

  async function installed() {
    const list = await installations();
    const repos = [];
    for (const inst of list) for (const r of await reposOf(inst)) repos.push(r);
    return { list, repos };
  }

  return {
    async repos() {
      const { repos } = await installed();
      return { repos: repos.map((r) => ({ repo: r.full_name, private: !!r.private, defaultBranch: r.default_branch ?? null, description: r.description ?? null, link: r.html_url ?? null })) };
    },
    async searchCode({ query, repo, limit }) {
      const q = String(query ?? '').trim();
      if (!q) throw new ProviderError('query is required.');
      const { list, repos } = await installed();
      const names = new Set(repos.map((r) => r.full_name.toLowerCase()));
      if (!names.size) throw new ProviderError('The Quorum GitHub App is not installed on any repository yet. Install it under Settings > Connectors > GitHub, Manage repositories.');
      let scope;
      if (repo) {
        if (!names.has(String(repo).toLowerCase())) throw new ProviderError(NOT_INSTALLED(repo));
        scope = [`repo:${repo}`];
      } else {
        const owner = (i) => `${i.account?.type === 'Organization' ? 'org' : 'user'}:${i.account?.login}`;
        const exact = list.flatMap((i) => (i.repository_selection === 'all' ? [owner(i)] : repos.filter((r) => r.owner?.login === i.account?.login).map((r) => `repo:${r.full_name}`)));
        scope = `${q} ${exact.join(' ')}`.length <= MAX_QUERY ? exact : [...new Set(list.map(owner))];
      }
      const d = await call(`/search/code?q=${encodeURIComponent(`${q} ${scope.join(' ')}`)}&per_page=${clamp(limit, 1, 50, 20)}`, { accept: 'application/vnd.github.text-match+json' });
      // the owner qualifiers can reach repositories the app is not installed on; those are dropped
      const items = (d.items ?? []).filter((i) => names.has(String(i.repository?.full_name).toLowerCase()));
      return {
        total: d.total_count ?? items.length,
        results: items.map((i) => ({ repo: i.repository.full_name, path: i.path, link: i.html_url ?? null, lines: (i.text_matches ?? []).map((m) => m.fragment).filter(Boolean) })),
      };
    },
    async file({ repo, path: p = '', ref }) {
      if (!REPO.test(String(repo ?? ''))) throw new ProviderError('repo must be owner/name.');
      const clean = String(p ?? '').replace(/^\/+|\/+$/g, '');
      if (clean.split('/').some((s) => s === '..')) throw new ProviderError('path cannot go above the repository.');
      const route = `/repos/${repo}/contents/${clean.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
      const d = await call(route);
      if (Array.isArray(d)) return { repo, path: clean, ref: ref ?? null, entries: d.map((e) => ({ name: e.name, type: e.type, path: e.path, size: e.type === 'file' ? e.size : null })) };
      if (d.type !== 'file') throw new ProviderError(`${clean} is a ${d.type ?? 'link'}, so Quorum does not read it.`);
      if ((d.size ?? 0) > MAX_FILE_BYTES || !d.content) throw new ProviderError(`${clean} is ${Math.round((d.size ?? 0) / 1024)} KB. Quorum reads files up to ${MAX_FILE_BYTES / 1024} KB.`);
      const bytes = Buffer.from(String(d.content), d.encoding === 'base64' ? 'base64' : 'utf8');
      let text;
      try { if (bytes.includes(0)) throw new Error('binary'); text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ProviderError(`${clean} is a binary file, so Quorum does not read it.`); }
      return { repo, path: d.path ?? clean, ref: ref ?? null, size: d.size ?? bytes.length, link: d.html_url ?? null, text };
    },
  };
}
