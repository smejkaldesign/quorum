// A generated vault for the memory graph tests and timing runs: people, projects and companies with notes, meetings
// with participants and decisions, and plain notes that link among them, padded to a chosen size. No real content.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIRST = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kai', 'Lu', 'Mo', 'Ned', 'Oz', 'Pia'];
const LAST = ['Ruiz', 'Ode', 'Dale', 'Fox', 'Gray', 'Hale', 'Ives', 'Jung', 'Kim', 'Lane', 'Moss', 'Nash'];
const WORDS = 'the team reviewed scope budget timeline launch risks metrics design research customer feedback roadmap plan hiring onboarding pricing'.split(' ');

// specs: PRD, spec and research notes inside the project folders with no type, the way a real projects folder holds them
export function writeGraphVault(vault, { notes = 300, people = 40, projects = 12, companies = 6, meetings = 80, padWords = 40, specs = 0, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pad = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const put = (rel, text) => { const abs = path.join(vault, rel); mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); };
  const personNames = Array.from({ length: people }, (_, i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? ` ${i}` : ''}`);
  const projectNames = Array.from({ length: projects }, (_, i) => `Project ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ''}`);
  const companyNames = Array.from({ length: companies }, (_, i) => `Company ${i}`);
  const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  personNames.forEach((n, i) => put(`02-people/${slug(n)}.md`, `---\ntype: person\ncompany: "[[${companyNames[i % companies]}]]"\nproject: ${projectNames[i % projects]}\nrole: member\n---\n# ${n}\n\n${pad(padWords)}\n`));
  projectNames.forEach((n, i) => put(`04-projects/${n}.md`, `---\ntype: project\ncompany: ${companyNames[i % companies]}\nstatus: active\n---\n# ${n}\n\nOwner [[${slug(personNames[i % people])}]]. ${pad(padWords)}\n`));
  companyNames.forEach((n) => put(`companies/${n}.md`, `# ${n}\n\n${pad(padWords)}\n`));
  const meetingRels = [];
  for (let i = 0; i < meetings; i++) {
    const day = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    const proj = projectNames[i % projects];
    const who = [personNames[i % people], personNames[(i * 7 + 3) % people], personNames[(i * 11 + 5) % people]];
    const rel = `08-meetings/${day} ${proj} sync ${i}.md`;
    meetingRels.push(rel);
    put(rel, `---\ndate: ${day}\nparticipants: [${[...new Set(who)].join(', ')}]\nproject: "[[${proj}]]"\n---\n# ${proj} sync ${i}\n\n${pad(padWords)}\n\nDecision: Hosting: option ${i % 3} for [[${proj}]]\n\n## Notes\n${pad(padWords)}\n`);
  }
  const specRels = [];
  const SPEC = ['prd', 'spec', 'research', 'review', 'release notes', 'retro'];
  for (let i = 0; i < specs; i++) {
    const proj = projectNames[i % projects];
    const rel = `04-projects/${slug(proj)}/${slug(proj)}-${SPEC[i % SPEC.length].replace(/ /g, '-')}-${i}.md`;
    specRels.push(rel);
    put(rel, `# ${proj} ${SPEC[i % SPEC.length]} ${i}\n\nFor [[${proj}]], with [[${slug(personNames[i % people])}]].\n\n${pad(padWords)}\n`);
  }
  const plain = [];
  for (let i = 0; i < notes; i++) {
    const rel = `notes/${String(Math.floor(i / 100)).padStart(2, '0')}/note-${i}.md`;
    plain.push(rel);
    const links = [`[[note-${(i * 13 + 1) % notes}]]`, `[[${slug(personNames[i % people])}]]`, `[[${projectNames[i % projects]}]]`].join(' ');
    put(rel, `# Note ${i} #topic${i % 9}\n\n${links}\n\n${pad(padWords)}\n`);
  }
  return { personNames, projectNames, companyNames, meetingRels, plain, specRels, slug };
}
