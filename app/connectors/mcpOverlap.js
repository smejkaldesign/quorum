// Which of Quorum's connectors the person's agent can already reach through the provider's own MCP server. Read only:
// the vault's .mcp.json, ~/.claude.json (user scope, and project scope for the Agent OS folder) and the output of
// `claude mcp list`. Nothing here writes a config or adds a server. Only the server name, command, args and URL are
// read; env and headers are never read, and any arg or URL part that looks like a token is replaced before it leaves
// this file. Settings > Connections and the Agent OS step in onboarding show the result (connectors/library.js
// mcpPathsOf has what each path gives). Pure Node with injectable readers, so the tests run on fixture configs.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// a provider matches by server name, by URL host, or by a package or image name in the command and args. Names are
// matched as whole words so "linear" does not match "nonlinear"
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
// `claude mcp list`: one "name: target - status" line per server. The name can hold colons (plugin:x:y) but no
// ": ", so the first ": " ends it. A URL target ends in "(HTTP)" or "(SSE)"; anything else is a command and its args
export function mcpListServers(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = raw.trim().match(/^(.+?): (.+) - [✓✔✗✘!×].*$/u);
    if (!m) continue;
    const target = m[2].replace(/\s+\((HTTP|SSE|stdio)\)\s*$/i, '').trim();
    if (/^https?:\/\//i.test(target)) out.push(entry(m[1], { url: target }, 'claude-list'));
    else { const [command, ...args] = target.split(/\s+/); out.push(entry(m[1], { command, args }, 'claude-list')); }
  }
  return out;
}

const hostOf = (url) => { try { return new URL(String(url)).host.toLowerCase(); } catch { return null; } };
const hostIs = (host, d) => !!host && (host === d || host.endsWith(`.${d}`));
// the connector id a server is for, or null. Quorum's own server is never a match
export function providerOf(server) {
  if (!server || /^quorum$/i.test(server.name)) return null;
  const host = hostOf(server.url);
  const argHosts = (server.args ?? []).map(hostOf).filter(Boolean);
  const cmd = [server.command ?? '', ...(server.args ?? [])].join(' ');
  for (const [id, p] of Object.entries(MCP_PROVIDERS)) {
    if (p.names.some((re) => re.test(server.name))) return id;
    if (p.hosts.some((d) => hostIs(host, d) || argHosts.some((h) => hostIs(h, d)))) return id;
    if (p.packages.some((re) => re.test(cmd))) return id;
  }
  return null;
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

// `claude mcp list` checks each server's health, so it can take a while; it never changes the config. The API key is
// left out so Claude Code lists the claude.ai connectors of the person's own sign-in
const listRun = () => new Promise((resolve) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  execFile('claude', ['mcp', 'list'], { env, timeout: 30000, maxBuffer: 1 << 20 }, (err, out) => resolve(err && !out ? null : String(out)));
});

// one detection pass. root and vault are the Agent OS folder; each source reports whether it could be read
export async function detectOverlap({ root = null, vault = null, home = homedir(), readFile = (f) => readFileSync(f, 'utf8'), list = listRun } = {}) {
  const servers = [];
  const read = { claudeList: false, claudeConfig: false, vault: false };
  const listed = await list().catch(() => null);
  if (listed) { read.claudeList = true; servers.push(...mcpListServers(listed)); }
  try { servers.push(...claudeConfigServers(readFile(path.join(home, '.claude.json')), [root, vault])); read.claudeConfig = true; } catch {}
  for (const dir of [...new Set([root, vault].filter(Boolean))]) {
    try { servers.push(...mcpJsonServers(readFile(path.join(dir, '.mcp.json')))); read.vault = true; } catch {}
  }
  return { at: new Date().toISOString(), read, matches: matchServers(servers) };
}

// the session cache: one pass at a time, kept until a refresh asks for a new one or the Agent OS folder changes
export function createOverlapCache(run = detectOverlap) {
  let last = null; let key = null; let pending = null;
  return (opts = {}, { refresh = false } = {}) => {
    const k = `${opts.root ?? ''}|${opts.vault ?? ''}`;
    if (pending && key === k) return pending;
    if (last && key === k && !refresh) return Promise.resolve(last);
    key = k;
    pending = run(opts).then((r) => { last = r; return r; }).finally(() => { pending = null; });
    return pending;
  };
}
