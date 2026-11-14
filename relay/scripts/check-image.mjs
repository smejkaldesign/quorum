#!/usr/bin/env node
// Builds the tree the relay image gets in a temporary folder, then imports relay/server.js and relay/kbSyncWorker.js
// there with placeholder settings. An import the image would not have fails here, before a deploy does. Run from
// relay/ after npm ci: npm run check:image
//
// The tree follows what Railway does: the build context is the repository minus what the root .railwayignore leaves
// out (gitignore syntax: the last matching rule wins, ! re-includes, a trailing / matches folders only, a pattern with
// a / inside is anchored at the root, and nothing under an ignored folder can be re-included). The Dockerfile's COPY
// lines then copy from that context: a named file the context does not have fails, as the build does; a glob or a
// folder copies only what the context has.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
// one gitignore pattern as a regular expression over a path relative to the root, with / separators
function patternRe(p) {
  const anchored = p.includes('/');
  const body = p.replace(/^\//, '').split('/').map((seg) => (seg === '**' ? '\u0000' : escape(seg).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/')
    .replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000/g, '.*');
  return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
}

export function ignoreRules(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l && !l.startsWith('#')).map((l) => {
    const negate = l.startsWith('!');
    let p = negate ? l.slice(1) : l;
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    return { negate, dirOnly, re: patternRe(p) };
  });
}

// whether rel (a/b/c, no leading slash) is left out: an ignored parent folder leaves out everything inside it
export function isIgnored(rules, rel, isDir) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) if (matches(rules, parts.slice(0, i).join('/'), true)) return true;
  return matches(rules, rel, isDir);
}
function matches(rules, rel, isDir) {
  let out = false;
  for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(rel)) out = !r.negate;
  return out;
}

// the image tree under out: the COPY lines of dockerfile applied to root, with ignore's rules leaving files out
export function buildTree({ root, out, dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8'), ignore = existsSync(path.join(root, '.railwayignore')) ? readFileSync(path.join(root, '.railwayignore'), 'utf8') : '' }) {
  const rules = ignoreRules(ignore);
  const inContext = (rel, isDir) => !isIgnored(rules, rel, isDir);
  const sources = (src) => {
    if (!src.includes('*')) return [src.replace(/\/$/, '')];
    const dir = path.posix.dirname(src);
    const re = new RegExp(`^${escape(path.posix.basename(src)).replace(/\*/g, '[^/]*')}$`);
    return readdirSync(path.join(root, dir)).filter((n) => re.test(n) && statSync(path.join(root, dir, n)).isFile() && inContext(`${dir}/${n}`, false)).map((n) => `${dir}/${n}`);
  };
  const copied = [];
  for (const line of dockerfile.split('\n')) {
    const m = line.match(/^COPY\s+(.+)$/);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    const dest = parts.pop();
    for (const src of parts.flatMap(sources)) {
      const from = path.join(root, src);
      if (!existsSync(from)) throw new Error(`Dockerfile copies ${src}, which does not exist`);
      const isDir = statSync(from).isDirectory();
      if (!inContext(src, isDir)) throw new Error(`Dockerfile copies ${src}, which .railwayignore leaves out of the build`);
      // Docker's rules: a folder's contents go into dest; a file goes into dest/ under its own name, or becomes dest
      const to = isDir ? path.join(out, dest) : dest.endsWith('/') ? path.join(out, dest, path.basename(src)) : path.join(out, dest);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, {
        recursive: true,
        filter: (f) => {
          if (f.includes(`${path.sep}node_modules`)) return false;
          const rel = path.relative(root, f).split(path.sep).join('/');
          return rel === '' || inContext(rel, statSync(f).isDirectory());
        },
      });
      copied.push(src);
    }
  }
  return copied;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = mkdtempSync(path.join(tmpdir(), 'relay-image-'));
  try {
    let copied;
    try { copied = buildTree({ root, out }); } catch (err) { process.stderr.write(`relay image tree failed: ${err.message}\n`); process.exitCode = 1; return; }
    // the image installs the relay's packages and links them for app/, as the Dockerfile does
    symlinkSync(path.join(root, 'relay', 'node_modules'), path.join(out, 'relay', 'node_modules'));
    symlinkSync(path.join(out, 'relay', 'node_modules'), path.join(out, 'app', 'node_modules'));
    const env = {
      PATH: process.env.PATH, NODE_ENV: 'production', PORT: '0',
      SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'placeholder', SUPABASE_SERVICE_ROLE_KEY: 'placeholder', ASSEMBLYAI_API_KEY: 'placeholder',
    };
    const code = "await import('./server.js'); await import('./kbSyncWorker.js'); console.log('relay image imports: ok'); process.exit(0);";
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: path.join(out, 'relay'), env, encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      process.stderr.write(`relay image imports failed (${copied.length} COPY sources):\n${(r.stderr || r.stdout || '').split('\n').filter((l) => /Error|Cannot find|imported from/.test(l)).slice(0, 10).join('\n')}\n`);
      process.exitCode = 1;
    } else process.stdout.write(r.stdout.split('\n').filter((l) => l.includes('relay image imports')).join('\n') + '\n');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
