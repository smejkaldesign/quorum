// Who has read a note: people opening it in Quorum, and agents reading it through the read guard (Claude Code's
// Read tool) or the quorum MCP server. Every read is one JSON line in views.jsonl under the data folder, so the
// hook and the MCP server, which run as their own processes, append to the same file the app reads. Counts roll
// up per file: how many people, how many agents and which ones, and the tokens agents spent, estimated from bytes.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const TOKENS_PER_BYTE = 1 / 4;
const canon = (file) => { try { return realpathSync.native(file); } catch { return path.resolve(file); } };
const empty = () => ({ total: 0, human: 0, agent: 0, tokens: 0, lastHumanAt: null, lastAgentAt: null, agents: {} });

export function parseLine(line) {
  try {
    const e = JSON.parse(line);
    if (!e || typeof e.file !== 'string' || (e.who !== 'human' && e.who !== 'agent')) return null;
    return { t: String(e.t ?? ''), file: e.file, who: e.who, via: String(e.via ?? (e.who === 'human' ? 'quorum' : 'agent')), bytes: Number(e.bytes) || 0 };
  } catch { return null; }
}

export function createViews(logFile) {
  let index = new Map();
  let seen = { size: -1, mtimeMs: -1 };
  const add = (e) => {
    const k = canon(e.file);
    const v = index.get(k) ?? empty();
    v.total += 1;
    if (e.who === 'human') { v.human += 1; v.lastHumanAt = e.t || v.lastHumanAt; }
    else { v.agent += 1; v.tokens += Math.round(e.bytes * TOKENS_PER_BYTE); v.lastAgentAt = e.t || v.lastAgentAt; v.agents[e.via] = (v.agents[e.via] ?? 0) + 1; }
    index.set(k, v);
  };
  // other processes append too, so the index is rebuilt whenever the file changed underneath us
  const load = () => {
    let st;
    try { st = statSync(logFile); } catch { index = new Map(); seen = { size: -1, mtimeMs: -1 }; return; }
    if (st.size === seen.size && st.mtimeMs === seen.mtimeMs) return;
    index = new Map();
    for (const line of readFileSync(logFile, 'utf8').split('\n')) { const e = parseLine(line); if (e) add(e); }
    seen = { size: st.size, mtimeMs: st.mtimeMs };
  };
  return {
    file: logFile,
    record({ file, who, via, bytes = 0 }) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), file: canon(file), who, via, bytes })}\n`);
    },
    of(file) {
      load();
      const v = index.get(canon(file));
      if (!v) return { ...empty(), agents: [] };
      return { ...v, agents: Object.entries(v.agents).map(([via, count]) => ({ via, count })).sort((a, b) => b.count - a.count) };
    },
  };
}
