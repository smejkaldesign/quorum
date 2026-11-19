// A generated vault for the search eval, and the questions to ask it. Every name, project and line is made up.
// Four kinds of question, each with the notes that answer it:
//   keyword     a ticket code that appears in one project note
//   paraphrase  a project's goal asked in other words, so shared words are few
//   entity      the meetings a person attended, named only in the meeting's frontmatter (search reads no frontmatter,
//               so only the graph knows)
//   current     a project's current database, where an older decision was superseded by a newer one
// node search/eval/make-vault.mjs <dir> [--notes 2500] [--tokens 1200]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIRST = 'Ada Bram Cleo Dario Esme Farah Gideon Hana Ines Jonah Kenji Lena Mateo Nadia Omar Priya Quinn Rosa Sami Tova Ulric Vera Wes Ximena Yusuf Zara Anouk Bastien Calla Devi'.split(' ');
const LAST = 'Arden Brightwater Castell Dunmore Ellery Fairholt Greaves Hollis Ivers Jessup Kincaid Lowry Marlow Northcott Okafor Pellham Quarry Rusk Sorrell Thorne Underhill Vance Whitlock Yardley'.split(' ');
const CODENAMES = 'Heron Lantern Basalt Juniper Cobalt Meridian Falcon Saffron Tundra Willow Quartz Ember Harbor Sable Cirrus Orchid Granite Kestrel Mosaic Nimbus Pylon Russet Sequoia Talon Umber Vesper Wren Yarrow Zephyr Alder Birch Cedar Delta Echo Fjord Glacier Hollow Iris Jade Kelp'.split(' ');
const DBS = ['Postgres', 'SQLite', 'DynamoDB', 'MySQL', 'Cassandra', 'Firestore'];
const ROLES = ['product designer', 'backend engineer', 'data scientist', 'engineering manager', 'site reliability engineer', 'researcher', 'mobile engineer', 'product manager'];
// a goal as the project note states it, and the same goal asked in other words
const GOALS = [
  ['cut the time it takes a new customer to finish onboarding from two weeks to three days', 'make customer setup much faster'],
  ['move invoice generation off the nightly batch job and produce invoices as soon as an order ships', 'bill people right when their package leaves the warehouse'],
  ['replace the hand-written dosage tables in the clinic app with values pulled from the pharmacy formulary', 'stop typing medication amounts by hand in the clinic software'],
  ['translate the help center into Spanish, Portuguese and French before the Latin America launch', 'localize support articles for new regions'],
  ['lower the monthly cloud bill by shutting down idle staging clusters every weekend', 'save money on servers that sit unused on Saturdays and Sundays'],
  ['let warehouse staff scan pallets with their phones instead of the old handheld readers', 'use smartphones for inventory barcode scanning'],
  ['detect fraudulent refund requests before an agent approves them', 'catch people who fake returns to get money back'],
  ['rebuild the search bar so typos still find the right product', 'tolerate misspellings when shoppers look for items'],
  ['give nurses a single screen that shows every patient on their shift with open tasks', 'one dashboard for the care team listing who needs what today'],
  ['archive chat transcripts older than seven years to meet the retention policy', 'delete or store away very old conversation logs for compliance'],
  ['add two-factor sign-in for every administrator account', 'require a second login step for admins'],
  ['predict which delivery routes will run late because of weather', 'forecast shipping delays caused by storms'],
  ['shrink the mobile app download below forty megabytes', 'make the phone app smaller to install'],
  ['let teachers grade essays with a rubric and leave voice comments', 'audio feedback and scoring guides for student writing'],
  ['sync the volunteer schedule with each volunteer\'s personal calendar', 'put shift times into helpers\' own calendars automatically'],
  ['measure how long support tickets wait before the first human reply', 'track response time for help desk requests'],
  ['offer a dark color theme across the web dashboard', 'night mode for the admin site'],
  ['show farmers a soil moisture map built from field sensors', 'visualize how wet the ground is across a farm'],
  ['let tenants pay rent in two installments each month', 'split housing payments into halves'],
  ['flag lab results outside the normal range and notify the ordering doctor', 'alert physicians about abnormal test values'],
  ['cut the time the checkout page takes to load on slow connections', 'make paying faster on weak mobile networks'],
  ['import bank statements automatically every morning', 'pull account transactions from banks each day'],
  ['run the quarterly security review with a checklist instead of a spreadsheet', 'structured audit list for periodic safety checks'],
  ['let drivers report potholes with a photo and their location', 'road damage reports from people behind the wheel'],
  ['build a recommendation shelf of books similar to the last one a reader finished', 'suggest novels like the ones someone already read'],
  ['answer common billing questions with a chatbot before routing to an agent', 'automated assistant for invoice questions'],
  ['estimate how many solar panels fit on a roof from a satellite photo', 'figure out rooftop panel count using aerial images'],
  ['move the payroll export from CSV files to a direct bank API', 'send salary payments without spreadsheets'],
  ['track which features each customer uses in the first month', 'usage analytics for new accounts'],
  ['let museum visitors hear audio guides in their own language through their phones', 'multilingual exhibit narration on personal devices'],
];
// work prose with no answer in it, to fill notes to size and give the vectors realistic noise
const FILLER = [
  'We spent most of the hour on the timeline and agreed to check again next week.',
  'The draft looks reasonable, though a few sections still need numbers.',
  'Someone asked whether the vendor contract renews automatically; nobody knew.',
  'The team wants fewer meetings and more written updates.',
  'A follow-up is needed with legal before anything goes out.',
  'Most of the open questions are about scope rather than effort.',
  'The prototype worked in the demo but crashed once on an older laptop.',
  'We should write down the assumptions so the next review goes faster.',
  'Hiring is still slow, so the plan assumes the current headcount.',
  'The office move pushed several reviews into next month.',
  'People liked the new template but asked for a shorter summary at the top.',
  'There was a long debate about naming that ended without a decision.',
  'Budget approval is expected after the board meeting.',
  'The design review raised accessibility issues on the settings page.',
  'Two customers asked for the same report, which suggests a pattern.',
  'The staging environment was down for part of the afternoon.',
  'We agreed to keep the scope small and ship a first version early.',
  'Feedback from the pilot group was mostly positive with some confusion about permissions.',
  'The dependency upgrade caused a few test failures that are now fixed.',
  'A retrospective is planned once the release settles.',
  'The roadmap slide needs updated dates before it is shared.',
  'Support volume dropped after the last fix went out.',
  'The new intern is pairing with the platform team this week.',
  'Nobody owns the shared spreadsheet, so it drifts out of date.',
  'We should ask finance for last quarter\'s actuals before planning.',
  'The workshop notes are in the shared drive under this week\'s folder.',
  'A few metrics look off because of a tracking change in October.',
  'The kickoff went well and the stakeholders seem aligned.',
  'Travel for the offsite still needs approval.',
  'The plan depends on the platform team finishing their migration first.',
];

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const day = (i) => `2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + ((i * 7) % 27)).padStart(2, '0')}`;

export function makeEvalVault(dir, { notes = 2500, tokens = 1200, seed = 11 } = {}) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const pad = (body, target) => { const out = [body]; let n = body.length; while (n < target * 4) { const s = pick(FILLER); out.push(s); n += s.length + 1; } return out.join('\n'); };
  const put = (rel, text) => { const f = path.join(dir, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  const questions = [];
  const nPeople = Math.max(10, Math.floor(notes * 0.06));
  const nProjects = Math.max(GOALS.length, Math.floor(notes * 0.05));
  const people = Array.from({ length: nPeople }, (_, i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i >= FIRST.length * LAST.length ? ` ${i}` : ''}`);
  const projects = Array.from({ length: nProjects }, (_, i) => `Project ${CODENAMES[i % CODENAMES.length]}${i >= CODENAMES.length ? ` ${Math.floor(i / CODENAMES.length) + 1}` : ''}`);
  let written = 0;
  people.forEach((p, i) => {
    const proj = projects[i % projects.length];
    put(`people/${p}.md`, `---\ntype: person\n---\n# ${p}\n\n${p} is a ${ROLES[i % ROLES.length]} who works on [[${proj}]].\n\n## Notes\n\n${pad('', tokens / 3)}\n`);
    written++;
  });
  projects.forEach((p, i) => {
    const code = `QX-${1000 + i * 37}`;
    const goal = GOALS[i % GOALS.length][0];
    const goalLine = i < GOALS.length ? `The goal of ${p} is to ${goal}.` : `The goal of ${p} is still being worked out.`;
    put(`projects/${p}.md`, `---\ntype: project\n---\n# ${p}\n\nTracking ticket ${code}. Owner: [[${people[i % people.length]}]].\n\n## Goal\n\n${goalLine}\n\n## Status\n\n${pad('', tokens / 2)}\n`);
    written++;
    questions.push({ type: 'keyword', q: code, expect: [`projects/${p}.md`] });
    if (i < GOALS.length) questions.push({ type: 'paraphrase', q: GOALS[i][1], expect: [`projects/${p}.md`] });
  });
  // two decisions per project for the first projects: the newer supersedes the older
  const nDecided = Math.min(projects.length, Math.max(5, Math.floor(notes * 0.02)));
  for (let i = 0; i < nDecided; i++) {
    const p = projects[i];
    const oldRel = `decisions/${day(i)}-${p} database.md`;
    const newRel = `decisions/2026-11-${String(1 + (i % 18)).padStart(2, '0')}-${p} database change.md`;
    const a = DBS[i % DBS.length];
    const b = DBS[(i + 2) % DBS.length];
    put(oldRel, `---\ntype: decision\nproject: "[[${p}]]"\n---\n# ${p} database\n\nDecision: ${p} stores its data in ${a}.\n\n${pad('', tokens / 4)}\n`);
    put(newRel, `---\ntype: decision\nproject: "[[${p}]]"\nsupersedes: "[[${path.basename(oldRel, '.md')}]]"\n---\n# ${p} database change\n\nDecision: ${p} moves its data from ${a} to ${b}.\n\n${pad('', tokens / 4)}\n`);
    written += 2;
    questions.push({ type: 'current', q: `What database does ${p} use now?`, expect: [newRel] });
  }
  // meetings: attendees only in frontmatter
  const nMeetings = Math.floor(notes * 0.3);
  const attended = new Map();
  for (let i = 0; i < nMeetings; i++) {
    const p = projects[i % projects.length];
    const who = [...new Set([people[i % people.length], pick(people), pick(people)])];
    const rel = `meetings/${day(i)} ${p} sync ${i}.md`;
    put(rel, `---\ntype: meeting\nattendees:\n${who.map((w) => `  - "[[${w}]]"`).join('\n')}\nproject: "[[${p}]]"\n---\n# ${p} sync ${i}\n\nWe went through open items for [[${p}]].\n\n${pad('', tokens * 0.8)}\n`);
    written++;
    for (const w of who) (attended.get(w) ?? attended.set(w, []).get(w)).push(rel);
  }
  people.slice(0, 40).forEach((p) => { const m = attended.get(p); if (m?.length) questions.push({ type: 'entity', q: `meetings with ${p}`, expect: m }); });
  // journal notes fill the rest
  for (let i = 0; written < notes; i++, written++) put(`journal/${day(i)} entry ${i}.md`, `# Journal ${i}\n\n${pad('', tokens)}\n`);
  return { notes: written, questions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
  if (!dir) { console.error('usage: node search/eval/make-vault.mjs <dir> [--notes 2500] [--tokens 1200]'); process.exit(1); }
  const { notes, questions } = makeEvalVault(path.join(dir, 'vault'), { notes: arg('notes', 2500), tokens: arg('tokens', 1200) });
  writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions, null, 2));
  console.log(`${notes} notes, ${questions.length} questions in ${dir}`);
}
