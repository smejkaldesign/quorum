// Page crash reports (docs: the error report contract). A view that fails while drawing calls report() from the
// renderer through preload; this turns the raw error into a scrubbed report and posts it to the relay's /v1/errors,
// which groups reports by fingerprint for the admin Errors page. On by default; settings.errorReports === false turns
// it off. A report carries the app version, edition, macOS version, the page, the message, a stack mapped back to
// source files through the hidden source maps in dist/, the React component stack and an anonymous install id. It never
// carries note text, file paths outside the app, emails or tokens; scrub() removes them, and the limits below cap size.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMapConsumer } from 'source-map-js';

export const LIMITS = { message: 500, stack: 8000, componentStack: 4000, view: 80 };

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

// paths outside the app become ~ or <path>, emails and long tokens become placeholders, and quoted text longer than a
// few words (which can be a note's own words) is cut to its first characters
export function scrub(text, { home = '', appRoot = '' } = {}) {
  let s = String(text ?? '');
  if (appRoot) s = s.split(`file://${appRoot}/`).join('').split(`${appRoot}/`).join('');
  if (home) s = s.split(home).join('~');
  s = s.replace(/file:\/\/\/[^\s)'"]+/g, '<path>');
  s = s.replace(/(?<![\w.])\/(?:Users|Volumes|private|var|tmp)\/[^\s)'"]+/g, '<path>');
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
  s = s.replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp]|eyJ)[\w-]{12,}/g, '<token>');
  s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>');
  s = s.replace(/(["“'])([^"”'\n]{40,})(["”'])/g, (_m, a, body, b) => `${a}${body.slice(0, 24)}…${b}`);
  return s;
}

// a stack frame's file, line and column: "at fn (file:///…/dist/assets/index-abc.js:1:2345)" or "at file:…:1:2"
const FRAME = /(?:at\s+(?:(.+?)\s+\()?)?((?:file|https?):\/\/[^\s)]+?):(\d+):(\d+)\)?/;

// maps each frame that points into dist/assets back to its source file and line, using the .map file beside the
// bundle (vite builds with sourcemap: 'hidden', so the maps ship without the bundle pointing at them)
export function symbolicate(stack, { readMap = (file) => readFileSync(`${file}.map`, 'utf8') } = {}) {
  const maps = new Map();
  const consumer = (file) => {
    if (!maps.has(file)) { try { maps.set(file, new SourceMapConsumer(JSON.parse(readMap(file)))); } catch { maps.set(file, null); } }
    return maps.get(file);
  };
  return String(stack ?? '').split('\n').map((line) => {
    const m = line.match(FRAME);
    if (!m) return line;
    const [, fn, url, ln, col] = m;
    let file;
    try { file = url.startsWith('file:') ? fileURLToPath(url) : null; } catch { file = null; }
    const c = file ? consumer(file) : null;
    if (!c) return line;
    const p = c.originalPositionFor({ line: Number(ln), column: Number(col) - 1 });
    if (!p?.source) return line;
    const src = p.source.replace(/^(?:\.\.\/)+/, '').replace(/^webpack:\/\/\//, '');
    return `    at ${p.name || fn || '<anonymous>'} (${src}:${p.line}:${(p.column ?? 0) + 1})`;
  }).join('\n');
}

// the same cause gives the same fingerprint across Macs and builds: numbers and quoted text in the message are
// normalized, and only the top five frames' file and line count, with the page
export function fingerprint({ message, stack, view }) {
  const msg = String(message ?? '').replace(/(["“'`]).*?(["”'`])/g, '"…"').replace(/\d+/g, 'N');
  const frames = String(stack ?? '').split('\n').map((l) => l.match(/\(?([^\s()]+\.[jt]sx?):(\d+):\d+\)?\s*$/)).filter(Boolean).slice(0, 5).map((m) => `${m[1]}:${m[2]}`);
  return createHash('sha256').update([msg, ...frames, view].join('\n')).digest('hex');
}

export function createErrorReports({ dataDir, version, edition, os, appRoot, home = '', enabled = () => true, send, readMap, now = () => new Date(), log = () => {} }) {
  const sent = new Set();
  let install = null;
  const installId = () => {
    if (install) return install;
    const f = path.join(dataDir, 'install-id');
    try { if (existsSync(f)) install = readFileSync(f, 'utf8').trim(); } catch {}
    if (!/^[0-9a-f-]{36}$/.test(install ?? '')) {
      install = randomUUID();
      try { mkdirSync(dataDir, { recursive: true }); writeFileSync(f, install); } catch (e) { log('error reports: install id', e?.message); }
    }
    return install;
  };
  // the report for one crash, or null when reports are off or this crash (and its repeat state) was sent this session
  const build = (raw) => {
    if (!enabled()) return null;
    const view = clip(String(raw?.view ?? 'root').replace(/[^\w/:-]/g, ''), LIMITS.view) || 'root';
    const opts = { home, appRoot };
    const stack = clip(scrub(symbolicate(raw?.stack ?? '', { readMap }), opts), LIMITS.stack);
    const message = clip(scrub(raw?.message ?? 'Unknown error', opts), LIMITS.message);
    const fp = fingerprint({ message, stack, view });
    const repeat = !!raw?.repeat;
    const key = `${fp}:${repeat}`;
    if (sent.has(key)) return null;
    sent.add(key);
    return { install: installId(), edition, version, os, view, kind: 'render', repeat, message, stack, componentStack: clip(scrub(raw?.componentStack ?? '', opts), LIMITS.componentStack), fingerprint: fp, at: now().toISOString() };
  };
  return {
    build,
    // the anonymous install id issue reports share (issueReports.js), so the relay counts one Mac once across both
    installId,
    // posts the report; a failure is logged and dropped, so a crash never waits on the network
    report: async (raw) => {
      const body = build(raw);
      if (!body) return false;
      try { const r = await send(body); if (!r?.ok && r?.status !== 202) log('error reports: relay answered', r?.status); return true; } catch (e) { log('error reports: send', e?.message); return false; }
    },
  };
}
