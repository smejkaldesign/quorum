// the keeper: what maintains an Agent OS after Quorum writes into it. Each new meeting note gets an index line, a line
// in the daily note, and a line under "## Meetings" in every people note and project note it concerns; a dated entry in
// .quorum/changelog.md records each change. With a model source chosen, a few learned facts per note go into a marked
// block in CLAUDE.md. Everything is append-only: no note body is rewritten, and a line already present is left alone.
// Confidential notes, private folders and secret-looking files never enter the index, the links or the facts.
// Progress is kept in .quorum/keeper.json by note hash, so a note changed later is filed again and an unchanged one
// is skipped; a backlog left by days with the app closed runs in one pass at launch.
// Each job (index, daily, links, facts) is a plugin (plugins.js): the keeper writes only the jobs Quorum owns, never
// touches a file whose first lines say it is generated, names daily notes the way the vault already does, and holds a
// run that would create more than CREATE_LIMIT new files until the user says to go ahead
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './linkparse.js';
import { writeAtomic } from './relink.js';
import { slug } from './starter.js';
import { DAILY_DEFAULT, choose, dailyName, dailyPattern, detect, isGenerated, owns, resolvePlugins, scanContext } from './plugins.js';

export const KEEPER_FILE = path.join('.quorum', 'keeper.json');
export const CHANGELOG = path.join('.quorum', 'changelog.md');
export const LEARNED_OPEN = '<!-- quorum:learned -->';
export const LEARNED_CLOSE = '<!-- /quorum:learned -->';
const LEARNED_CAP = 40;
// a run that would add more new files than this to the vault waits for the user (a backlog of months of meetings
// against a vault with its own daily naming once made 86)
export const CREATE_LIMIT = 10;
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
  const conf = () => ({ on: settings.keeper?.on ?? settings.brainMade === 'quorum' });
  let running = null;
  let queued = null;
  let lastRows = null;
  let timer = null;
  let lastRun = null;

  const stateFile = (vault) => path.join(vault, KEEPER_FILE);
  const loadState = (vault) => { try { return JSON.parse(readFileSync(stateFile(vault), 'utf8')); } catch { return { done: {} }; } };
  const saveState = (vault, st) => { mkdirSync(path.dirname(stateFile(vault)), { recursive: true }); writeAtomic(stateFile(vault), JSON.stringify(st, null, 2) + '\n'); };

  // the plugin rows for this vault, and the daily naming it uses. The rows are the only record of whether facts are on;
  // the older facts switch, saved as off before plugins existed, reads as the vault owning facts until the user picks
  // on the plugin row, which clears it
  const registry = (b) => {
    const f = folders(b.vault);
    const ctx = scanContext(b.root, b.vault, f);
    let rows = resolvePlugins(detect(ctx), settings.plugins);
    if (settings.keeper?.facts === false && !settings.plugins?.facts) rows = rows.map((r) => (r.id === 'facts' ? { ...r, owner: 'vault', overridden: false, isNew: false } : r));
    lastRows = rows;
    return { f, rows, daily: f.daily ? dailyPattern(ctx.daily).template : DAILY_DEFAULT };
  };

  const meetingNotes = (vault, dir) => {
    const out = [];
    const walk = (d) => { for (const n of readdirSync(d).sort()) { const p = path.join(d, n); if (n.startsWith('.')) continue; if (isDir(p)) walk(p); else if (n.endsWith('.md') && n !== 'README.md' && n !== 'index.md') out.push(path.relative(vault, p).split(path.sep).join('/')); } };
    try { walk(path.join(vault, dir)); } catch {}
    return out;
  };

  const meta = (rel, text) => {
    const { props } = parseFrontmatter(text);
    const base = path.posix.basename(rel, '.md');
    const title = (typeof props.title === 'string' && props.title) || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || base;
    const date = String(props.date ?? '').slice(0, 10) || base.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || today();
    return { props, base, title, date };
  };

  // one note into the folder: index, daily, people, projects, facts, each only when Quorum owns that job; returns the
  // list of files changed. A file whose first lines say it is generated is left alone and named in marked. With
  // noCreate, the index and the daily note are written only when they exist already; those are the files a held run
  // counts
  async function file(vault, reg, rel, text, { facts, marked, noCreate = false }) {
    const { f, rows, daily } = reg;
    const changed = [];
    const { props, base, title, date } = meta(rel, text);
    const people = (Array.isArray(props.participants) ? props.participants : []).map((p) => String(p).replace(/\s*\(recorder\)\s*$/i, '').trim()).filter((p) => p && p.toLowerCase() !== owner().toLowerCase());
    const link = `[[${base}]]`;
    const touch = (abs, next, cur) => {
      if (next == null) return;
      if (cur != null && isGenerated(cur)) {
        const r = path.relative(vault, abs).split(path.sep).join('/');
        if (!marked.includes(r)) marked.push(r);
        return;
      }
      writeAtomic(abs, next);
      changed.push(path.relative(vault, abs));
    };
    // index: one line per note
    if (owns(rows, 'index') && !(noCreate && !existsSync(path.join(vault, 'index.md')))) {
      const indexAbs = path.join(vault, 'index.md');
      const cur = read(indexAbs);
      const index = cur ?? '# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n';
      const indexLine = `- ${link} - meeting ${date}: ${title}`;
      if (!index.includes(`${link} `) && !index.includes(`${link}]`) && !index.includes(`${link}\n`)) touch(indexAbs, index.replace(/\s*$/, '') + '\n' + indexLine + '\n', cur);
    }
    // daily note, named the way the vault already names them
    if (f.daily && owns(rows, 'daily')) {
      const abs = path.join(vault, f.daily, dailyName(daily, date));
      const cur = read(abs);
      if (!(noCreate && cur == null)) touch(abs, appendUnder(cur ?? `# ${date}\n`, '## Meetings', `- ${link} ${title}`), cur);
    }
    // people: a note per participant, matched by slug
    if (f.people && owns(rows, 'links')) {
      for (const p of people) {
        const abs = path.join(vault, f.people, `${slug(p)}.md`);
        const cur = read(abs);
        if (cur != null) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur);
      }
    }
    // projects: a note whose title appears in the meeting text
    if (f.projects && owns(rows, 'links')) {
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
        if (hit) touch(abs, appendUnder(cur, '## Meetings', `- ${date} ${link} ${title}`), cur);
      }
    }
    // learned facts, with the person's own model source
    if (facts && owns(rows, 'facts') && runText && hasModel()) {
      try {
        const out = await runText(factsPrompt({ title, date, participants: people, body: text.slice(parseFrontmatter(text).end) }), FACTS_SYSTEM);
        const got = parseFacts(out);
        if (got.length) {
          const abs = path.join(vault, 'CLAUDE.md');
          const cur = read(abs);
          touch(abs, addLearned(cur ?? `# Agent OS\n`, got.map((g) => `${g} (${link}, ${date})`)), cur);
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

  // the new files one note would add: the index when missing, and its daily note when that does not exist yet
  const createsFor = (vault, reg, n) => {
    const out = [];
    if (owns(reg.rows, 'index') && !existsSync(path.join(vault, 'index.md'))) out.push('index.md');
    if (reg.f.daily && owns(reg.rows, 'daily')) {
      const r = `${reg.f.daily}/${dailyName(reg.daily, meta(n.rel, n.text).date)}`;
      if (!existsSync(path.join(vault, r))) out.push(r);
    }
    return out;
  };

  // every meeting note not yet filed, or changed since; one pass. When the pass would create more than CREATE_LIMIT
  // files, the notes that need a new file are held: their lines go into files that exist (links, facts, an existing
  // index), the new files are listed in held, and the notes wait in partial for a run with allowCreate. Notes that
  // need no new file are filed as usual. A partial note is never sent for facts twice. allowCreate asked for while a
  // pass is running starts a second pass after it
  async function run({ reason = 'manual', allowCreate = false } = {}) {
    if (running) {
      if (!allowCreate) return running;
      queued ??= running.then(() => { queued = null; return run({ reason, allowCreate: true }); });
      return queued;
    }
    running = (async () => {
      const b = brain();
      const c = conf();
      const result = { filed: 0, skipped: 0, changed: 0, reason, at: new Date().toISOString(), error: null, marked: [], held: null };
      if (!b || !c.on) return { ...result, off: true };
      const vault = b.vault;
      const reg = registry(b);
      if (!reg.f.meetings) return result;
      try {
        const st = loadState(vault);
        st.done ??= {};
        const compiled = guards();
        const pending = [];
        for (const rel of meetingNotes(vault, reg.f.meetings)) {
          const text = read(path.join(vault, rel));
          if (text == null) continue;
          const h = sha(text);
          if (st.done[rel] === h) continue;
          const why = compiled ? wouldBlock(compiled, rel, text.slice(0, 2000)) : null;
          pending.push({ rel, text, h, why });
        }
        st.partial ??= {};
        for (const n of pending) n.creates = n.why ? [] : createsFor(vault, reg, n);
        const creates = [...new Set(pending.flatMap((n) => n.creates))].sort();
        const hold = creates.length > CREATE_LIMIT && !allowCreate;
        result.held = hold ? { count: creates.length, sample: creates.slice(0, 5) } : null;
        if (hold) st.held = result.held; else delete st.held;
        for (const n of pending) {
          if (n.why) { st.done[n.rel] = n.h; result.skipped++; continue; }
          const facts = st.partial[n.rel] !== n.h;
          const waits = hold && n.creates.length > 0;
          const changed = await file(vault, reg, n.rel, n.text, { facts, marked: result.marked, noCreate: waits });
          result.changed += changed.length;
          if (waits) { st.partial[n.rel] = n.h; continue; }
          delete st.partial[n.rel];
          st.done[n.rel] = n.h;
          result.filed++;
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
      if (result.held) log('keeper', `${reason}: held, the run would create ${result.held.count} files`);
      if (result.changed || result.held) onChange(result);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // a note just written: filed shortly, once the burst of writes settles
  const schedule = (reason = 'note') => { clearTimeout(timer); timer = setTimeout(() => { timer = null; run({ reason }).catch(() => {}); }, 2500); };

  const plugins = () => { const b = brain(); return b ? registry(b).rows : []; };
  // the rows from the last scan, for callers on a hot path (each question asks about search); scans once if none yet
  const cachedPlugins = () => lastRows ?? plugins();
  const status = () => {
    const b = brain();
    const c = conf();
    const st = b ? loadState(b.vault) : { done: {} };
    const reg = b ? registry(b) : null;
    return { on: c.on, facts: reg ? owns(reg.rows, 'facts') : false, running: !!running, lastRunAt: st.lastRunAt ?? null, filed: Object.keys(st.done ?? {}).length, last: st.last ?? lastRun, held: st.held ?? null, folders: reg?.f ?? {}, model: hasModel(), plugins: reg?.rows ?? [] };
  };
  // one plugin row handed to Quorum or to the vault. A held run planned with the old owners no longer applies, so it
  // is cleared and a new pass is scheduled
  const setPlugin = (id, to) => {
    const b = brain();
    settings.plugins = choose(settings.plugins, plugins(), id, to);
    if (id === 'facts' && settings.keeper && 'facts' in settings.keeper) { settings.keeper = { ...settings.keeper }; delete settings.keeper.facts; }
    saveSettings();
    if (b) { const st = loadState(b.vault); if (st.held) { delete st.held; saveState(b.vault, st); } }
    if (conf().on) schedule('settings');
    return status();
  };
  // facts in a patch is the older switch; it now sets the facts plugin row
  const set = (patch = {}) => {
    if (typeof patch.facts === 'boolean') setPlugin('facts', patch.facts ? 'quorum' : 'vault');
    settings.keeper = { ...settings.keeper, ...conf(), ...(typeof patch.on === 'boolean' ? { on: patch.on } : {}) };
    saveSettings();
    if (settings.keeper.on) schedule('settings');
    return status();
  };
  return { run, schedule, status, set, setPlugin, plugins, cachedPlugins, conf };
}
