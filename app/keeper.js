// the keeper: what maintains an Agent OS after Quorum writes into it. Each new meeting note gets an index line, a line
// in the daily note, and a line under "## Meetings" in every people note and project note it concerns; a dated entry in
// .quorum/changelog.md records each change. With a model source chosen, a few learned facts per note go into a marked
// block in CLAUDE.md. Everything is append-only: no note body is rewritten, and a line already present is left alone.
// Confidential notes, private folders and secret-looking files never enter the index, the links or the facts.
// Progress is kept in .quorum/keeper.json by note hash, so a note changed later is filed again and an unchanged one
// is skipped; a backlog left by days with the app closed runs in one pass at launch
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { slug } from './starter.js';

export const KEEPER_FILE = path.join('.quorum', 'keeper.json');
export const CHANGELOG = path.join('.quorum', 'changelog.md');
export const LEARNED_OPEN = '<!-- quorum:learned -->';
export const LEARNED_CLOSE = '<!-- /quorum:learned -->';
const LEARNED_CAP = 40;
const sha = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);
const today = (d = new Date()) => d.toISOString().slice(0, 10);

// the areas by name, under either naming (02-people or people): the first top-level folder whose name, without a
// numeric prefix, ends in the word
const AREA_RE = { people: /people$/i, projects: /projects?$/i, daily: /daily$/i, meetings: /meetings?$/i };
export function folders(vault) {
  const out = {};
  let names;
  try { names = readdirSync(vault).filter((n) => !n.startsWith('.')).sort(); } catch { return out; }
  for (const [k, re] of Object.entries(AREA_RE)) {
    const hit = names.find((n) => re.test(n.replace(/^\d+[-_ ]*/, '')) && isDir(path.join(vault, n)));
    if (hit) out[k] = hit;
  }
  return out;
}
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// a line appended under a heading; the heading is added at the end when the note lacks it. The whole note is left as
// it was otherwise. False when the line is already there
export function appendUnder(text, heading, line) {
  if (text.includes(line)) return null;
  const lines = text.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (at < 0) return [...lines, '', heading, '', line, ''].join('\n');
  // the section runs to the next heading of any level
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  // an empty section gets a blank line between the heading and its first item, as the other sections have
  lines.splice(end, 0, ...(end === at + 1 ? ['', line] : [line]));
  return lines.join('\n') + '\n';
}

// the learned block: a marked list at the end of CLAUDE.md, newest last, capped, with no repeats
export function addLearned(text, facts) {
  const a = text.indexOf(LEARNED_OPEN);
  const b = text.indexOf(LEARNED_CLOSE);
  const existing = a >= 0 && b > a ? text.slice(a + LEARNED_OPEN.length, b).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')) : [];
  const fresh = facts.map((f) => `- ${f.replace(/^[-*]\s*/, '').trim()}`).filter((f) => f.length > 2 && !existing.includes(f));
  if (!fresh.length) return null;
  const all = [...existing, ...fresh].slice(-LEARNED_CAP);
  const block = [LEARNED_OPEN, '## Learned from meetings', '', 'Facts Quorum picked up from meeting notes, newest last. Edit or delete any line; the keeper never rewrites them.', '', ...all, LEARNED_CLOSE].join('\n');
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + LEARNED_CLOSE.length);
  return text.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

export const FACTS_SYSTEM = 'You keep a short list of durable facts about a person\'s work. Answer with plain lines starting with "- " and nothing else.';
export const factsPrompt = ({ title, date, participants, body }) => [
  `From this meeting note, list up to 3 facts worth remembering for months: people and their roles, project decisions, commitments with dates. One line each, under 20 words, no filler, no speculation. Write "- none" when nothing qualifies.`,
  `Meeting: ${title} (${date}). Participants: ${participants.join(', ') || 'unknown'}.`,
  '', body.slice(0, 6000),
].join('\n');
export const parseFacts = (out) => String(out ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l && !/^none\b/i.test(l)).slice(0, 3);

export function createKeeper({ brain, settings, saveSettings = () => {}, guards = () => null, wouldBlock = () => null, runText = null, hasModel = () => false, owner = () => '', log = () => {}, onChange = () => {} }) {
  const conf = () => ({ on: settings.keeper?.on ?? settings.brainMade === 'quorum', facts: settings.keeper?.facts ?? true });
  let running = null;
  let timer = null;
  let lastRun = null;

  const stateFile = (vault) => path.join(vault, KEEPER_FILE);
  const loadState = (vault) => { try { return JSON.parse(readFileSync(stateFile(vault), 'utf8')); } catch { return { done: {} }; } };
  const saveState = (vault, st) => { mkdirSync(path.dirname(stateFile(vault)), { recursive: true }); writeAtomic(stateFile(vault), JSON.stringify(st, null, 2) + '\n'); };

  const meetingNotes = (vault, dir) => {
    const out = [];
    const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = path.join(d, n); if (n.startsWith('.')) continue; if (isDir(p)) walk(p); else if (n.endsWith('.md') && n !== 'README.md' && n !== 'index.md') out.push(path.relative(vault, p).split(path.sep).join('/')); } };
    try { walk(path.join(vault, dir)); } catch {}
    return out;
  };

  // one note into the folder: index, daily, people, projects, facts; returns the list of files changed
  async function file(vault, f, rel, text, { facts }) {
    const changed = [];
    const { props } = parseFrontmatter(text);
    const base = path.posix.basename(rel, '.md');
    const title = (typeof props.title === 'string' && props.title) || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || base;
    const date = String(props.date ?? '').slice(0, 10) || base.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || today();
    const people = (Array.isArray(props.participants) ? props.participants : []).map((p) => String(p).replace(/\s*\(recorder\)\s*$/i, '').trim()).filter((p) => p && p.toLowerCase() !== owner().toLowerCase());
    const link = `[[${base}]]`;
    const touch = (abs, next) => { if (next == null) return; writeAtomic(abs, next); changed.push(path.relative(vault, abs)); };
    // index: one line per note
    const indexAbs = path.join(vault, 'index.md');
    const index = read(indexAbs) ?? '# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n';
    const indexLine = `- ${link} - meeting ${date}: ${title}`;
    if (!index.includes(`${link} `) && !index.includes(`${link}]`) && !index.includes(`${link}\n`)) touch(indexAbs, index.replace(/\s*$/, '') + '\n' + indexLine + '\n');
    // daily note
    if (f.daily) {
      const abs = path.join(vault, f.daily, `${date}.md`);
      touch(abs, appendUnder(read(abs) ?? `# ${date}\n`, '## Meetings', `- ${link} ${title}`));
    }
    // people: a note per participant, matched by slug
    if (f.people) {
      for (const p of people) {
        const abs = path.join(vault, f.people, `${slug(p)}.md`);
        const cur = read(abs);
        if (cur != null) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`));
      }
    }
    // projects: a note whose title appears in the meeting text
    if (f.projects) {
      const body = text.toLowerCase();
      let names = [];
      try { names = readdirSync(path.join(vault, f.projects)).filter((n) => n.endsWith('.md') && n !== 'README.md'); } catch {}
      for (const n of names) {
        const abs = path.join(vault, f.projects, n);
        const cur = read(abs);
        if (cur == null) continue;
        const name = (parseFrontmatter(cur).props.title ?? cur.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(n, '.md')).toString().trim();
        if (name.length < 3) continue;
        const hit = new RegExp(`(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(body);
        if (hit) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`));
      }
    }
    // learned facts, with the person's own model source
    if (facts && runText && hasModel()) {
      try {
        const out = await runText(factsPrompt({ title, date, participants: people, body: text.slice(parseFrontmatter(text).end) }), FACTS_SYSTEM);
        const got = parseFacts(out);
        if (got.length) {
          const abs = path.join(vault, 'CLAUDE.md');
          touch(abs, addLearned(read(abs) ?? `# Agent OS\n`, got.map((g) => `${g} (${link}, ${date})`)));
        }
      } catch (e) { log('keeper facts failed', e?.message || e); }
    }
    if (changed.length) {
      const abs = path.join(vault, CHANGELOG);
      mkdirSync(path.dirname(abs), { recursive: true });
      const entry = `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${title}\n\n${changed.filter((c) => c !== CHANGELOG).map((c) => `- ${c}`).join('\n')}\n\n`;
      writeAtomic(abs, (read(abs) ?? '# Changelog\n\nWhat the keeper changed, newest last. Each entry names the files it touched for one meeting note.\n\n') + entry);
    }
    return changed;
  }

  // every meeting note not yet filed, or changed since; one pass
  async function run({ reason = 'manual' } = {}) {
    if (running) return running;
    running = (async () => {
      const b = brain();
      const c = conf();
      const result = { filed: 0, skipped: 0, changed: 0, reason, at: new Date().toISOString(), error: null };
      if (!b || !c.on) return { ...result, off: true };
      const vault = b.vault;
      const f = folders(vault);
      if (!f.meetings) return result;
      try {
        const st = loadState(vault);
        st.done ??= {};
        const compiled = guards();
        for (const rel of meetingNotes(vault, f.meetings)) {
          const text = read(path.join(vault, rel));
          if (text == null) continue;
          const h = sha(text);
          if (st.done[rel] === h) continue;
          const why = compiled ? wouldBlock(compiled, rel, text.slice(0, 2000)) : null;
          if (why) { st.done[rel] = h; result.skipped++; continue; }
          const changed = await file(vault, f, rel, text, { facts: c.facts });
          st.done[rel] = h;
          result.filed++;
          result.changed += changed.length;
        }
        st.lastRunAt = result.at;
        st.last = result;
        saveState(vault, st);
      } catch (e) {
        result.error = String(e?.message || e);
        log('keeper', result.error);
      }
      lastRun = result;
      if (result.filed || result.skipped) log('keeper', `${reason}: ${result.filed} filed, ${result.changed} files changed, ${result.skipped} withheld`);
      if (result.changed) onChange(result);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // a note just written: filed shortly, once the burst of writes settles
  const schedule = (reason = 'note') => { clearTimeout(timer); timer = setTimeout(() => { timer = null; run({ reason }).catch(() => {}); }, 2500); };

  const status = () => {
    const b = brain();
    const c = conf();
    const st = b ? loadState(b.vault) : { done: {} };
    return { on: c.on, facts: c.facts, running: !!running, lastRunAt: st.lastRunAt ?? null, filed: Object.keys(st.done ?? {}).length, last: st.last ?? lastRun, folders: b ? folders(b.vault) : {}, model: hasModel() };
  };
  const set = (patch = {}) => {
    settings.keeper = { ...conf(), ...(typeof patch.on === 'boolean' ? { on: patch.on } : {}), ...(typeof patch.facts === 'boolean' ? { facts: patch.facts } : {}) };
    saveSettings();
    if (settings.keeper.on) schedule('settings');
    return status();
  };
  return { run, schedule, status, set, conf };
}
