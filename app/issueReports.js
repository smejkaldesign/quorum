// Issue reports the person sends from the app (Report issue in the avatar menu, or Report as issue on an error; the
// relay's POST /v1/reports, migration 0046). Nothing here sends on its own: prepare() gathers what a report could carry
// (the app version, edition, OS, the page, the last log lines for the action and its run id, and a capture of the
// Quorum window when the report starts from an error), the renderer shows all of it and lets the person remove any
// line or screenshot, and send() posts only what they kept. Log lines are masked before the renderer sees them: paths,
// emails, tokens, long quoted text and note names (scrub in errorReports.js plus maskNotes below). A second copy with
// paths and note names kept is offered behind a switch that is off by default. The report goes to a private admin inbox,
// never to GitHub. A signed-in Cloud person may attach their account; the relay reads it from the session token.
import { clipQuoted, scrub } from './errorReports.js';

// the relay's limits (relay/reports.js): 2 MB a screenshot, and the five together under the 8 MB body
export const LIMITS = { title: 200, description: 8000, line: 500, lines: 60, shots: 5, shotBytes: 2 * 1024 * 1024, totalShotBytes: 5 * 1024 * 1024, tail: 400, defaultLines: 20 };

// the newest log lines the main process wrote, kept in memory only, each with its time
export function createLogTail(max = LIMITS.tail, now = () => new Date()) {
  const lines = [];
  const text = (a) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  return {
    push(args) {
      lines.push(`${now().toISOString().slice(11, 19)} ${text(Array.isArray(args) ? args : [args]).slice(0, 2000)}`);
      if (lines.length > max) lines.splice(0, lines.length - max);
    },
    lines: () => lines.slice(),
  };
}

// note names become <note>: [[wiki links]], quoted names ending in .md, vault paths ending in .md (the file name may
// hold spaces after its folder), and bare file names ending in .md
export const maskNotes = (s) => String(s ?? '')
  .replace(/\[\[[^\]\n]+\]\]/g, '[[<note>]]')
  .replace(/(["'`])[^"'`\n]*?\.md\1/g, '$1<note>.md$1')
  .replace(/(?:[^\s/'"`()[\]<>]+\/)+[^/'"`()[\]<>\n]*?\.md\b/g, '<note>.md')
  .replace(/[^\s/'"`()[\]<>]+\.md\b/g, '<note>.md');

// every name the vault knows (note titles, aliases, frontmatter names, dead link targets) becomes <note> wherever it
// stands, longest first, as a whole word in any case. Log lines name notes without brackets or .md (an alias added, a
// link fixed), so the masking reads the names from the vault index instead of relying on how the line is written
const escape = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function nameMasker(names = []) {
  const list = [...new Set(names.map((n) => String(n ?? '').trim()).filter((n) => n.length >= 3))].sort((x, y) => y.length - x.length);
  const res = [];
  for (let i = 0; i < list.length; i += 400) res.push(new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.slice(i, i + 400).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu'));
  return (s) => res.reduce((acc, re) => acc.replace(re, '<note>'), String(s ?? ''));
}

// quoted text can be a title or a note's words whatever its length: double and curly quoted values become <text> (a JSON
// key, a quoted string followed by a colon, stays so the line keeps its shape), and single-quoted text with a space in it
// too; a single-quoted word such as 'map' in an error stays
export const maskQuoted = (s) => String(s ?? '')
  .replace(/"((?:[^"\\\n]|\\.)*)"(\s*:)?/g, (m, body, key) => (key || !body ? m : '"<text>"'))
  .replace(/“[^”\n]*”/g, '“<text>”')
  .replace(/'([^'\n]*\s[^'\n]*)'/g, "'<text>'");

// the masked line. By default paths, emails, tokens, note names (by shape and by the vault's own names) and quoted text
// are masked. keepPaths (the "Include note names and paths" switch) keeps paths and names, and still masks emails and
// tokens and shortens long quoted text the same way as the default
export function maskLine(line, { home = '', appRoot = '', keepPaths = false, names = (x) => x } = {}) {
  const s = String(line ?? '');
  if (keepPaths) return clipQuoted(s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>').replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp]|eyJ)[\w-]{12,}/g, '<token>').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>'));
  return maskQuoted(names(maskNotes(scrub(s, { home, appRoot }))));
}

// the lines for this report: the ones that name the run id or the action when either is given and any match, else the
// newest few. Oldest first, the way the log reads.
export function pickLines(all, { runId = null, action = null, max = LIMITS.defaultLines } = {}) {
  const keys = [runId, action].filter((k) => typeof k === 'string' && k.trim().length >= 3).map((k) => k.trim().toLowerCase());
  const hit = keys.length ? all.filter((l) => keys.some((k) => l.toLowerCase().includes(k))) : [];
  return (hit.length ? hit : all).slice(-max);
}

// a window capture as a data URL under the relay's 2 MB limit: wider than 1600 px is scaled down, a PNG over the limit
// becomes a JPEG. img is an Electron NativeImage
export function encodeCapture(img, { maxWidth = 1600, maxBytes = LIMITS.shotBytes } = {}) {
  if (!img || img.isEmpty?.()) return null;
  const { width } = img.getSize();
  const fit = width > maxWidth ? img.resize({ width: maxWidth, quality: 'good' }) : img;
  const png = fit.toPNG();
  if (png.length <= maxBytes) return `data:image/png;base64,${png.toString('base64')}`;
  for (const q of [80, 60, 40]) {
    const jpg = fit.toJPEG(q);
    if (jpg.length <= maxBytes) return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  }
  return null;
}

const clip = (s, n) => String(s ?? '').slice(0, n);
const RUN_ID = /^[\w.:-]{1,80}$/;
const DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

// the body the relay takes, from what the person kept on the sheet; anything else the renderer sent is dropped
export function reportBody(draft, { install, edition, version, os, now = () => new Date() }) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const shots = (Array.isArray(d.screenshots) ? d.screenshots : []).filter((s) => typeof s === 'string' && DATA_URL.test(s)).slice(0, LIMITS.shots);
  return {
    install, edition, version, os,
    view: clip(String(d.view ?? '').replace(/[^\w/:-]/g, ''), 120),
    title: clip(String(d.title ?? '').trim(), LIMITS.title),
    description: clip(String(d.description ?? '').trim(), LIMITS.description),
    logLines: (Array.isArray(d.logLines) ? d.logLines : []).filter((l) => typeof l === 'string').slice(-LIMITS.lines).map((l) => clip(l, LIMITS.line)),
    runId: typeof d.runId === 'string' && RUN_ID.test(d.runId) ? d.runId : null,
    screenshots: shots.map((data) => ({ data })),
    // the time the Review step showed, when it is a real time from the last hour; otherwise now
    at: (() => { const t = typeof d.at === 'string' ? Date.parse(d.at) : NaN; const n = now().getTime(); return new Date(!Number.isNaN(t) && t <= n && n - t < 3600000 ? t : n).toISOString(); })(),
  };
}

export function createIssueReports({ installId, version, edition, os, appRoot = '', home = '', tail, names = () => [], capture = async () => null, session = async () => null, send, now = () => new Date(), log = () => {} }) {
  const opts = { home, appRoot };
  return {
    // everything the sheet can show; nothing leaves the Mac here. capture is true when the report starts from an error,
    // so the window is captured before the sheet covers it
    async prepare(ctx = {}, { capture: grab = capture } = {}) {
      const runId = typeof ctx.runId === 'string' && RUN_ID.test(ctx.runId) ? ctx.runId : null;
      const raw = pickLines(tail.lines(), { runId, action: typeof ctx.action === 'string' ? ctx.action : null });
      let known = [];
      try { known = names(); } catch (e) { log('issue report: names', e?.message); }
      const masked = { ...opts, names: nameMasker(known) };
      let screenshot = null;
      if (ctx.capture === true) { try { screenshot = await grab(); } catch (e) { log('issue report: capture', e?.message); } }
      let account = null;
      try { const s = await session(); if (s?.email) account = { email: s.email }; } catch {}
      return {
        version, edition, os,
        view: clip(String(ctx.view ?? '').replace(/[^\w/:-]/g, ''), 120),
        runId,
        install: installId(),
        message: ctx.message ? maskLine(clip(ctx.message, 2000), masked) : '',
        lines: raw.map((l) => clip(maskLine(l, masked), LIMITS.line)),
        linesWithPaths: raw.map((l) => clip(maskLine(l, { ...opts, keepPaths: true }), LIMITS.line)),
        screenshot,
        account,
      };
    },
    // posts what the person kept; attachAccount adds the Cloud session token so the relay records the account
    async send(draft) {
      const body = reportBody(draft, { install: installId(), edition, version, os, now });
      if (!body.title && !body.description) return { ok: false, error: 'Add a title or a description first.' };
      const headers = { 'content-type': 'application/json' };
      if (draft?.attachAccount === true) { try { const s = await session(); if (s?.token) headers.authorization = `Bearer ${s.token}`; } catch {} }
      try {
        const r = await send(JSON.stringify(body), headers);
        if (r?.status === 202 || r?.ok) return { ok: true };
        let error = null;
        try { error = (await r.json())?.error ?? null; } catch {}
        log('issue report: relay answered', r?.status);
        return { ok: false, error: error || `The report could not be sent (${r?.status ?? 'no answer'}). Try again.` };
      } catch (e) {
        log('issue report: send', e?.message);
        return { ok: false, error: 'Quorum could not reach its server. Check the connection and try again.' };
      }
    },
  };
}
