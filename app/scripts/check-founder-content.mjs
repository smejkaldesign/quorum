#!/usr/bin/env node
// Founder content guard: fails when a tracked file carries personal or internal strings that do not belong in a public
// repository. Flags home paths (/Users/<name>/), email addresses outside @quorum.watch and @example.com, internal
// project names, and the founder's surname. Literals listed in .founder-guard-allow at the repo root (one per line)
// are removed from a line before it is matched, so the company name passes while the person's name does not.
// Prints file:line only, never the matching text. Usage: check-founder-content.mjs [--root <repo>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootArg = process.argv.indexOf('--root');
const root = rootArg !== -1 && process.argv[rootArg + 1]
  ? path.resolve(process.argv[rootArg + 1])
  : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// licenses name the copyright holder by design; the guard and its allowlist hold the literals they look for; the
// lockfiles are generated and carry upstream maintainers' contact lines
const EXEMPT = new Set(['LICENSE', 'NOTICE', 'app/ee/LICENSE', 'relay/LICENSE', 'app/scripts/check-founder-content.mjs', '.founder-guard-allow', 'app/package-lock.json', 'app/lint/package-lock.json']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.icns', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.dmg', '.mp3', '.wav']);

// the domain starts with a letter so a retina filename such as image@2x.png does not read as an address
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(?:quorum\.watch|example\.com)$/i;
const RULES = [
  /\/Users\/[^/\s'"`]+\//,
  /rickbot|headways/i,
  /\b(?:Herd|Ilma|Vanta)\b/,
  /\bSmejkal\b/,
];

const allowFile = path.join(root, '.founder-guard-allow');
const allow = existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];
const mask = (line) => allow.reduce((acc, literal) => acc.split(literal).join(''), line);

const flagged = (line) => {
  const text = mask(line);
  if (RULES.some((re) => re.test(text))) return true;
  for (const m of text.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) return true;
  return false;
};

const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];
for (const rel of files) {
  if (EXEMPT.has(rel) || BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
  const abs = path.join(root, rel);
  if (!existsSync(abs)) continue;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => { if (flagged(line)) hits.push(`${rel}:${i + 1}`); });
}

if (hits.length) {
  for (const h of hits) console.log(h);
  const fileCount = new Set(hits.map((h) => h.slice(0, h.lastIndexOf(':')))).size;
  console.error(`founder content guard: ${hits.length} line${hits.length === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('founder content guard: ok');
