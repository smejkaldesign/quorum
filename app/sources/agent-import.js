// Import through the person's own agent: the fallback for a meeting source the runner already has connected. The
// runner (Claude Code, Codex or Antigravity) runs headless with one task: list the source's meetings through its
// MCP server and write each one into Quorum through the quorum MCP server's import_meeting tool, which dedupes by
// source id. Claude Code and Codex get the quorum server added for the run; Antigravity has to carry it in its own
// config. The trade-offs are stated to the person before they choose it, in TRADEOFFS below, in plain words.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

export const SCHEDULES = ['off', 'hourly', 'daily'];
export const TIMEOUT_MS = 20 * 60 * 1000;
// meetings per run; a run that lists this many has not caught up, so the next run lists from the start again
export const LIMIT = 100;

// what the person gives up compared with a direct connection; the Connectors page lists these next to the button
export const TRADEOFFS = (runner, source) => [
  `Spends your ${runner} model tokens: the agent reads every meeting it imports.`,
  `Each note passes through a model, so wording can change and details can be dropped. A direct connection copies ${source}'s notes as they are.`,
  'Runs once when you ask, or on the schedule you pick, only while Quorum is open.',
  `Depends on ${runner} staying signed in to ${source}. If its sign-in expires, the import stops until you sign in there again.`,
];

const short = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

// the task the runner gets. It names the two MCP servers by the names the runner knows them under and leaves tool
// names to the agent, since every source's server has its own. Notes already in Quorum are skipped by id
export function importPrompt({ source, server, since = null, limit = LIMIT }) {
  const from = short(since);
  return [
    `Task: import ${source.name} meeting notes into Quorum. Use only MCP tools; do not read or write files and do not run commands.`,
    `1. With the "${server}" MCP server, list the meetings${from ? ` that happened on or after ${from}` : ''}, newest first, up to ${limit}.`,
    `2. For each meeting, fetch its notes (title, date, participants, summary or notes text, a link to it in ${source.name} if there is one).`,
    `3. Call the "quorum" MCP server's import_meeting tool once per meeting with: source "${source.id}", id (the meeting's id in ${source.name}), title, date (ISO 8601), participants (names), url, and body (the notes as markdown, kept as close to the original wording as the tool allows; do not summarize further).`,
    '4. import_meeting answers skipped:true for a meeting Quorum already has; move on without changes.',
    '5. When done, answer with one line: "Imported N, skipped M" and nothing else.',
  ].join('\n');
}

// the headless invocation for each runner. `quorum` is how to start Quorum's own MCP server (runtime, cli, env)
export function runnerCommand(runnerId, { server, prompt, quorum, model = null }) {
  const quorumServer = { command: quorum.runtime, args: [quorum.cli, 'mcp'], env: quorum.env ?? {} };
  if (runnerId === 'claude-code') {
    return {
      bin: 'claude',
      args: [
        '-p', '--output-format', 'json', ...(model ? ['--model', model] : []),
        // the person's own servers stay (that is where the source and its sign-in live); quorum is added for this run
        '--mcp-config', JSON.stringify({ mcpServers: { quorum: quorumServer } }),
        '--allowedTools', `mcp__${server}__*`, 'mcp__quorum__*',
        '--no-session-persistence', '--disable-slash-commands',
      ],
      stdin: prompt,
    };
  }
  if (runnerId === 'codex') {
    const toml = (v) => JSON.stringify(v);
    const env = Object.entries(quorumServer.env).map(([k, v]) => `${k} = ${toml(String(v))}`).join(', ');
    return {
      bin: 'codex',
      args: [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check', ...(model ? ['-m', model] : []),
        '-c', `mcp_servers.quorum.command=${toml(quorumServer.command)}`,
        '-c', `mcp_servers.quorum.args=${toml(quorumServer.args)}`,
        ...(env ? ['-c', `mcp_servers.quorum.env={ ${env} }`] : []),
        '-',
      ],
      stdin: prompt,
    };
  }
  if (runnerId === 'antigravity') {
    // agy has no per-run MCP flag, so the quorum server must already be in ~/.gemini/config/mcp_config.json
    return { bin: 'agy', args: ['-p', prompt, '--output-format', 'json', '--disable-slash-commands', ...(model ? ['--model', model] : [])], stdin: null };
  }
  throw new Error(`Unknown runner ${runnerId}`);
}

// the last line of a json or text answer that reads "Imported N, skipped M"
export function parseSummary(text) {
  const m = String(text ?? '').match(/Imported\s+(\d+),\s*skipped\s+(\d+)/i);
  return m ? { imported: Number(m[1]), skipped: Number(m[2]) } : null;
}

const countNotes = (dir) => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };

// one run; the result counts notes in the source folder before and after, since that is what actually landed
// cwd: a server the runner knows only inside one project (Claude Code project scope) is reachable only from that folder
export async function runImport({ runnerId, server, source, since, quorum, dir, cwd = null, model = null, spawnImpl = spawn, env = process.env, timeoutMs = TIMEOUT_MS, onLine = () => {} }) {
  const cmd = runnerCommand(runnerId, { server, prompt: importPrompt({ source, server, since }), quorum, model });
  const before = countNotes(dir);
  const { code, out, err } = await new Promise((resolve, reject) => {
    // the runner bills the person's own sign-in, as the trade-offs say; an exported API key would change that
    const clean = { ...env }; delete clean.ANTHROPIC_API_KEY; delete clean.OPENAI_API_KEY;
    const proc = spawnImpl(cmd.bin, cmd.args, { env: clean, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd && existsSync(cwd) ? { cwd } : {}) });
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${runnerId} took longer than ${Math.round(timeoutMs / 60000)} minutes.`)); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; for (const l of String(d).split('\n')) if (l.trim()) onLine(l); });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${cmd.bin} is not on PATH.`) : e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    proc.stdin.on?.('error', () => {});
    if (cmd.stdin !== null) proc.stdin.end(cmd.stdin); else proc.stdin.end();
  });
  const after = countNotes(dir);
  // Claude Code's json output is one object with result; Codex's --json is one event per line; agy's json has text
  let text = out;
  try { const j = JSON.parse(out); text = j.result ?? j.text ?? j.output ?? out; } catch {}
  if (code !== 0) throw new Error(err.trim().split('\n')[0] || `${runnerId} exited ${code}`);
  const said = parseSummary(text) ?? parseSummary(out);
  const listed = said ? said.imported + said.skipped : after - before;
  return { imported: Math.max(0, after - before), skipped: said?.skipped ?? 0, listed, caughtUp: listed < LIMIT, said, text: String(text).slice(0, 2000) };
}

export function dueFor(schedule, lastRunAt, now = Date.now()) {
  if (!SCHEDULES.includes(schedule) || schedule === 'off') return false;
  if (!lastRunAt) return true;
  const gap = schedule === 'hourly' ? 3600000 : 86400000;
  return now - new Date(lastRunAt).getTime() >= gap;
}
