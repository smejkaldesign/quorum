// Runs the claude or codex command and collects its output. The API key is left out of the environment so Claude Code
// uses the person's own sign-in (and lists the claude.ai connectors of that sign-in). Shared by main.js (the quorum MCP
// server registration), agentLink.js and connectors/mcpOverlap.js (`claude mcp list`). missing is true when the
// command is not on PATH.
import { spawn } from 'node:child_process';

export const cliRun = (bin, args, { timeout = 0, spawnImpl = spawn } = {}) => new Promise((resolve) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const missing = { ok: false, out: `${bin} not found`, missing: true };
  let p;
  try { p = spawnImpl(bin, args, { env }); } catch { resolve(missing); return; }
  let out = '';
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
  const timer = timeout ? setTimeout(() => { p.kill(); finish({ ok: false, out, timedOut: true }); }, timeout) : null;
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', () => finish(missing));
  p.on('close', (code) => finish({ ok: code === 0, out }));
});

export const claudeRun = (args, opts) => cliRun('claude', args, opts).then((r) => (r.missing ? { ...r, out: 'Claude Code not found' } : r));
