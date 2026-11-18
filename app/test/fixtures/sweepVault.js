// A generated vault shaped like a large personal vault, for the save sweep tests and scripts/save-sweep-bench.mjs:
// project notes with frontmatter facts, decision notes that change some of them, meeting notes with "[[project]] key:
// value" lines, knowledge notes with "Key: value" lines, a few copied notes, dead links, and dated session logs that a
// capture hook appends to on every turn. Every name and line is made up; the same seed writes the same vault.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WORDS = 'alpha beta gamma delta river stone cloud paper window garden signal orbit lantern meadow harbor copper velvet canyon ember quartz'.split(' ');
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const STATUS = ['active', 'paused', 'planned', 'done'];
const OWNERS = ['Team Red', 'Team Blue', 'Team Green', 'Team Gold'];
const DBS = ['Postgres', 'SQLite', 'MySQL', 'Redis'];
const PRICES = ['$25/seat', '$30/seat', '$19/seat', '$49/seat'];
const day = (i) => `2026-${String(1 + (i % 11)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;

// writes about `notes` notes under dir; logBytes: the size of each session log. Answers the rels of the session logs
export function writeSweepVault(dir, { notes = 2200, logBytes = 80000 } = {}) {
  const r = rng(11);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const filler = (lines) => Array.from({ length: lines }, () => `${sentence(6 + Math.floor(r() * 8))}.`).join('\n');
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  const projects = Math.floor(notes * 0.18);
  const decisions = Math.floor(notes * 0.1);
  const meetings = Math.floor(notes * 0.3);
  const logs = Math.floor(notes * 0.08);
  const copies = 12;
  const knowledge = notes - projects - decisions - meetings - logs - copies;
  for (let i = 0; i < projects; i++) {
    put(`projects/p${i}.md`, `---\ntype: project\nstatus: ${STATUS[i % 4]}\nowner: ${OWNERS[i % 4]}\ndatabase: ${DBS[i % 4]}\nupdated: ${day(i)}\n---\n# Project P${i}\n\nPrice: ${PRICES[i % 4]}\nLaunch: Q${1 + (i % 4)}\n\n${filler(10)}\n\nSee [[p${(i + 1) % projects}]] and [[k${i % knowledge}]].\n`);
  }
  for (let i = 0; i < decisions; i++) {
    const p = (i * 3) % projects;
    put(`decisions/${day(i + 40)}-p${p}.md`, `---\ntype: decision\ndate: ${day(i + 40)}\n---\n# P${p} decision\n\nWe decided to move P${p}.\n- [[p${p}]] status: ${STATUS[(p + 1) % 4]}\n- [[p${p}]] database: ${DBS[(p + 2) % 4]}\n\n${filler(5)}\n`);
  }
  for (let i = 0; i < meetings; i++) {
    const p = (i * 7) % projects;
    put(`meetings/${day(i)}-sync-${i}.md`, `---\ndate: ${day(i)}\n---\n# Sync ${i}\n\n- [[p${p}]] owner: ${OWNERS[(p + (i % 3)) % 4]}\n- [[p${p}]] launch: Q${1 + ((p + i) % 4)}\n\nWe talked about [[p${p}]] and [[missing-${i % 40}]].\n${filler(14)}\n`);
  }
  for (let i = 0; i < knowledge; i++) {
    put(`knowledge/k${i}.md`, `# K${i}\n\nOwner: ${OWNERS[i % 4]}\nRegion: ${pick(['us-east', 'us-west', 'eu'])}\n\n${filler(18)}\n\nRelated: [[k${(i * 5 + 1) % knowledge}]] [[ghost-${i % 25}]]\n`);
  }
  for (let i = 0; i < copies; i++) put(`inbox/copy-${i}.md`, `# K${i}\n\nOwner: ${OWNERS[i % 4]}\n\n${filler(18)}\n`);
  const logRels = [];
  for (let i = 0; i < logs; i++) {
    const rel = `memory/sessions/${day(i)}-${i}.md`;
    const line = `**Turn**: ${sentence(12)}\n`;
    const facts = Array.from({ length: 20 }, (_, k) => { const p = (i * 11 + k * 17) % projects; return `- [[p${p}]] ${pick(['status', 'owner', 'launch'])}: ${pick([...STATUS, ...OWNERS])}`; }).join('\n');
    put(rel, `---\ndate: ${day(i)}\n---\n# Session ${day(i)}\n\n${facts}\n\n${line.repeat(Math.ceil(logBytes / line.length))}`);
    logRels.push(rel);
  }
  return { logs: logRels };
}
