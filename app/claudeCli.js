// Runs the claude command and collects its output. The API key is left out of the environment so Claude Code uses
// the person's own sign-in (and lists the claude.ai connectors of that sign-in). Shared by main.js (the quorum MCP
// server registration) and connectors/mcpOverlap.js (`claude mcp list`). missing is true when claude is not on PATH.
import { spawn } from 'node:child_process';

export const claudeRun = (args, { timeout = 0, spawnImpl = spawn } = {}) => new Promise((resolve) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  let p;
  try { p = spawnImpl('claude', args, { env }); } catch { resolve({ ok: false, out: 'Claude Code not found', missing: true }); return; }
  let out = '';
  let done = false;
  const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
  const timer = timeout ? setTimeout(() => { p.kill(); finish({ ok: false, out, timedOut: true }); }, timeout) : null;
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', () => finish({ ok: false, out: 'Claude Code not found', missing: true }));
  p.on('close', (code) => finish({ ok: code === 0, out }));
});
