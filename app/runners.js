// Runners other than Claude Code that run a model step on the person's own subscription: Codex (codex exec) and
// Antigravity (agy -p). Text roles only, summary and notes: a system prompt and a prompt in, text out. Both run from
// an empty temp folder, Codex in its read-only sandbox and agy in its sandbox, and the prompt asks for text only;
// neither CLI has a flag that turns its tools off, so a run could still read files the sandbox allows. That is why
// the agent role stays with Claude Code, whose hooks carry Quorum's read guard (docs/parity-gaps.md).
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const TEXT_RUNNERS = {
  codex: { id: 'codex', name: 'Codex', bin: 'codex' },
  antigravity: { id: 'antigravity', name: 'Antigravity', bin: 'agy' },
};
const TIMEOUT_MS = 180000;

// which runners are on PATH, with their version; one login shell lookup each, cached for a minute
let statusAt = 0, statusCache = null;
export async function runnersStatus({ which = defaultWhich, now = Date.now() } = {}) {
  if (statusCache && now - statusAt < 60000) return statusCache;
  const out = {};
  await Promise.all(Object.values(TEXT_RUNNERS).map(async (r) => {
    const version = await which(r.bin);
    out[r.id] = { installed: version !== null, version };
  }));
  statusAt = now; statusCache = out;
  return out;
}
// null when the binary is not on PATH (command -v decides, so a missing binary never reads as installed), else its version
function defaultWhich(bin) {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', `command -v ${bin} >/dev/null 2>&1 && ${bin} --version 2>/dev/null | head -1`], { encoding: 'utf8', timeout: 8000 }, (err, out) => {
      resolve(err ? null : String(out).trim().replace(/^[a-z-]+\s+/i, ''));
    });
  });
}

// codex exec --json writes one event per line; the answer is the last completed agent_message
export function parseCodexEvents(text) {
  let answer = null;
  for (const line of String(text).split('\n')) {
    let evt; try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.type === 'item.completed' && evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') answer = evt.item.text;
    if (evt?.type === 'error' || evt?.type === 'turn.failed') throw new Error(evt.message || evt.error?.message || 'Codex reported an error.');
  }
  return answer;
}

// agy --output-format json writes one object with the status and the response
export function parseAgyJson(text) {
  let j; try { j = JSON.parse(String(text).trim().split('\n').pop()); } catch { throw new Error('Antigravity returned no JSON.'); }
  if (j.status && j.status !== 'SUCCESS') throw new Error(j.error || j.message || `Antigravity answered ${j.status}.`);
  return typeof j.response === 'string' ? j.response.trim() : null;
}

const run = ({ bin, args, stdin, spawnImpl, cwd, timeoutMs = TIMEOUT_MS }) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  const proc = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { proc.kill(); reject(new Error(`${bin} took longer than ${Math.round(timeoutMs / 60000)} minutes.`)); }, timeoutMs);
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error(`${bin} is not installed on this Mac.`) : e); });
  proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n')[0] || `${bin} exited ${code}`)); });
  // a runner that exits before reading its input (not logged in) closes the pipe; the exit code carries the error
  proc.stdin.on?.('error', () => {});
  if (stdin != null) proc.stdin.end(stdin); else proc.stdin.end();
});

export const codexArgs = () => ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-'];
export const agyArgs = (prompt) => ['-p', prompt, '--output-format', 'json', '--disable-slash-commands', '--sandbox'];

// the system prompt rides in front of the prompt: neither runner has a separate system argument in print mode
const combine = (system, prompt) => [system ? `Instructions:\n${system}` : '', 'Answer with text only. Do not read files, run commands or use tools.', prompt].filter(Boolean).join('\n\n');

// the caller's cwd (a session folder) is not used: a text step has no business in any folder, so both run from the temp dir
export async function codexText({ prompt, system = '', onDelta = null, spawnImpl = spawn }) {
  const out = await run({ bin: TEXT_RUNNERS.codex.bin, args: codexArgs(), stdin: combine(system, prompt), spawnImpl, cwd: tmpdir() });
  const text = parseCodexEvents(out);
  if (text == null) throw new Error('Codex returned no answer.');
  onDelta?.(text);
  return text.trim();
}

export async function agyText({ prompt, system = '', onDelta = null, spawnImpl = spawn }) {
  const out = await run({ bin: TEXT_RUNNERS.antigravity.bin, args: agyArgs(combine(system, prompt)), stdin: null, spawnImpl, cwd: tmpdir() });
  const text = parseAgyJson(out);
  if (text == null) throw new Error('Antigravity returned no answer.');
  onDelta?.(text);
  return text;
}
