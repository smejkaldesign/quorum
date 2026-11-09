// Runs scripts/check-founder-content.mjs against a throwaway git repository. The planted strings are assembled from
// pieces so this test file passes the guard when it scans the real tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/check-founder-content.mjs', import.meta.url));
const HOME_PATH = ['/Us', 'ers/jane/Documents/notes.md'].join('');
const PRIVATE_EMAIL = ['jane@', 'personal-mail.org'].join('');
const BOT = ['rick', 'bot'].join('');
const PERSON = ['Eric ', 'Smej', 'kal'].join('');
const COMPANY = ['Smej', 'kal Design'].join('');
const INTERNAL = ['Head', 'ways'].join('');
let root;

function repo(files) {
  root = mkdtempSync(path.join(tmpdir(), 'quorum-founder-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  writeFileSync(path.join(root, '.founder-guard-allow'), `# literals the guard ignores\n${COMPANY}\n`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  execFileSync('git', ['-C', root, 'add', '-A']);
  return root;
}

const run = () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { status: r.status, lines: r.stdout.trim().split('\n').filter(Boolean), err: r.stderr };
};

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('founder content guard', () => {
  it('passes a clean tree and lets allowed literals, allowed emails and licenses through', () => {
    repo({
      'README.md': `# Quorum\n\nBuilt by ${COMPANY}. Mail team@quorum.watch or demo@example.com.\n`,
      'app/package.json': `{ "author": "${COMPANY}", "appId": "design.smejkal.quorum" }\n`,
      'app/package-lock.json': `{ "deprecated": "contact ${PRIVATE_EMAIL}" }\n`,
      'app/assets/make.swift': 'let name = "dmg-background@2x.png"\n',
      LICENSE: `Copyright ${PERSON} <${PRIVATE_EMAIL}>\n`,
      NOTICE: `${PERSON}\n`,
      'app/ee/LICENSE': `${PERSON}\n`,
    });
    const r = run();
    expect(r.err).toBe('');
    expect(r.lines).toEqual(['founder content guard: ok']);
    expect(r.status).toBe(0);
  });

  it('reports file:line for each planted string and never the content', () => {
    repo({
      'docs/clean.md': '# Clean\n\nNothing here.\n',
      'docs/leak.md': [
        '# Notes',                              // 1
        `Vault at ${HOME_PATH}`,                // 2 home path
        `Contact ${PRIVATE_EMAIL}`,             // 3 private email
        `Deployed by ${BOT}`,                   // 4 internal name
        `Written by ${PERSON}`,                 // 5 person name
        `Thanks to ${COMPANY}`,                 // 6 allowed literal
        `See ${INTERNAL} for the old plan`,     // 7 internal project
        'The herd grazed; the vantage point.',  // 8 lowercase words that share letters with flagged names
        '',
      ].join('\n'),
    });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(['docs/leak.md:2', 'docs/leak.md:3', 'docs/leak.md:4', 'docs/leak.md:5', 'docs/leak.md:7']);
    expect(r.err.trim()).toBe('founder content guard: 5 lines in 1 file');
    for (const secret of ['jane', PRIVATE_EMAIL, BOT, PERSON, INTERNAL]) expect(r.lines.join('\n') + r.err).not.toContain(secret);
  });

  it('skips binary files and untracked files', () => {
    repo({ 'docs/clean.md': '# Clean\n' });
    writeFileSync(path.join(root, 'untracked.md'), `${PERSON}\n`);
    writeFileSync(path.join(root, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
    writeFileSync(path.join(root, 'blob.bin'), Buffer.concat([Buffer.from(PERSON), Buffer.from([0]), Buffer.from(PERSON)]));
    execFileSync('git', ['-C', root, 'add', 'blob.png', 'blob.bin']);
    expect(run()).toMatchObject({ status: 0, lines: ['founder content guard: ok'] });
  });
});
