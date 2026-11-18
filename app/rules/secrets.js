// Secrets in notes: lines that hold a key, token or password, by known patterns and by a high-entropy value assigned
// to a key-like name. A finding names the line number and the kind only; the value never leaves this function, so it
// never reaches the window, a log or the decision log. Placeholders (xxx, your-key, <token>, example) are skipped.
// These findings never offer an automatic fix: the person rotates the secret and removes it.
import { finding, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.secret', version: 1, label: 'Secrets written in notes' };
export const PATTERNS = [
  { kind: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/ },
  { kind: 'Stripe secret key', re: /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/ },
  { kind: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { kind: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];
const ASSIGN = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{20,})/i;
const PLACEHOLDER = /(x{4,}|\*{3,}|example|sample|dummy|placeholder|your[_-]|changeme|redacted|<[^>]*>|\.\.\.|test[_-]?key|fake)/i;
export const MIN_ENTROPY = 3.5;
// bits per character of a string, by its own character counts
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let e = 0;
  for (const c of n.values()) { const p = c / s.length; e -= p * Math.log2(p); }
  return e;
}
// the kind of secret on a line, or null; never the value
export function secretKind(line) {
  for (const p of PATTERNS) { const m = line.match(p.re); if (m && !PLACEHOLDER.test(m[0])) return p.kind; }
  const a = line.match(ASSIGN);
  if (a && !PLACEHOLDER.test(a[2]) && !/^(true|false|null|undefined)$/i.test(a[2]) && entropy(a[2]) >= MIN_ENTROPY && /\d/.test(a[2]) && /[A-Za-z]/.test(a[2])) return 'Password or key in a setting';
  return null;
}

// only: the notes that changed; a line can only hold a new secret in a note that changed
export function run({ notes, only = null }) {
  const want = only ? new Set(only) : null;
  const out = [];
  for (const n of notes) {
    if (skipped(n) || (want && !want.has(n.rel))) continue;
    const hits = [];
    n.text.split('\n').forEach((l, i) => { if (l.length < 4000) { const k = secretKind(l); if (k) hits.push({ line: i + 1, kind: k }); } });
    if (!hits.length) continue;
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: [n.rel],
      title: `${quote(n.note?.title ?? n.rel)} may hold ${plural(hits.length, 'secret')}`,
      problem: 'A key, token or password written in a note can reach an agent, a sync or a shared screen. Treat it as exposed.',
      proposal: 'Rotate the secret where it was issued, then remove it from the note and keep it in a password manager or a .env file. Quorum does not change the note for you.',
      evidence: hits.slice(0, 8).map((h) => `Line ${h.line}: ${h.kind}`),
      facts: hits.map((h) => `${h.kind}@${h.line}`), meta: [['Note', n.rel], ['Lines', hits.map((h) => h.line).join(', ')]],
    }));
  }
  return out;
}
