// plugins: each upkeep job Quorum can do on an Agent OS, with who owns it. A job is owned by Quorum (the keeper writes
// it) or by the vault (Quorum reads and links, and writes nothing for that job). The owner defaults to the vault when
// the vault already has tooling for the job, and to Quorum otherwise. The user can hand a job to the other side; that
// choice is saved with the evidence it was made against, so tooling found later brings the vault default back and
// shows the row as new until the user picks again. Detection reads file names and the first lines of a few files only,
// and never runs anything. A new plugin is one more entry in PLUGINS with its own detect(). A report plugin writes
// nothing in the vault on its own: it reads and shows a result in Settings, so it does not wait for upkeep to be on.
// A plugin marked off starts with the vault even when no tooling is found, and runs only after the user turns it on
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// a file whose first lines carry a generated notice is rewritten by a tool, so anything appended to it gets lost. The
// notice has to stand as its own line: a comment (<!-- --> or %% %%) that says so, a frontmatter key, or a line that
// starts with the notice. Prose such as "Do not edit .env directly" is not a notice
const NOTICE_RE = /^(?:this (?:file|note|page) (?:is|was) )?(?:auto-?generated\b|generated (?:by|from) \S+|do not hand-?edit\b|do not edit (?:this (?:file|note|page)|by hand)\b)/i;
const COMMENT_NOTICE_RE = /auto-?generated\b|generated (?:by|from) \S+|do not (?:hand-?)?edit\b/i;
const FRONTMATTER_RE = /^(?:auto[-_]?generated|generated(?:[-_]by)?)\s*:\s*\S/i;
export function isNotice(line) {
  const t = String(line).trim();
  const comment = t.match(/^(?:<!--|%%)\s*(.*?)\s*(?:-->|%%)?$/);
  if (comment) return COMMENT_NOTICE_RE.test(comment[1]);
  if (FRONTMATTER_RE.test(t)) return true;
  return NOTICE_RE.test(t.replace(/^(?:[#>*_-]+\s*|\/\/\s*)+/, '').replace(/^[*_]+/, ''));
}
export const isGenerated = (text) => String(text ?? '').split('\n').slice(0, 10).some(isNotice);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const head = (p) => { try { return readFileSync(p, 'utf8').slice(0, 2000); } catch { return null; } };
const list = (d) => { try { return readdirSync(d).filter((n) => !n.startsWith('.')).sort(); } catch { return []; } };
const SCRIPT_RE = /\.(py|js|mjs|cjs|ts|sh|rb)$/i;
const SCRIPT_DIRS = ['scripts', 'bin', '.claude/scripts'];

// the dated notes in a daily folder decide its naming: the most common text after the date wins, so a folder of
// 2026-11-10-brief.md files keeps that name. An empty or undated folder gets the plain <date>.md
export const DAILY_DEFAULT = '{date}.md';
export function dailyPattern(names) {
  const counts = new Map();
  for (const n of names) {
    const m = n.match(/^\d{4}-\d{2}-\d{2}(.*)\.md$/);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  if (!counts.size) return { template: DAILY_DEFAULT, dated: 0 };
  const [suffix, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  return { template: `{date}${suffix}.md`, dated: [...counts.values()].reduce((a, b) => a + b, 0), matching: n };
}
export const dailyName = (template, date) => template.replace('{date}', date);

// what detect() functions get: the two roots, the area folders the keeper found, the scripts in the usual places and
// the Claude Code hooks
export function scanContext(root, vault, folders = {}) {
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/') || path.basename(abs);
  const seen = new Set();
  const scripts = [];
  for (const base of [...new Set([vault, root])]) {
    for (const d of SCRIPT_DIRS) {
      for (const n of list(path.join(base, d))) {
        const abs = path.join(base, d, n);
        if (SCRIPT_RE.test(n) && !seen.has(abs)) { seen.add(abs); scripts.push({ name: n, abs, rel: rel(abs) }); }
      }
    }
  }
  const hooks = [];
  for (const base of [...new Set([vault, root])]) {
    for (const n of list(path.join(base, '.claude/hooks'))) {
      const abs = path.join(base, '.claude/hooks', n);
      if (!seen.has(abs)) { seen.add(abs); hooks.push({ name: n, abs, rel: rel(abs) }); }
    }
  }
  const daily = folders.daily ? list(path.join(vault, folders.daily)) : [];
  return { root, vault, folders, scripts, hooks, daily, rel };
}

const scriptsMatching = (ctx, re, not) => ctx.scripts.filter((s) => re.test(s.name) && !(not && not.test(s.name))).map((s) => ({ path: s.rel, why: 'script' }));
const hooksMatching = (ctx, re) => (ctx.hooks ?? []).filter((h) => re.test(h.name)).map((h) => ({ path: h.rel, why: 'hook' }));
const toolsMatching = (ctx, re) => [...scriptsMatching(ctx, re), ...hooksMatching(ctx, re)];

export const PLUGINS = [
  {
    id: 'index', title: 'Index lines', does: 'One line per meeting in index.md',
    detect(ctx) {
      const out = [];
      const abs = path.join(ctx.vault, 'index.md');
      if (isGenerated(head(abs))) out.push({ path: ctx.rel(abs), why: 'marked as generated' });
      // a script named for building the index; a bare index.js or index.ts is an entry point and does not count
      return [...out, ...scriptsMatching(ctx, /(?:^|[-_.])(?:build|wiki|gen|make|update|rebuild|refresh)[-_]?index|index[-_]?(?:gen|generator|build|builder)(?:[-_.]|$)/i, /search|embed|vector/i)];
    },
  },
  {
    id: 'daily', title: 'Daily lines', does: 'A line in the daily note for each meeting day',
    detect(ctx) {
      const out = [];
      if (ctx.folders.daily) {
        // evidence names the folder and its naming, never a dated file, so a new day leaves the saved choice in place
        const p = dailyPattern(ctx.daily);
        const named = `${ctx.rel(path.join(ctx.vault, ctx.folders.daily))}/${p.template.replace('{date}', '<date>')}`;
        if (p.template !== DAILY_DEFAULT) out.push({ path: named, why: 'daily naming' });
        const latest = ctx.daily.filter((n) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(n)).at(-1);
        if (latest && isGenerated(head(path.join(ctx.vault, ctx.folders.daily, latest)))) out.push({ path: named, why: 'marked as generated' });
      }
      return [...out, ...scriptsMatching(ctx, /(?:^|[-_.])(?:daily|brief)(?:[-_.]|$)/i)];
    },
  },
  {
    id: 'links', title: 'People and project links', does: 'A line under Meetings in each people and project note a meeting concerns',
    detect: (ctx) => scriptsMatching(ctx, /backlink|link[-_]?weav|weave|add[-_]?links/i),
  },
  {
    id: 'facts', title: 'Learned facts', does: 'Up to three facts per meeting, written with your model source',
    detect(ctx) {
      const out = [];
      for (const base of [...new Set([ctx.root, ctx.vault])]) {
        for (const f of ['MEMORY.md', 'memory', '.claude/memory']) {
          const abs = path.join(base, f);
          const there = f.endsWith('.md') ? head(abs) != null : isDir(abs) && list(abs).length > 0;
          if (there && !out.some((e) => e.path === ctx.rel(abs))) out.push({ path: ctx.rel(abs), why: 'memory system' });
        }
      }
      return out;
    },
  },
  {
    id: 'search', title: 'Search', does: 'Finds the notes behind an answer', always: true,
    detect: (ctx) => scriptsMatching(ctx, /search/i),
  },
  {
    id: 'context', title: 'Context budget', does: 'Sizes of the files Claude Code loads every session, with warnings', report: true,
    detect: (ctx) => toolsMatching(ctx, /context[-_]?(?:budget|size|check|audit)|token[-_]?(?:budget|count)|claude[-_]?md[-_]?(?:size|lint|check|audit)|memory[-_]?(?:lint|size|budget)/i),
  },
  {
    id: 'skills', title: 'Skill usage', does: 'Which skills ran lately, counted from the Claude Code transcripts on this Mac', report: true,
    detect: (ctx) => toolsMatching(ctx, /skill[-_]?(?:usage|telemetry|stats?|track(?:er|ing)?|audit|count)|(?:usage|telemetry)[-_]?(?:skill|track)|^telemetry/i),
  },
];

// the evidence a choice was made against, as one string; a change in it brings the default back
const evidenceKey = (evidence) => evidence.map((e) => `${e.path}:${e.why}`).sort().join('|');

// all detection results, by plugin id
export function detect(ctx) {
  return Object.fromEntries(PLUGINS.map((p) => { let ev = []; try { ev = p.detect(ctx); } catch {} return [p.id, ev]; }));
}

// the rows the settings page shows and the keeper checks. saved is settings.plugins: { [id]: { owner, ack } }, where
// ack is the evidence the user saw when they chose
export function resolvePlugins(found, saved = {}) {
  return PLUGINS.map((p) => {
    const evidence = found[p.id] ?? [];
    const key = evidenceKey(evidence);
    const s = saved?.[p.id];
    const chose = !!s && (s.owner === 'quorum' || s.owner === 'vault') && s.ack === key;
    const fallback = evidence.length || p.off ? 'vault' : 'quorum';
    const owner = chose ? s.owner : fallback;
    return { id: p.id, title: p.title, does: p.does, always: !!p.always, report: !!p.report, evidence, owner, overridden: evidence.length > 0 && owner === 'quorum', isNew: evidence.length > 0 && !chose };
  });
}

// a user's pick for one row, saved against the evidence on screen
export function choose(saved, rows, id, owner) {
  const row = rows.find((r) => r.id === id);
  if (!row || (owner !== 'quorum' && owner !== 'vault')) return saved ?? {};
  return { ...(saved ?? {}), [id]: { owner, ack: evidenceKey(row.evidence) } };
}

export const owns = (rows, id) => rows.find((r) => r.id === id)?.owner === 'quorum';
