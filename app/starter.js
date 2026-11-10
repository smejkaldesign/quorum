// the starter Agent OS, shaped around the person: a template (Personal, Founder, Team lead) plus the answers of a short
// interview become folders, a people note and a project note per name, an index that lists them, and a CLAUDE.md whose
// generated part sits between markers so a re-run replaces it without touching what the person wrote around it.
// Answers live in .quorum/setup.json inside the folder, so the interview can be run again from Settings
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SETUP_VERSION = 1;
export const SETUP_FILE = path.join('.quorum', 'setup.json');
export const MARK_OPEN = '<!-- quorum:setup -->';
export const MARK_CLOSE = '<!-- /quorum:setup -->';

// folder keys are stable ids; the numbered or plain name comes from the organize answer
const AREA = {
  inbox: { n: '00', plain: 'inbox', title: 'Inbox', desc: 'Quick captures. Sort them into real notes later.' },
  daily: { n: '01', plain: 'daily', title: 'Daily', desc: 'One note per day, named `YYYY-MM-DD.md`.' },
  people: { n: '02', plain: 'people', title: 'People', desc: 'One note per person: who they are, what you work on together, links to the meetings they were in.' },
  projects: { n: '03', plain: 'projects', title: 'Projects', desc: 'One note per project: goal, status, decisions, links to the meetings about it.' },
  company: { n: '04', plain: 'company', title: 'Company', desc: 'How the company runs: plans, metrics, operating notes.' },
  knowledge: { n: '05', plain: 'knowledge', title: 'Knowledge', desc: 'Things learned that stay true: patterns, references, how-tos.' },
  customers: { n: '06', plain: 'customers', title: 'Customers', desc: 'One note per customer or account.' },
  oneOnOnes: { n: '07', plain: 'one-on-ones', title: 'One-on-ones', desc: 'Prep and follow-ups per report, one file per person.' },
  meetings: { n: '08', plain: 'meetings', title: 'Meetings', desc: 'Meeting notes by app. Quorum saves into `quorum/`.' },
  decisions: { n: null, plain: 'decisions', title: 'Decisions', desc: 'One entry per decision: Context, Options, Choice, Outcome.' },
};

export const TEMPLATES = {
  personal: {
    name: 'Personal',
    desc: 'Inbox, daily notes, people, projects, knowledge and meetings.',
    areas: ['inbox', 'daily', 'people', 'projects', 'knowledge', 'meetings'],
    confidential: ['personal'],
  },
  founder: {
    name: 'Founder',
    desc: 'Adds a company area, customers and a decisions log.',
    areas: ['inbox', 'daily', 'people', 'projects', 'company', 'knowledge', 'customers', 'meetings', 'decisions'],
    confidential: ['personal', 'finance'],
  },
  'team-lead': {
    name: 'Team lead',
    desc: 'Adds one-on-ones and a note per report.',
    areas: ['inbox', 'daily', 'people', 'projects', 'knowledge', 'oneOnOnes', 'meetings'],
    confidential: ['personal', 'people'],
  },
};

const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n;]+/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 24);
const text = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// what the interview produces, cleaned; unknown templates fall back to Personal and unknown organize values to areas
export function normalizeAnswers(a = {}) {
  return {
    template: TEMPLATES[a.template] ? a.template : 'personal',
    role: text(a.role, 160),
    goals: text(a.goals),
    projects: list(a.projects),
    people: list(a.people),
    organize: a.organize === 'plain' ? 'plain' : 'areas',
  };
}

export const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';

export function folderName(key, organize) {
  const a = AREA[key];
  return organize === 'plain' || !a.n ? a.plain : `${a.n}-${a.plain}`;
}

const today = () => new Date().toISOString().slice(0, 10);

// the generated section of CLAUDE.md: layout, who the person is, what they are after, the names that matter, the rules
export function setupSection(name, answers) {
  const t = TEMPLATES[answers.template];
  const f = (k) => folderName(k, answers.organize);
  const lines = [MARK_OPEN, `## About ${answers.role ? 'you' : 'this folder'}`, ''];
  if (answers.role) lines.push(`- Role: ${answers.role}`);
  if (answers.goals) lines.push(`- Working toward: ${answers.goals}`);
  lines.push(`- Template: ${t.name}. Set up on ${today()}; run the setup again from Settings, Memory to change this section.`, '', '## Layout', '');
  for (const k of t.areas) lines.push(`- \`${f(k)}/\` ${AREA[k].desc}${k === 'meetings' ? ' Quorum writes `source: quorum` in the frontmatter.' : ''}`);
  lines.push('- `index.md` the catalog: one line per note. Add a line for every new note.');
  if (answers.projects.length) {
    lines.push('', '## Projects', '');
    for (const p of answers.projects) lines.push(`- [[${slug(p)}]] ${p}`);
  }
  if (answers.people.length) {
    lines.push('', '## People', '');
    for (const p of answers.people) lines.push(`- [[${slug(p)}]] ${p}`);
  }
  lines.push('', '## Rules', '',
    '- Keep notes short and literal. Link related notes in a `## Related` section.',
    '- Never write secrets here.',
    `- Frontmatter \`confidential: ${t.confidential.join('` or `confidential: ')}\` keeps a note out of anything shared and out of every agent read that is not yours.`,
    '- Meeting notes are written by Quorum; link to them, do not rewrite them.',
    MARK_CLOSE);
  return lines.join('\n');
}

// the full file set for a fresh folder; existing files are never overwritten by writeStarter
export function plan({ name = 'My Agent OS', answers: raw }) {
  const answers = normalizeAnswers(raw);
  const t = TEMPLATES[answers.template];
  const f = (k) => folderName(k, answers.organize);
  const files = {};
  const index = [];
  const add = (rel, body, line) => { files[rel] = body; if (line) index.push(line); };
  add('README.md', `# ${name}\n\nThis folder is your Agent OS: plain markdown notes that Quorum and your AI read and write.\n\n- \`index.md\` lists every note with one line each. Quorum reads it first.\n- \`CLAUDE.md\` tells your AI how to work in here.\n- \`${f('meetings')}/quorum/\` holds the meeting notes Quorum saves.\n\nLink notes with [[wikilinks]]. Nothing here leaves your Mac unless you turn sync on in Quorum.\n`, '- [[README]] - what this folder is and how it is organized');
  for (const k of t.areas) add(`${f(k)}/README.md`, `# ${AREA[k].title}\n\n${AREA[k].desc}\n${k === 'decisions' ? '\n## Entry format\n\n```\n# <decision>\n\n**Context**\n**Options**\n**Choice**\n**Outcome** (filled in later)\n```\n' : ''}`);
  for (const p of answers.projects) add(`${f('projects')}/${slug(p)}.md`, `---\ntype: project\nstatus: active\n---\n# ${p}\n\n## Goal\n\n## Status\n\n## Decisions\n\n## Related\n\n`, `- [[${slug(p)}]] - project: ${p}`);
  for (const p of answers.people) add(`${f('people')}/${slug(p)}.md`, `---\ntype: person\n---\n# ${p}\n\n## Who\n\n## Working together\n\n## Meetings\n\n`, `- [[${slug(p)}]] - person: ${p}`);
  add('index.md', `# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n\n${index.join('\n')}\n`);
  add('CLAUDE.md', `# ${name}\n\nThis folder is an Agent OS managed with Quorum. Notes are plain markdown with [[wikilinks]] and YAML frontmatter.\n\n${setupSection(name, answers)}\n`);
  add('.obsidian/app.json', '{}\n');
  add(SETUP_FILE, JSON.stringify({ version: SETUP_VERSION, name, answers, createdAt: new Date().toISOString() }, null, 2) + '\n');
  return { answers, files, dirs: [`${f('meetings')}/quorum`], meetings: `${f('meetings')}/quorum` };
}

export function writeStarter(dir, p) {
  for (const d of p.dirs) mkdirSync(path.join(dir, d), { recursive: true });
  const written = [];
  for (const [rel, body] of Object.entries(p.files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) { writeFileSync(file, body); written.push(rel); }
  }
  return written;
}

// replace the generated section, or append it when the file has none; everything outside the markers is kept as is
export function applySection(existing, section) {
  const a = existing.indexOf(MARK_OPEN);
  const b = existing.indexOf(MARK_CLOSE);
  if (a >= 0 && b > a) return existing.slice(0, a) + section + existing.slice(b + MARK_CLOSE.length);
  return existing.replace(/\s*$/, '') + '\n\n' + section + '\n';
}

export function readSetup(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, SETUP_FILE), 'utf8')); } catch { return null; }
}

// the interview again on a folder that exists: new folders and notes are added, nothing that exists is rewritten,
// the generated CLAUDE.md section is replaced, missing index lines are appended, and the answers file is updated
export function rerunSetup(dir, { name, answers }) {
  const p = plan({ name, answers });
  delete p.files['index.md'];
  delete p.files['CLAUDE.md'];
  delete p.files[SETUP_FILE];
  const written = writeStarter(dir, p);
  const claude = path.join(dir, 'CLAUDE.md');
  writeFileSync(claude, applySection(existsSync(claude) ? readFileSync(claude, 'utf8') : `# ${name}\n`, setupSection(name, p.answers)));
  const indexFile = path.join(dir, 'index.md');
  let index = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '# Index\n\n';
  const wanted = [...p.answers.projects.map((x) => `- [[${slug(x)}]] - project: ${x}`), ...p.answers.people.map((x) => `- [[${slug(x)}]] - person: ${x}`)];
  const missing = wanted.filter((l) => !index.includes(`[[${l.slice(4, l.indexOf(']]'))}]]`));
  if (missing.length) index = index.replace(/\s*$/, '') + '\n' + missing.join('\n') + '\n';
  writeFileSync(indexFile, index);
  const setupFile = path.join(dir, SETUP_FILE);
  mkdirSync(path.dirname(setupFile), { recursive: true });
  const prev = readSetup(dir);
  writeFileSync(setupFile, JSON.stringify({ version: SETUP_VERSION, name, answers: p.answers, createdAt: prev?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2) + '\n');
  return { written, answers: p.answers };
}

// what the person's own AI already knows about them, as prefill for the interview. The prompt asks for JSON only and
// allows empty fields; the model source is the user's own, and nothing about the answer leaves the Mac
export const SUGGEST_SYSTEM = 'You help set up a personal notes folder. Answer with one JSON object and nothing else.';
export const suggestPrompt = ({ owner = '', about = '' } = {}) => [
  `From what you already know about ${owner || 'the person you work with on this Mac'} (your memory, instructions and prior context${about ? `; also: ${about}` : ''}), fill this JSON. Leave a field empty when you do not know; never invent names.`,
  '{"role": "their job in a few words", "goals": "what they are working toward, one sentence", "projects": ["up to 6 project names"], "people": ["up to 8 names of people they work with"], "template": "personal | founder | team-lead"}',
].join('\n');

export function parseSuggestion(textOut) {
  const s = String(textOut ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const n = normalizeAnswers(j);
    const any = n.role || n.goals || n.projects.length || n.people.length;
    return any ? n : null;
  } catch { return null; }
}
