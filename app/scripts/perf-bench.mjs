// Times the main-process hot paths against a generated vault, so a change to the index, the guardrails or the
// knowledge list can be measured instead of guessed at. Nothing here touches a real vault: the notes are written to
// a temp folder and removed at the end.
//   node scripts/perf-bench.mjs            3000 notes
//   node scripts/perf-bench.mjs 500        another size
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createVaultIndex } from '../vindex.js';
import { createGuardrails } from '../guardrails.js';
import { createPredicates } from '../guardrails-predicates.js';
import { listTeamNotes } from '../ee/knowledge.js';

const N = Number(process.argv[2]) || 3000;
const FOLDERS = ['00-inbox', '01-daily', '03-projects', '05-knowledge', '05-knowledge/people', '08-meetings', '08-meetings/2026'];

function makeVault(n) {
  const root = mkdtempSync(path.join(tmpdir(), 'quorum-bench-'));
  const vault = path.join(root, 'MyBrain');
  for (const f of FOLDERS) mkdirSync(path.join(vault, f), { recursive: true });
  mkdirSync(path.join(root, '.claude/hooks'), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Vault\n\nNever read 02-personal.\n');
  const rels = [];
  for (let i = 0; i < n; i++) {
    const folder = FOLDERS[i % FOLDERS.length];
    const rel = `${folder}/note-${i}.md`;
    const links = [1, 7, 31].map((k) => `[[note-${(i + k) % n}]]`).join(' ');
    const body = `---\ntitle: Note ${i}\ntags: [bench, t${i % 13}]\n---\n# Note ${i}\n\nMeeting notes about project ${i % 50} with ${links}.\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20 + (i % 40))}\n`;
    writeFileSync(path.join(vault, rel), body);
    rels.push(rel);
  }
  return { root, vault, rels };
}

const ms = (t) => `${t.toFixed(1)} ms`;
function time(label, fn, runs = 1) {
  const t0 = performance.now();
  let out;
  for (let i = 0; i < runs; i++) out = fn();
  const per = (performance.now() - t0) / runs;
  console.log(`${label.padEnd(44)} ${ms(per).padStart(12)}${runs > 1 ? `  (x${runs})` : ''}`);
  return out;
}
const { root, vault, rels } = makeVault(N);
try {
  console.log(`vault: ${N} notes\n`);
  // the guardrails exactly as main.js wires them, with the three predicates the index calls per file
  const settings = { guardrails: { builtIns: {}, agentOs: {}, rules: [], workspace: [] } };
  const guardrails = createGuardrails({ settings, brain: () => ({ root, vault }), privateDirs: () => ['02-personal'] });
  const { isPrivatePath, isSecretPath, isConfidentialText } = createPredicates({ guardrails, brain: () => ({ root, vault }) });

  time('guardrails.compiled() per call', () => guardrails.compiled(), N);
  time('isPrivatePath + isSecretPath per file', () => { for (const r of rels) { isPrivatePath(r); isSecretPath(r); } });

  const index = createVaultIndex({
    vault, isExcludedPath: (rel) => isPrivatePath(rel) || isSecretPath(rel), isDeniedText: isConfidentialText,
    isExcludedText: () => false, redact: (t) => t, onChange: () => {},
  });
  // the build yields between batches; the longest stretch the event loop was held is what a startup IPC call waits
  let longest = 0, last = performance.now();
  const probe = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
  const t0 = performance.now();
  await index.start();
  clearInterval(probe);
  console.log(`${'index.start() (full build, batched)'.padEnd(44)} ${ms(performance.now() - t0).padStart(12)}`);
  console.log(`${'  longest stretch without yielding'.padEnd(44)} ${ms(longest).padStart(12)}`);
  console.log(`${'  notes indexed'.padEnd(44)} ${String(index.size()).padStart(12)}`);
  time('index.sync() with nothing changed', () => index.sync(), 5);
  const touched = path.join(vault, rels[17]);
  writeFileSync(touched, '---\ntitle: Note 17\n---\n# Note 17\n\nEdited [[note-18]].\n');
  utimesSync(touched, new Date(), new Date());
  time('index.sync() after one edit', () => index.sync());
  if (index.syncPaths) { writeFileSync(touched, '# Note 17 again\n'); time('index.syncPaths([one file])', () => index.syncPaths([rels[17]])); }
  time('index.graph()', () => index.graph(), 3);
  time('index.search("meeting project 7")', () => index.search('meeting project 7', 30), 5);
  time('index.linkHealth()', () => index.linkHealth());
  index.stop();

  time('listTeamNotes (team vault of N notes)', () => listTeamNotes(vault));
} finally {
  rmSync(root, { recursive: true, force: true });
}
