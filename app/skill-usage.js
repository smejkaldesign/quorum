// skill usage: how often each skill in the vault's .claude/skills ran, counted from the Claude Code transcripts on
// this Mac (~/.claude/projects/<vault>/*.jsonl). Only skill names and timestamps are taken from a transcript; no
// transcript text is kept, logged or sent anywhere. A skill with no recorded run in the window can be stashed:
// disable-model-invocation: true in its SKILL.md frontmatter drops it from the model's skill listing, and typing
// /name still runs it. Unstash removes that line. Both change only that one file, and only when the user clicks
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { projectDir } from './context-budget.js';

export const WINDOWS = [60, 90];
const DAY = 86400000;
const STASH_KEY = 'disable-model-invocation';
const NAME_RE = /^[A-Za-z0-9][\w.:-]*$/;
const COMMAND_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const skillsDir = (root) => path.join(root, '.claude', 'skills');
const isStashed = (props) => String(props[STASH_KEY] ?? '').toLowerCase() === 'true';

// the skills defined in the vault, one folder each with a SKILL.md
export function listSkills(root) {
  let names;
  try { names = readdirSync(skillsDir(root)).filter((n) => !n.startsWith('.')).sort(); } catch { return []; }
  const out = [];
  for (const dir of names) {
    const file = path.join(skillsDir(root), dir, 'SKILL.md');
    const text = read(file);
    if (text == null) continue;
    const { props } = parseFrontmatter(text);
    out.push({ dir, name: typeof props.name === 'string' && props.name ? props.name : dir, file, stashed: isStashed(props), text });
  }
  return out;
}

// the skill names one transcript line records: a Skill tool call, the older SlashCommand tool, or a typed /command
export function namesIn(evt) {
  const out = [];
  const content = evt?.message?.content;
  if (evt?.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      if (c.name === 'Skill') out.push(c.input?.skill ?? c.input?.command);
      if (c.name === 'SlashCommand') out.push(c.input?.command);
    }
  }
  if (evt?.type === 'user') {
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text) : [];
    for (const t of texts) for (const m of String(t).matchAll(COMMAND_RE)) out.push(m[1]);
  }
  return out.filter((n) => typeof n === 'string' && n).map((n) => n.replace(/^\//, '').split(/\s/)[0]);
}

// one transcript file into { uses: { name: { runs, last } }, first }. A line that names no skill is never parsed
async function scanFile(abs) {
  const uses = {};
  let first = null;
  const rl = createInterface({ input: createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const ts = line.match(/"timestamp":"([^"]+)"/)?.[1] ?? null;
    if (ts && (!first || ts < first)) first = ts;
    if (!line.includes('"Skill"') && !line.includes('"SlashCommand"') && !line.includes('<command-name>')) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    for (const name of namesIn(evt)) {
      const u = (uses[name] ??= { runs: 0, last: null });
      u.runs++;
      const at = evt.timestamp ?? null;
      if (at && (!u.last || at > u.last)) u.last = at;
    }
  }
  return { uses, first };
}

// every transcript for the project, reusing the counts of files unchanged since the last scan
export async function scanTranscripts(dir, cache = new Map()) {
  let files;
  try { files = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)); } catch { return { files: 0, first: null, uses: {} }; }
  const uses = {};
  let first = null;
  for (const abs of files) {
    let st;
    try { st = statSync(abs); } catch { continue; }
    let hit = cache.get(abs);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      try { hit = { mtimeMs: st.mtimeMs, size: st.size, ...(await scanFile(abs)) }; } catch { continue; }
      cache.set(abs, hit);
    }
    if (hit.first && (!first || hit.first < first)) first = hit.first;
    for (const [name, u] of Object.entries(hit.uses)) {
      const t = (uses[name] ??= { runs: 0, last: null });
      t.runs += u.runs;
      if (u.last && (!t.last || u.last > t.last)) t.last = u.last;
    }
  }
  return { files: files.length, first, uses };
}

// the other skills whose SKILL.md names this one, as /name, `name`, skills/name or "the name skill"
export function namedBy(skills, skill) {
  const esc = skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^\\w/-])/${esc}(?![\\w-])|\`/?${esc}\`|skills/${esc}(?![\\w-])|\\bthe ${esc} skill\\b`, 'i');
  return skills.filter((s) => s.dir !== skill.dir && re.test(s.text)).map((s) => s.name);
}

// the skills with their counts and last run, and which are unused in each window. coverage is how far back the
// transcripts go, so a window longer than that can be named as not fully known
export async function skillUsage({ root, home = homedir(), cache, now = Date.now() }) {
  const skills = listSkills(root);
  const t = await scanTranscripts(projectDir(root, home), cache);
  const days = t.first ? Math.floor((now - Date.parse(t.first)) / DAY) : 0;
  const rows = skills.map((s) => {
    const u = t.uses[s.name] ?? (s.name !== s.dir ? t.uses[s.dir] : null) ?? { runs: 0, last: null };
    const idle = u.last ? Math.floor((now - Date.parse(u.last)) / DAY) : null;
    return { name: s.name, dir: s.dir, path: path.relative(root, s.file), runs: u.runs, last: u.last, stashed: s.stashed, unused: Object.fromEntries(WINDOWS.map((w) => [w, idle == null || idle >= w])), namedBy: namedBy(skills, s) };
  });
  return { skills: rows, transcripts: t.files, coverageDays: days, windows: WINDOWS };
}

// SKILL.md with the stash line set (on) or removed (off); null when nothing changes. Every other line is kept as is
export function setStash(text, on) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);
  const hasFm = lines[0] === '---' && lines.indexOf('---', 1) > 0;
  if (!hasFm) return on ? ['---', `${STASH_KEY}: true`, '---', ...lines].join(nl) : null;
  const close = lines.indexOf('---', 1);
  const at = lines.findIndex((l, i) => i > 0 && i < close && new RegExp(`^${STASH_KEY}\\s*:`).test(l));
  if (on) {
    if (at >= 0 && /:\s*true\s*$/i.test(lines[at])) return null;
    if (at >= 0) lines[at] = `${STASH_KEY}: true`; else lines.splice(close, 0, `${STASH_KEY}: true`);
  } else {
    if (at < 0) return null;
    lines.splice(at, 1);
  }
  return lines.join(nl);
}

// stash or unstash one skill by folder name; the name has to be a plain folder inside .claude/skills
export function stashSkill(root, dir, on) {
  if (typeof dir !== 'string' || !NAME_RE.test(dir) || dir.includes('..')) throw new Error('Unknown skill');
  const file = path.join(skillsDir(root), dir, 'SKILL.md');
  const text = read(file);
  if (text == null) throw new Error('Unknown skill');
  const next = setStash(text, !!on);
  // a skill folder or SKILL.md that links elsewhere is written at its target, so the link stays a link
  if (next != null) writeAtomic(realpathSync(file), next);
  return { changed: next != null, path: path.relative(root, file) };
}
