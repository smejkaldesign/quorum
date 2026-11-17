// A generated vault for the memory agent's load tests: projects with a stated database and owner, dated decisions that
// change some of them, meeting notes and inbox notes with filler text. Every name and line is made up. The fake model
// answers a claim prompt with the claims these lines make, and a judge prompt with a contradiction quoting both lines.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WORDS = 'alpha beta gamma delta river stone cloud paper window garden signal orbit lantern meadow harbor copper velvet canyon ember quartz'.split(' ');
// a small seeded generator, so every run writes the same vault
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const sentence = (r, n) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
const filler = (r, lines) => Array.from({ length: lines }, () => `${sentence(r, 6 + Math.floor(r() * 8))}.`).join('\n');
const DBS = ['Postgres', 'SQLite', 'MySQL', 'Redis'];
const TEAMS = ['Team Red', 'Team Blue', 'Team Green'];
const day = (i) => `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`;

// writes about `notes` notes under dir. big: the size in characters of one extra dated log note, 0 for none
export function writeSynthVault(dir, { notes = 2000, big = 0 } = {}) {
  const r = rng(7);
  const projects = Math.floor(notes * 0.3);
  const decisions = Math.floor(notes * 0.15);
  const meetings = Math.floor(notes * 0.3);
  const inbox = notes - projects - decisions - meetings;
  const put = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text); };
  for (let i = 0; i < projects; i++) {
    put(`projects/p${i}.md`, `---\ntype: project\ndate: ${day(i)}\n---\n# Project P${i}\n\nProject P${i} database is ${DBS[i % DBS.length]}.\nProject P${i} owner is ${TEAMS[i % TEAMS.length]}.\n\n${filler(r, 12)}\n`);
  }
  for (let i = 0; i < decisions; i++) {
    put(`decisions/${day(i + 3)}-p${i}-database.md`, `---\ntype: decision\ndate: ${day(i + 3)}\n---\n# P${i} database\n\nWe decided Project P${i} database is ${DBS[(i + 1) % DBS.length]}.\nSee [[p${i}]].\n\n${filler(r, 6)}\n`);
  }
  for (let i = 0; i < meetings; i++) {
    put(`meetings/${day(i)}-sync-${i}.md`, `# Sync ${i}\n\nWe talked about [[p${i % projects}]].\n${filler(r, 15)}\n`);
  }
  for (let i = 0; i < inbox; i++) put(`inbox/idea-${i}.md`, `# Idea ${i}\n\n${filler(r, 8)}\n`);
  if (big) {
    const line = `**00:01** a long session line ${sentence(r, 10)}\n`;
    put('logs/2026-11-16.md', `# Session log 2026-11-16\n\n${line.repeat(Math.ceil(big / line.length))}`);
  }
  return { notes: projects + decisions + meetings + inbox + (big ? 1 : 0) };
}

const CLAIM = /^(\d+): (?:We decided )?(Project P\d+) (database|owner) is (.+)\.$/;
// the fake model for both prompts. A claim prompt lists each note's lines with their numbers
export function synthModel(prompt) {
  // a judge prompt holds one or more pairs, each with its id
  if (prompt.includes('<pair id="')) {
    const verdicts = prompt.split('<pair id="').slice(1).map((block) => {
      const [, ra, la, qa, rb, lb, qb] = block.match(/Claim A in (\S+) \(line (\d+)\): "(.*)"\nClaim B in (\S+) \(line (\d+)\): "(.*)"/);
      return { pair: block.slice(0, block.indexOf('"')), label: 'contradiction', quotes: [{ path: ra, line: +la, text: qa }, { path: rb, line: +lb, text: qb }], reason: 'The two lines give different values.' };
    });
    return JSON.stringify({ verdicts });
  }
  const claims = [];
  for (const block of prompt.split('<note path="').slice(1)) {
    const rel = block.slice(0, block.indexOf('"'));
    for (const l of block.split('\n').slice(1)) {
      const m = l.match(CLAIM);
      if (!m) continue;
      const quote = l.slice(l.indexOf(': ') + 2);
      claims.push({ path: rel, subject: m[2], attribute: m[3], value: m[4], polarity: '+', modality: quote.startsWith('We decided') ? 'decided' : 'stated', date: null, scope: null, quote, line: +m[1], line_end: +m[1] });
    }
  }
  return JSON.stringify({ claims });
}
