// Guardrails: the one rule set behind what an agent may read from the Agent OS and what it may say about it. Four
// built-in rules ship on; the connected Agent OS can offer more (its own guard hooks and opt-out lists), which the
// person reviews and includes the way memory power-ups are reviewed; the person adds their own; and in Cloud a
// workspace's admins add rules that reach every member's Mac and cannot be turned off there. compile() turns the
// effective list into what each enforcement point consumes: the read guard's flags and hook list, the deny folders,
// and the term filter the suggester, the transcript redactor and the MCP server share. Pure Node; the app passes in
// settings and the Agent OS root.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const KINDS = ['path', 'frontmatter', 'secret', 'term', 'hook'];
export const SECRET_NAMES = String.raw`(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)(\.pub)?|.*secret.*|.*credential.*|.*\.token|google-client-secret\.json)$`;
export const PRIVATE_FOLDER = /personal|private/i;

export const BUILT_IN = [
  { id: 'built-in:secrets', kind: 'secret', label: 'Secret-looking files', what: 'Files named like keys, tokens, .env files and credentials are never read.', value: SECRET_NAMES },
  { id: 'built-in:private-folders', kind: 'path', label: 'Private folders', what: 'Folders named personal or private, plus .git and node_modules, are never read or searched.', value: 'personal|private' },
  { id: 'built-in:confidential', kind: 'frontmatter', label: 'Notes marked confidential', what: 'A note with confidential: in its frontmatter is never read, synced or shared.', value: 'confidential' },
  { id: 'built-in:opt-outs', kind: 'term', label: 'Opted-out people and companies', what: 'Lines naming anyone on your opt-out list (Settings, Admin, General) are withheld from transcripts, answers and the MCP server.', value: '' },
];

// hook classification: by what the script does and where it runs, never by its file name alone
const GUARD_WORDS = /guard|secret|opt[- ]?out|opted|confidential|redact|withh|deny|tripwire|private|sensitive|\bpii\b/i;
const OTHER_WORDS = /memory|capture|session|reindex|ping|status ?line|format|lint|deploy|\bgit\b|commit|slack|notif|telemetry|emit|compact|sync|audit|logger/i;
const READ_TOOLS = /\b(Read|Grep|Glob)\b/;
const firstSentence = (text) => {
  const lines = text.split('\n').map((l) => l.replace(/^#!.*$|^["'#/*\s-]+|["'*\s]+$/g, '').trim()).filter((l) => l && !/^(import|from|set -|export |const |let )/.test(l));
  const s = lines.join(' ').split(/(?<=\.)\s/)[0] ?? '';
  return s.slice(0, 160);
};

export function classifyHook({ name, text = '', events = [] }) {
  const head = text.split('\n').slice(0, 30).join('\n');
  const guard = GUARD_WORDS.test(name) || GUARD_WORDS.test(head);
  const other = OTHER_WORDS.test(name) || OTHER_WORDS.test(head);
  if (!guard) return { relevant: false, reason: other ? 'does something else (memory, sessions, formatting or notifications), not a guard' : 'no sign that it guards reads or output' };
  const onReads = events.some((e) => (e.event === 'PreToolUse' && READ_TOOLS.test(e.matcher ?? '')) || (e.event === 'PostToolUse' && /Read|Grep/.test(e.matcher ?? '')));
  if (events.length && !onReads) return { relevant: false, reason: `runs on ${[...new Set(events.map((e) => e.matcher || 'every tool'))].join(', ')}, which Quorum's agent does not use` };
  const stage = events.some((e) => e.event === 'PostToolUse') ? 'post' : 'pre';
  return { relevant: true, mixed: other, stage, summary: firstSentence(head) || 'A guard hook from your Agent OS.' };
}

// the hooks the Agent OS wires in its own settings file, by script basename
function wiredHooks(root) {
  const out = {};
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    try {
      const s = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      for (const [event, list] of Object.entries(s.hooks ?? {})) for (const h of list ?? []) for (const x of h.hooks ?? []) {
        const base = String(x.command ?? '').split(/\s+/).find((p) => /\.(py|sh|mjs|js)$/.test(p));
        if (!base) continue;
        (out[path.basename(base.replace(/["']/g, ''))] ??= []).push({ event, matcher: h.matcher ?? '*' });
      }
    } catch {}
  }
  return out;
}

// what the connected Agent OS offers: guard hooks (relevant ones only) and opt-out term lists. Everything else the
// folder's hooks do is listed in `skipped` with the reason, so the review is visibly diligent rather than silent
export function discover(root, vault = root) {
  const candidates = [];
  const skipped = [];
  const hooksDir = path.join(root, '.claude/hooks');
  const wired = wiredHooks(root);
  let names = [];
  try { names = readdirSync(hooksDir).filter((n) => !n.startsWith('.') && !n.startsWith('__') && /\.(py|sh|mjs|js)$/.test(n) && statSync(path.join(hooksDir, n)).isFile()); } catch {}
  for (const name of names.sort()) {
    const abs = path.join(hooksDir, name);
    let text = ''; try { text = readFileSync(abs, 'utf8').slice(0, 6000); } catch {}
    const c = classifyHook({ name, text, events: wired[name] ?? [] });
    if (!c.relevant) { skipped.push({ name, reason: c.reason }); continue; }
    candidates.push({ id: `agent-os:hook:${name}`, kind: 'hook', label: name, path: abs, value: abs, what: c.summary, stage: c.stage, mixed: c.mixed, wired: !!wired[name] });
  }
  for (const rel of ['scripts/embed-bench/excluded.txt', 'scripts/opt-outs.txt', '.claude/opt-outs.txt']) {
    const abs = [path.join(vault, rel), path.join(root, rel)].find(existsSync);
    if (!abs) continue;
    let n = 0; try { n = readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length; } catch {}
    candidates.push({ id: `agent-os:terms:${rel}`, kind: 'term', label: 'Opt-out term list', path: abs, value: `@${abs}`, what: `${n} ${n === 1 ? 'name' : 'names'} withheld wherever they appear in transcripts, answers and the MCP server.`, mixed: false, wired: true });
    break;
  }
  return { candidates, skipped };
}

const readTerms = (file) => { try { return readFileSync(file, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')); } catch { return []; } };

// the effective list: built-ins (on unless turned off), included Agent OS items, the person's rules, and workspace
// rules, which are locked on. The most restrictive combination applies, since every rule only ever denies
export function effective(state = {}, discovery = { candidates: [] }) {
  const out = [];
  for (const b of BUILT_IN) out.push({ ...b, source: 'built-in', enabled: state.builtIns?.[b.id] !== false, locked: false });
  for (const c of discovery.candidates ?? []) {
    const decision = state.agentOs?.[c.id] ?? null;
    out.push({ ...c, source: 'agent-os', enabled: decision === 'included', decision, locked: false });
  }
  for (const r of state.rules ?? []) if (KINDS.includes(r.kind) && r.kind !== 'hook') out.push({ ...r, source: 'personal', enabled: r.enabled !== false, locked: false });
  for (const r of state.workspace ?? []) if (KINDS.includes(r.kind) && r.kind !== 'hook' && r.enabled !== false) out.push({ ...r, source: 'workspace', enabled: true, locked: true });
  return out;
}

// what each enforcement point consumes. denyDirs are relative to the root; frontmatterKeys are matched case-insensitively
export function compile(rules, { root = null, privateDirs = () => [] } = {}) {
  const on = rules.filter((r) => r.enabled);
  const denyDirs = new Set();
  const frontmatterKeys = new Set();
  const terms = new Set();
  const termFiles = [];
  const hooks = [];
  let secretPattern = null;
  for (const r of on) {
    if (r.kind === 'path') { if (r.id === 'built-in:private-folders') { for (const d of root ? privateDirs(root) : []) denyDirs.add(d); } else for (const p of String(r.value).split(/[\n,]/).map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean)) denyDirs.add(p); }
    else if (r.kind === 'frontmatter') for (const k of String(r.value).split(/[\n,]/).map((s) => s.trim().replace(/:$/, '').toLowerCase()).filter(Boolean)) frontmatterKeys.add(k);
    else if (r.kind === 'secret') secretPattern = secretPattern ? `${secretPattern}|${r.value}` : String(r.value);
    else if (r.kind === 'term') {
      if (String(r.value).startsWith('@')) termFiles.push(String(r.value).slice(1));
      else for (const t of String(r.value).split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3)) terms.add(t);
    } else if (r.kind === 'hook') hooks.push({ path: r.path ?? r.value, stage: r.stage ?? 'pre' });
  }
  const secretsOn = on.some((r) => r.id === 'built-in:secrets');
  return {
    denyDirs: [...denyDirs], frontmatterKeys: [...frontmatterKeys], secretPattern, secretsOff: !secretsOn && !secretPattern,
    terms: [...terms], termFiles, hooks,
    allTerms: () => [...terms, ...termFiles.flatMap(readTerms)],
    optOutsOn: on.some((r) => r.id === 'built-in:opt-outs'),
  };
}

// the live test on the Guardrails page: would this path be denied, and why
export function wouldBlock(compiled, rel, head = '') {
  const clean = String(rel).replace(/^\/+/, '');
  for (const d of ['.git', 'node_modules', ...compiled.denyDirs]) if (clean === d || clean.startsWith(`${d}/`) || `/${clean}/`.includes(`/${d}/`)) return `${d}/ is private`;
  const secret = compiled.secretsOff ? null : new RegExp(compiled.secretPattern ?? SECRET_NAMES, 'i');
  if (secret && secret.test(clean)) return 'looks like a secret or credential';
  if (head.startsWith('---')) {
    const end = head.indexOf('\n---', 3);
    const block = head.slice(3, end > 0 ? end : undefined);
    for (const k of compiled.frontmatterKeys) if (new RegExp(`^\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'im').test(block)) return `marked ${k}: in its frontmatter`;
  }
  return null;
}

const readDenials = (file, n = 30) => { try { return readFileSync(file, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; } };

// the app's handle: state in settings.guardrails, discovery cached per root, the compiled set cached until something changes
export function createGuardrails({ settings, saveSettings = () => {}, brain = () => null, privateDirs = () => [], denialLog = null, log = () => {} }) {
  const state = () => (settings.guardrails ??= { builtIns: {}, agentOs: {}, rules: [], workspace: [] });
  let discovered = { root: null, at: 0, result: { candidates: [], skipped: [] } };
  let compiledCache = { key: '', value: null };
  let remote = null;
  const discovery = (force = false) => {
    const b = brain();
    if (!b) return { candidates: [], skipped: [] };
    if (!force && discovered.root === b.root && Date.now() - discovered.at < 60000) return discovered.result;
    discovered = { root: b.root, at: Date.now(), result: discover(b.root, b.vault ?? b.root) };
    // an install that already relied on the vault's opt-out list keeps it; a new connect reviews it first
    const s = state();
    if (!s.migrated) { for (const c of discovered.result.candidates) if (c.kind === 'term' && settings.memory) s.agentOs[c.id] = 'included'; s.migrated = true; saveSettings(); }
    return discovered.result;
  };
  const rules = () => effective(state(), discovery());
  const compiled = () => {
    const b = brain();
    const list = rules();
    const key = JSON.stringify([b?.root, list.map((r) => [r.id, r.enabled, r.value])]);
    if (compiledCache.key === key && compiledCache.value) return compiledCache.value;
    const value = compile(list, { root: b?.root ?? null, privateDirs });
    compiledCache = { key, value };
    // the CLI and the suggester read this snapshot from settings.json, so they apply the same rules without the app
    const snapshot = { denyDirs: value.denyDirs, frontmatterKeys: value.frontmatterKeys, terms: value.terms, termFiles: value.termFiles, secretPattern: value.secretPattern, secretsOff: value.secretsOff, optOutsOn: value.optOutsOn };
    if (JSON.stringify(state().compiled) !== JSON.stringify(snapshot)) { state().compiled = snapshot; saveSettings(); }
    return value;
  };
  const save = () => { compiledCache = { key: '', value: null }; saveSettings(); };
  const get = async () => {
    if (remote) { try { const r = await remote(); if (Array.isArray(r)) { state().workspace = r; } } catch (e) { log('guardrails workspace', e?.message ?? e); } }
    const d = discovery();
    const list = rules();
    const c = compiled();
    return {
      rules: list.map(({ decision, ...r }) => ({ ...r, decision: decision ?? null })),
      skipped: d.skipped,
      denials: denialLog ? readDenials(denialLog) : [],
      summary: { on: list.filter((r) => r.enabled).length, toReview: list.filter((r) => r.source === 'agent-os' && r.decision === null).length, denyDirs: c.denyDirs.length, terms: c.allTerms().length },
    };
  };
  return {
    get, compiled, rules, discovery,
    setRemote: (fn) => { remote = fn; },
    set: (id, patch) => {
      const s = state();
      if (id.startsWith('built-in:') && typeof patch?.enabled === 'boolean') s.builtIns[id] = patch.enabled;
      else if (id.startsWith('agent-os:') && typeof patch?.enabled === 'boolean') s.agentOs[id] = patch.enabled ? 'included' : 'excluded';
      else { const r = s.rules.find((x) => x.id === id); if (!r) return { error: 'Unknown rule.' }; if (typeof patch?.enabled === 'boolean') r.enabled = patch.enabled; if (typeof patch?.label === 'string') r.label = patch.label.slice(0, 120); }
      save(); return { ok: true };
    },
    add: ({ kind, value, label }) => {
      if (!['path', 'frontmatter', 'secret', 'term'].includes(kind)) return { error: 'Pick what the rule matches: a folder, a frontmatter key, a file name pattern or a term.' };
      const v = String(value ?? '').trim();
      if (!v || v.length > 500) return { error: 'The rule needs a value under 500 characters.' };
      if (kind === 'secret') { try { new RegExp(v); } catch { return { error: 'That is not a valid pattern.' }; } }
      const s = state();
      const id = `personal:${Date.now().toString(36)}`;
      s.rules.push({ id, kind, value: v, label: String(label ?? '').trim().slice(0, 120) || v.slice(0, 60), enabled: true, addedAt: new Date().toISOString() });
      save(); return { ok: true, id };
    },
    remove: (id) => { const s = state(); const n = s.rules.length; s.rules = s.rules.filter((r) => r.id !== id); if (s.rules.length === n) return { error: 'Only your own rules can be removed.' }; save(); return { ok: true }; },
    test: (rel) => {
      const b = brain();
      if (!b) return { blocked: null };
      const clean = String(rel ?? '').trim().replace(/^\/+/, '');
      if (!clean) return { blocked: null };
      let head = ''; try { head = readFileSync(path.join(b.vault ?? b.root, clean), 'utf8').slice(0, 2048); } catch {}
      return { blocked: wouldBlock(compiled(), clean, head) };
    },
  };
}
