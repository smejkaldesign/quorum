// Which of Quorum's connectors the person's agent can already reach through the provider's own MCP server. Read only:
// the vault's .mcp.json, ~/.claude.json (user scope, and project scope for the Agent OS folder) and the output of
// `claude mcp list`. Nothing here writes a config or adds a server. Only the server name, command, args and URL are
// read, plus Claude Code's on and off switches for those servers; env and headers are never read, and any arg or URL
// part that looks like a token is replaced before it leaves this file. Settings > Connections and the Agent OS step in
// onboarding show the result (connectors/library.js mcpPathsOf has what each path gives). Pure Node with injectable
// readers, so the tests run on fixture configs.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeRun } from '../claudeCli.js';

// a provider matches by server name, then by URL host, then by a package name in the command and args (an npm or PyPI
// package, a Docker image, or the repository in a git URL). Names are matched as whole words so "linear" does not
// match "nonlinear"; a path argument such as a folder to serve is never read as a package
const word = (w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i');
export const MCP_PROVIDERS = {
  granola: { names: [word('granola')], hosts: ['granola.ai'], packages: [/granola/i] },
  notion: { names: [word('notion')], hosts: ['notion.com', 'notion.so'], packages: [/@notionhq\/notion-mcp-server/i, /notion-mcp/i] },
  slack: { names: [word('slack')], hosts: ['slack.com'], packages: [/server-slack/i, /slack-mcp/i] },
  'google-drive': { names: [/google[-_ ]?drive/i, word('gdrive')], hosts: ['drive.google.com', 'drive.googleapis.com'], packages: [/server-gdrive/i, /google-drive-mcp/i, /gdrive-mcp/i] },
  'google-calendar': { names: [/google[-_ ]?calendar/i, word('gcal')], hosts: ['calendar.google.com', 'calendar.googleapis.com'], packages: [/google-calendar-mcp/i, /gcal-mcp/i] },
  github: { names: [word('github')], hosts: ['github.com', 'api.githubcopilot.com'], packages: [/server-github/i, /github-mcp-server/i] },
  zoom: { names: [word('zoom')], hosts: ['zoom.us'], packages: [/zoom-mcp/i] },
  linear: { names: [word('linear')], hosts: ['linear.app'], packages: [/linear-mcp/i] },
};

// a flag whose value is a secret, and the token shapes providers hand out
const SECRET_FLAG = /token|secret|passw|api[-_]?key|apikey|auth|bearer|credential|(^|[-_])pat($|[-_])/i;
const HEADER_FLAG = /^(-H|--header|--headers)$/i;
const TOKEN_SHAPES = [
  /^(sk|pk|rk)[-_][\w-]{8,}/, /^gh[pousr]_\w{8,}/, /^github_pat_\w+/, /^xox[abposr]-[\w-]+/, /^lin_(api|oauth)_\w+/, /^ntn_\w+/, /^secret_\w{8,}/,
  /^ya29\.[\w.-]+/, /^eyJ[\w-]+\.[\w-]+/, /^Bearer\s+\S+/i, /^Basic\s+\S+/i,
];
const REDACTED = '<redacted>';
export function looksLikeToken(s) {
  const t = String(s ?? '').trim();
  if (!t) return false;
  if (TOKEN_SHAPES.some((re) => re.test(t))) return true;
  // a long run of letters and digits with no path or dot structure, holding both
  return /^[A-Za-z0-9_-]{32,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t);
}
// a URL without its user info and query string, and with any path segment that looks like a token replaced
export function redactUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    const segs = u.pathname.split('/').map((s) => (looksLikeToken(decodeURIComponent(s)) ? REDACTED : s)).join('/');
    return `${u.protocol}//${u.host}${segs}`;
  } catch { return looksLikeToken(url) ? REDACTED : String(url); }
}
// args with secrets replaced: the value after a secret or header flag, the value of --flag=secret, a KEY=value pair
// with a secret-sounding key, and anything shaped like a token
export function redactArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const prev = list[i - 1];
    if (prev !== undefined && /^--?[\w-]+$/.test(prev) && (SECRET_FLAG.test(prev) || HEADER_FLAG.test(prev))) { out.push(REDACTED); continue; }
    const eq = a.match(/^(--?[\w-]+|[A-Za-z_][\w-]*)=(.*)$/);
    if (eq && (SECRET_FLAG.test(eq[1]) || looksLikeToken(eq[2]))) { out.push(`${eq[1]}=${REDACTED}`); continue; }
    if (/^https?:\/\//i.test(a)) { out.push(redactUrl(a)); continue; }
    if (/^[\w-]+:\s*\S/.test(a) && SECRET_FLAG.test(a.split(':')[0])) { out.push(`${a.split(':')[0]}: ${REDACTED}`); continue; }
    out.push(looksLikeToken(a) ? REDACTED : a);
  }
  return out;
}

// one server as this file keeps it: the four read fields, already redacted, and where it was found
const entry = (name, v, where) => ({ name: String(name), url: redactUrl(v?.url ?? null), command: v?.command ? (looksLikeToken(v.command) ? REDACTED : String(v.command)) : null, args: redactArgs(v?.args), where });

const norm = (p) => path.resolve(String(p)).replace(/\/+$/, '');
// ~/.claude.json: user scope at the top, and project scope only for the Agent OS folder (root or vault)
export function claudeConfigServers(text, folders = []) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const out = Object.entries(j?.mcpServers ?? {}).map(([n, v]) => entry(n, v, 'claude-user'));
  const want = new Set(folders.filter(Boolean).map(norm));
  for (const [project, p] of Object.entries(j?.projects ?? {})) {
    if (!want.has(norm(project))) continue;
    for (const [n, v] of Object.entries(p?.mcpServers ?? {})) out.push(entry(n, v, 'claude-project'));
  }
  return out;
}
// the vault's .mcp.json, the project-shared config Claude Code reads in that folder
export function mcpJsonServers(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  return Object.entries(j?.mcpServers ?? {}).map(([n, v]) => entry(n, v, 'vault'));
}
// Claude Code's switches for the servers it reads: a .mcp.json server runs once it is approved (enableAllProjectMcpServers
// or enabledMcpjsonServers) and not in disabledMcpjsonServers; any server named in a folder's disabledMcpServers is off
// there. They live in ~/.claude.json per project and in the folder's .claude/settings.json and settings.local.json.
// Only these keys are read
export function switchesOf(texts) {
  const out = { enableAll: false, enabled: new Set(), disabled: new Set(), off: new Set() };
  for (const t of texts) {
    let j; try { j = typeof t === 'string' ? JSON.parse(t) : t; } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if (j.enableAllProjectMcpServers === true) out.enableAll = true;
    for (const n of Array.isArray(j.enabledMcpjsonServers) ? j.enabledMcpjsonServers : []) out.enabled.add(String(n));
    for (const n of Array.isArray(j.disabledMcpjsonServers) ? j.disabledMcpjsonServers : []) out.disabled.add(String(n));
    for (const n of Array.isArray(j.disabledMcpServers) ? j.disabledMcpServers : []) out.off.add(String(n));
  }
  return out;
}
// whether one configured server counts: a vault server needs approval and no disable; any server can be switched off
export function isOn(server, sw) {
  if (sw.off.has(server.name)) return false;
  if (server.where !== 'vault') return true;
  if (sw.disabled.has(server.name)) return false;
  return sw.enableAll || sw.enabled.has(server.name);
}
// the project entries of ~/.claude.json for the Agent OS folder, for their switches
export function claudeProjectEntries(text, folders = []) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const want = new Set(folders.filter(Boolean).map(norm));
  return Object.entries(j?.projects ?? {}).filter(([k]) => want.has(norm(k))).map(([, v]) => v);
}

// `claude mcp list`: one "name: target - status" line per server. The name can hold colons (plugin:x:y) but no
// ": ", so the first ": " ends it. Whatever follows the last " - " is the status, in any wording. A URL target ends in
// "(HTTP)" or "(SSE)"; anything else is a command and its args
export function mcpListServers(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(.+?): (.+) - (\S.*)$/u);
    if (!m || /^\[/.test(line)) continue;
    const target = m[2].replace(/\s+\((HTTP|SSE|stdio)\)\s*$/i, '').trim();
    if (/^https?:\/\//i.test(target)) out.push(entry(m[1], { url: target }, 'claude-list'));
    else { const [command, ...args] = target.split(/\s+/); out.push(entry(m[1], { command, args }, 'claude-list')); }
  }
  return out;
}

const hostOf = (url) => { try { return new URL(String(url)).host.toLowerCase(); } catch { return null; } };
const hostIs = (host, d) => !!host && (host === d || host.endsWith(`.${d}`));
const isGitUrl = (a) => /^git\+/i.test(a) || /^(https?|ssh|git):\/\/.+\.git$/i.test(a) || /^git@[^:]+:.+/.test(a);
const isPath = (a) => /^[/~.]/.test(a) || a.includes('\\');
const NPM = /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~<>=*-]+)?$/;
const IMAGE = /^([\w.-]+(:\d+)?\/)*[\w.-]+(:[\w.-]+)?(@sha256:[a-f0-9]+)?$/;
const RUNNERS = /^(npx|npm|pnpm|bunx|bun|uvx|uv|pipx|python3?|node|deno|docker|podman)$/i;
// the package names a server runs: npm and PyPI names (without a version), Docker images for docker and podman, and
// the repository name of a git URL. Flags, paths and plain URLs are left out
export function packagesOf(server) {
  const cmd = server.command ?? '';
  // a launcher (npx, uvx, node, docker and the like) is not a package; a bare command such as granola-mcp is
  const base = isPath(cmd) || RUNNERS.test(cmd) ? '' : cmd;
  const docker = /^(docker|podman)$/i.test(path.basename(cmd));
  const out = [];
  if (base && NPM.test(base)) out.push(base);
  for (const raw of server.args ?? []) {
    const a = String(raw).replace(/^--?[\w-]+=/, (f) => (/^--?(from|with|package)=/.test(f) ? '' : f));
    if (/^-/.test(a) || a === '<redacted>') continue;
    if (isGitUrl(a)) { const seg = a.replace(/\.git$/i, '').split(/[/:]/).filter(Boolean).pop(); if (seg) out.push(seg); continue; }
    if (/^[a-z]+:\/\//i.test(a) || isPath(a)) continue;
    if (docker && a.includes('/') ? IMAGE.test(a) : NPM.test(a) && (!a.includes('/') || a.startsWith('@'))) out.push(a.replace(/(.)@[^/]*$/, '$1'));
  }
  return out;
}

// the connector id a server is for, or null. Server names are checked across every provider first, then URL hosts,
// then package names, so a server named for one provider is never claimed by another's host or package. Quorum's own
// server is never a match
export function providerOf(server) {
  if (!server || /^quorum$/i.test(server.name)) return null;
  const all = Object.entries(MCP_PROVIDERS);
  const byName = all.find(([, p]) => p.names.some((re) => re.test(server.name)));
  if (byName) return byName[0];
  const hosts = [hostOf(server.url), ...(server.args ?? []).filter((a) => !isGitUrl(String(a))).map(hostOf)].filter(Boolean);
  const byHost = all.find(([, p]) => p.hosts.some((d) => hosts.some((h) => hostIs(h, d))));
  if (byHost) return byHost[0];
  const pkgs = packagesOf(server);
  const byPkg = all.find(([, p]) => p.packages.some((re) => pkgs.some((n) => re.test(n))));
  return byPkg ? byPkg[0] : null;
}

// every match, by connector id. The same server name found in several places is one entry with every place listed
export function matchServers(servers) {
  const out = {};
  for (const s of servers) {
    const id = providerOf(s);
    if (!id) continue;
    const list = (out[id] ??= []);
    const same = list.find((x) => x.name === s.name);
    if (same) { if (!same.where.includes(s.where)) same.where.push(s.where); continue; }
    list.push({ name: s.name, url: s.url, command: s.command, args: s.args, where: [s.where] });
  }
  return out;
}

const tryRead = (readFile, f) => { try { return readFile(f); } catch { return null; } };
// the config files for one folder: the servers that count, the ones set up but turned off, and which files were read
export function readConfigs({ root = null, vault = null, home = homedir(), readFile = (f) => readFileSync(f, 'utf8') } = {}) {
  const folders = [...new Set([root, vault].filter(Boolean))];
  const read = { claudeConfig: false, vault: false };
  const servers = [];
  const claude = tryRead(readFile, path.join(home, '.claude.json'));
  if (claude !== null) { read.claudeConfig = true; servers.push(...claudeConfigServers(claude, folders)); }
  for (const dir of folders) {
    const t = tryRead(readFile, path.join(dir, '.mcp.json'));
    if (t !== null) { read.vault = true; servers.push(...mcpJsonServers(t)); }
  }
  const sw = switchesOf([...(claude ? claudeProjectEntries(claude, folders) : []), ...folders.flatMap((d) => ['settings.json', 'settings.local.json'].map((f) => tryRead(readFile, path.join(d, '.claude', f)))).filter((t) => t !== null)]);
  return { read, on: servers.filter((s) => isOn(s, sw)), off: servers.filter((s) => !isOn(s, sw)) };
}

// files plus the last `claude mcp list` into one answer. A server the files turn off at every place they name it is
// left out of the list's servers too, since the list does not know the folder's switches
export function combine(files, list) {
  const onNames = new Set(files.on.map((s) => s.name));
  const offOnly = new Set(files.off.map((s) => s.name).filter((n) => !onNames.has(n)));
  const listed = (list?.servers ?? []).filter((s) => !offOnly.has(s.name));
  const matches = matchServers([...listed, ...files.on]);
  const offAll = matchServers(files.off.filter((s) => offOnly.has(s.name)));
  const off = Object.fromEntries(Object.entries(offAll).filter(([id]) => !matches[id]));
  return {
    at: files.at,
    read: { claudeList: list?.status === 'done', claudeConfig: files.read.claudeConfig, vault: files.read.vault },
    listing: list?.status === 'running',
    claudeMissing: list?.status === 'missing',
    matches,
    off,
  };
}

// a pass per key: one runs at a time. A settled pass writes the cache only while its key is still the current one, and
// a refresh asked for during a pass queues one follow-up pass, whose answer the waiting callers get
export function createPassCache(run) {
  let key = null; let last = null; let pending = null; let again = false;
  const start = (opts, k) => {
    const p = Promise.resolve().then(() => run(opts)).then((r) => {
      if (key !== k || pending !== p) return r;
      if (again) { again = false; pending = start(opts, k); return pending; }
      last = r; pending = null; return r;
    }, (e) => { if (key === k && pending === p) { pending = null; again = false; } throw e; });
    return p;
  };
  return (opts = {}, { refresh = false } = {}) => {
    const k = `${opts.root ?? ''}|${opts.vault ?? ''}`;
    if (k !== key) { key = k; last = null; again = false; pending = start(opts, k); return pending; }
    if (pending) { if (refresh) again = true; return pending; }
    if (last && !refresh) return Promise.resolve(last);
    pending = start(opts, k);
    return pending;
  };
}

// `claude mcp list` checks each server's health by starting it, so it runs once per session in the background and
// again only when the person asks (Check again); it never changes the config
const listRun = async () => {
  const r = await claudeRun(['mcp', 'list'], { timeout: 60000 });
  if (r.missing) return { status: 'missing', servers: [] };
  const servers = mcpListServers(r.out);
  return r.ok || servers.length ? { status: 'done', servers } : { status: 'failed', servers: [] };
};

// the detection the main process holds for the session. get reads the files (again on refresh) and starts the one
// background list; check runs the list again and waits for it. onChange fires when a background list lands
export function createOverlap({ home = homedir(), readFile = (f) => readFileSync(f, 'utf8'), list = listRun, onChange = () => {} } = {}) {
  const files = createPassCache((opts) => ({ ...readConfigs({ ...opts, home, readFile }), at: new Date().toISOString() }));
  let listed = null; let listing = null;
  const runList = () => {
    listed = { status: 'running', servers: listed?.servers ?? [] };
    listing = Promise.resolve().then(list).catch(() => ({ status: 'failed', servers: [] })).then((r) => { listed = r; listing = null; return r; });
    return listing;
  };
  return {
    async get(opts = {}, { refresh = false } = {}) {
      if (!listed) runList().then(() => onChange());
      return combine(await files(opts, { refresh }), listed);
    },
    async check(opts = {}) {
      await (listing ?? runList());
      return combine(await files(opts, { refresh: true }), listed);
    },
  };
}
