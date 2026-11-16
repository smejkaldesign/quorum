#!/usr/bin/env node
// Times the Memory health review rules (rules/index.js) on a made-up vault: writes N notes (default 3,000) to a temp
// folder, builds the index, and times a full sweep, the confidential tag scan and a save sweep of 10 notes. Removes the
// temp folder when done.
//
//   node scripts/rules-bench.mjs [notes]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVaultIndex } from '../vindex.js';
import { runRules } from '../rules/index.js';
import { scanTags } from '../memorySweep.js';

const N = Number(process.argv[2] ?? 3000);
const root = mkdtempSync(path.join(tmpdir(), 'quorum-rules-bench-'));
const folders = ['projects', 'knowledge', 'inbox', 'meetings', 'people', 'work/acme', 'work/acme/notes', 'archive', 'research', 'daily'];
const words = (n, seed) => Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % 911}`).join(' ');
const t = (label, fn) => { const t0 = performance.now(); const out = fn(); console.log(`${label}: ${Math.round(performance.now() - t0)} ms`); return out; };

try {
  for (let i = 0; i < N; i++) {
    const folder = folders[i % folders.length];
    const name = folder === 'daily' ? `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}-${i}` : `note-${i}`;
    const fm = ['---', `status: ${['draft', 'done', 'active', 'planned'][i % 4]}`, `updated: 2026-${String((i % 12) + 1).padStart(2, '0')}-01`, ...(folder.startsWith('work') && i % 9 ? ['confidential: acme-internal'] : []), '---'];
    const links = [1, 2, 3].map((k) => `[[note-${(i * 13 + k * 101) % N}]]`).join(' ');
    const size = i % 500 === 0 ? 4000 : 120;
    const body = i % 211 === 0 ? words(size, 5) : words(size, i);
    writeFileSync(path.join(root, mkdir(folder), `${name}.md`), `${fm.join('\n')}\n# Note ${i}\n\n${body}\n\nSee ${links}\n`);
  }
  console.log(`made ${N} notes in ${folders.length} folders`);
  const idx = createVaultIndex({ vault: root, isExcludedPath: () => false, isExcludedText: () => false, redact: (x) => x, onChange: () => {} });
  t('index build', () => idx.sync());
  const notes = t('snapshot', () => idx.snapshot());
  const tags = t('confidential tag scan', () => scanTags(root));
  const ctx = { notes, tags, resolve: (x, from) => idx.resolve(x, from) };
  const full = t('full sweep', () => runRules(ctx));
  console.log(`  ${full.findings.length} findings; per rule ms ${JSON.stringify(full.ms)}`);
  const only = notes.slice(0, 10).map((n) => n.rel);
  t('save sweep (10 notes)', () => runRules(ctx, { only }));
} finally {
  rmSync(root, { recursive: true, force: true });
}

function mkdir(folder) { mkdirSync(path.join(root, folder), { recursive: true }); return folder; }
