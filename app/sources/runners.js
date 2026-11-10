// The agent runners on this Mac and the MCP servers each one is configured with: Claude Code (~/.claude.json, user and
// project scope), Codex (~/.codex/config.toml, [mcp_servers.<name>] tables) and Antigravity (~/.gemini/config/
// mcp_config.json). A meeting source whose MCP server a runner already has can be imported through that runner as a
// fallback (sources/agent-import.js). Pure Node: the file readers and the PATH lookup are injectable for tests.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const RUNNERS = [
  { id: 'claude-code', name: 'Claude Code', bin: 'claude', config: '.claude.json' },
  { id: 'codex', name: 'Codex', bin: 'codex', config: '.codex/config.toml' },
  { id: 'antigravity', name: 'Antigravity', bin: 'agy', config: '.gemini/config/mcp_config.json' },
];

const hostOf = (url) => { try { return new URL(String(url)).host.toLowerCase(); } catch { return null; } };
const server = (name, v, scope = 'user', project = null) => ({ name, url: v?.url ?? null, command: v?.command ?? null, args: Array.isArray(v?.args) ? v.args : [], scope, project });

// ~/.claude.json: `mcpServers` at the top is user scope; each entry of `projects` carries its own
export function claudeServers(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const out = Object.entries(j?.mcpServers ?? {}).map(([n, v]) => server(n, v));
  for (const [project, p] of Object.entries(j?.projects ?? {})) for (const [n, v] of Object.entries(p?.mcpServers ?? {})) out.push(server(n, v, 'project', project));
  return out;
}

// ~/.codex/config.toml: one [mcp_servers.<name>] table per server with url = "..." or command = "..." and args = [...].
// A small reader for exactly that shape; anything else in the file is skipped
export function codexServers(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const head = line.match(/^\[mcp_servers\.([^\]\s.]+)(?:\.[^\]]*)?\]$/);
    if (head) { if (!cur || cur.name !== head[1]) { cur = { name: head[1].replace(/^"|"$/g, ''), url: null, command: null, args: [], scope: 'user', project: null }; out.push(cur); } continue; }
    if (/^\[/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^(url|command|args)\s*=\s*(.+)$/);
    if (!kv) continue;
    if (kv[1] === 'args') { try { cur.args = JSON.parse(kv[2].replace(/'/g, '"')); } catch { cur.args = []; } }
    else cur[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}

// ~/.gemini/config/mcp_config.json: the same mcpServers shape as Claude Code's user scope
export function antigravityServers(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  return Object.entries(j?.mcpServers ?? {}).map(([n, v]) => server(n, v));
}

const PARSERS = { 'claude-code': claudeServers, codex: codexServers, antigravity: antigravityServers };

// off the main thread: a login shell can take seconds when the shell init is slow
const onPath = (bin) => new Promise((resolve) => execFile('/bin/zsh', ['-lc', `command -v ${bin}`], { timeout: 5000 }, (err) => resolve(!err)));

// every runner whose binary is on PATH or whose config exists, with the servers it knows
export async function detectRunners({ home = homedir(), readFile = (f) => readFileSync(f, 'utf8'), exists = existsSync, which = onPath } = {}) {
  const out = [];
  for (const r of RUNNERS) {
    const file = path.join(home, r.config);
    const installed = await which(r.bin);
    const configured = exists(file);
    if (!installed && !configured) continue;
    let servers = [];
    if (configured) { try { servers = PARSERS[r.id](readFile(file)); } catch { servers = []; } }
    out.push({ ...r, installed, configured, servers });
  }
  return out;
}

// the runners that already have this source's MCP server (same host as the source's URL), each with the server name
// the runner uses for it, and whether the runner also has Quorum's own server (needed to write the notes back)
export function runnersWithSource(source, runners) {
  const host = hostOf(source?.url);
  if (!host) return [];
  const out = [];
  for (const r of runners) {
    const match = r.servers.find((s) => hostOf(s.url) === host || (s.command && `${s.command} ${s.args.join(' ')}`.toLowerCase().includes(host)));
    if (!match) continue;
    out.push({ id: r.id, name: r.name, installed: r.installed, server: match.name, scope: match.scope, project: match.project, hasQuorum: r.servers.some((s) => s.name === 'quorum') });
  }
  return out;
}
