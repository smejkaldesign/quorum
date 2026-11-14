// The data behind the app preview on quorum.watch. The preview is the real renderer (src/App.tsx) running in a browser
// frame, so there is no main process: this file stands in for the bridge preload.cjs exposes, and every value in it is
// sample data. Typed against the bridge, so a changed return type fails `npm run typecheck` until the sample follows.
// Import this before anything from src/: App.tsx reads window.quorum while its module loads.
import type { CalendarEvent, ChatRow, MeetingRow, MeetingSourceInfo, NoteDoc, PlatformInfo, TreeItem } from '../src/quorum';
import type { GraphData } from '../src/Graph';
import { CONNECTORS } from '../connectors/library';

type Bridge = Window['quorum'];

// a small seeded generator, so the graph has the same notes and links on every visit
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VAULT = '/Acme Notes';
const HOUR = 3600000;

// a time today or on a nearby day, so Home's Today, Yesterday and Tomorrow labels always have rows under them
function at(dayOffset: number, hour: number, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function calendarEvents(): CalendarEvent[] {
  const event = (id: string, title: string, start: Date, minutes: number, platform: CalendarEvent['platform']): CalendarEvent =>
    ({ id, title, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60000).toISOString(), recurring: true, platform, join: null });
  return [
    event('ev-1', 'Weekly product sync', at(1, 10), 30, 'meet'),
    event('ev-2', 'Design review', at(2, 14), 45, 'zoom'),
  ];
}

function history(): { meetings: MeetingRow[]; chats: ChatRow[] } {
  const meeting = (slug: string, title: string, date: Date, people: string[], kind: MeetingRow['kind'] = 'meeting', source = 'quorum'): MeetingRow => {
    const rel = source === 'quorum' ? `Meetings/${date.toISOString().slice(0, 10)} ${slug}.md` : `Meetings/${source}/${date.toISOString().slice(0, 10)} ${slug}.md`;
    return { id: slug, file: `${VAULT}/${rel}`, kind, source, title, date: date.toISOString(), people, count: people.length + 1, visibility: 'private', rel, link: '', app: 'Finder' };
  };
  const meetings = [
    meeting('roadmap-planning', 'Roadmap planning', at(-1, 15), ['Maya Chen', 'Jonas Weber', 'Priya Nair'], 'meeting', 'granola'),
    meeting('onboarding-ideas', 'Onboarding ideas', at(-1, 11, 20), [], 'note'),
    meeting('customer-call-northwind', 'Customer call: Northwind renewal', at(-1, 9, 30), ['Sofia Alvarez', 'Daniel Okafor'], 'meeting', 'granola'),
    meeting('northwind-kickoff', 'Northwind kickoff', at(-2, 13, 30), ['Sofia Alvarez', 'Daniel Okafor'], 'meeting', 'zoom'),
    meeting('design-critique', 'Design critique', at(-2, 10), ['Priya Nair'], 'meeting', 'granola'),
    meeting('hiring-debrief', 'Hiring debrief', at(-3, 16), ['Jonas Weber', 'Lena Fischer', 'Tomás Rivera', 'Aiko Tanaka'], 'meeting', 'granola'),
  ];
  const chats: ChatRow[] = [
    { id: 'chat-1', title: 'List recent todos', date: new Date(Math.min(Date.now() - HOUR, at(0, 9, 12).getTime())).toISOString(), turns: 1, meetingFile: null, meetingTitle: null },
    { id: 'chat-2', title: 'What did we decide on pricing?', date: at(-1, 15, 40).toISOString(), turns: 2, meetingFile: meetings[0].file, meetingTitle: meetings[0].title },
  ];
  return { meetings, chats };
}

// folder name, graph color (null draws the default grey), number of notes
const FOLDERS: [string, string | null, number][] = [
  ['Meetings', '#c08bff', 210],
  ['People', '#ffb366', 64],
  ['Projects', '#8fdc8f', 52],
  ['Decisions', '#5fd0c0', 30],
  ['Customers', '#ff7eb6', 44],
  ['Research', '#f5d05a', 26],
  ['Product', '#6aa8ff', 38],
  ['Daily', null, 150],
  ['Inbox', null, 110],
];
const TOPICS = ['Pricing', 'Onboarding', 'Roadmap', 'Hiring', 'Launch', 'Billing', 'Search', 'Sync', 'Mobile', 'Support', 'Security', 'Design', 'Research', 'Partner', 'Retention', 'Analytics'];
const KINDS = ['review', 'notes', 'plan', 'sync', 'debrief', 'brief', 'questions', 'follow-up', 'summary', 'interview', 'draft', 'checklist'];

function sampleVault(): { graph: GraphData; tree: TreeItem[] } {
  const rand = seeded(20260101);
  const pick = (n: number) => Math.floor(rand() * n);
  const now = Date.now();
  const nodes: GraphData['nodes'] = [];
  const links: [number, number][] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    links.push([a, b]);
  };
  const add = (id: string, name: string, color: string | null) => nodes.push({ id, name, deg: 0, color, t: now - (1 - nodes.length / 800) * 400 * 24 * HOUR }) - 1;

  // one index note that most of the vault links back to, as a real vault's home note does
  const home = add('Home.md', 'Home', '#9cc4ff');
  const tree: TreeItem[] = [];
  for (const [folder, color, count] of FOLDERS) {
    const first = nodes.length;
    const children: TreeItem[] = [];
    for (let i = 0; i < count; i++) {
      const name = `${TOPICS[pick(TOPICS.length)]} ${KINDS[pick(KINDS.length)]} ${i + 1}`;
      const id = `${folder}/${name}.md`;
      add(id, name, color);
      children.push({ name, path: id, dir: false });
    }
    tree.push({ name: folder, path: folder, dir: true, children });
    if (folder === 'Inbox') continue;                      // unlinked notes: the loose ring around the graph
    if (folder === 'Daily') { for (let i = first; i < nodes.length; i++) link(i, home); continue; }
    // a few well-linked notes per folder, the rest attach to them, and some reach the home note or another folder
    const hubs = Math.max(2, Math.round(count / 14));
    for (let i = first; i < nodes.length; i++) {
      if (i - first >= hubs) link(i, first + pick(hubs));
      if (rand() < 0.35) link(i, first + pick(count));
      if (rand() < 0.22) link(i, home);
      if (rand() < 0.12) link(i, 1 + pick(first > 1 ? first - 1 : 1));
    }
  }
  for (const [a, b] of links) { nodes[a].deg++; nodes[b].deg++; }
  for (const name of ['Glossary', 'Roadmap', 'Team']) tree.push({ name, path: `${name}.md`, dir: false });
  tree.push({ name: 'Home', path: 'Home.md', dir: false });

  const settings: GraphData['settings'] = {
    centerStrength: 0.5, repelStrength: 10, linkStrength: 1, linkDistance: 250, nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1, textFadeMultiplier: 0, showOrphans: true, showUnresolved: true,
  };
  const groups = FOLDERS.filter(([, color]) => color).map(([folder, color]) => ({ query: `path:/^${folder}\\//`, color: color! }));
  return { graph: { nodes, links, settings, groups }, tree };
}

const vault = sampleVault();

// one meeting note the reader opens: the roadmap meeting from Home, with who has read it
const NOTE_BODY = `## Summary

The team agreed on the Q1 roadmap: ship workspace sync in January, open the connector library in February, and hold the mobile reader until the sync model has settled. Pricing stays at one plan.

## Decisions

- **Workspace sync ships first.** Pull sync with first-save-wins conflict handling. Confirmed.
- **One paid plan.** No separate team tier for now. Confirmed.
- Mobile reader waits until sync has settled. Suggested by Jonas, no objection.

## Action items

- [ ] Maya: write the sync spec and share it by Friday
- [ ] Priya: list the first ten connectors and who owns each
- [ ] Jonas: cost the managed transcription allowance at 20 hours a seat

## Open questions

- Does the connector library need a review step for community adapters?
- Which calendar should Home read when a person has two accounts?
`;
const VIEWS = { total: 9, human: 3, agent: 6, tokens: 7800, lastHumanAt: at(0, 8, 40).toISOString(), lastAgentAt: at(0, 9, 5).toISOString(), agents: [{ via: 'claude-code', count: 4 }, { via: 'cursor', count: 2 }] };
function readNote(file: string): NoteDoc | null {
  const m = history().meetings.find((x) => x.file === file);
  if (!m) return null;
  return { file, rel: m.rel, title: m.title, date: m.date ?? undefined, people: m.people, body: NOTE_BODY, app: 'Obsidian', url: '', source: m.source === 'quorum' ? null : m.source, views: VIEWS, visibility: m.visibility, withheld: false, link: '' };
}

// the Connectors page: Granola and Zoom cloud recordings connected, Claude Code registered. Meeting notes come from
// those imports; call detection is behind the meeting-capture flag, so every provider row is off.
// Icons come from each connector's domain the way the app fetches them, so the page looks as it does on a Mac
const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
const icons = Object.fromEntries(CONNECTORS.map((c) => [c.id, favicon(c.domain)]));
const sources: MeetingSourceInfo[] = [{
  id: 'granola', name: 'Granola', kind: 'mcp', url: 'https://mcp.granola.ai/mcp', folder: 'granola', description: 'Meeting notes from Granola, imported into your Agent OS.',
  methods: ['connect'], extras: ['transcripts'], recommended: 'connect', why: '', method: 'connect', connected: true, syncNotes: true, syncTranscripts: true, transcripts: 96,
  account: 'maya@example.com', lastSyncAt: at(0, 8, 30).toISOString(), imported: 148, folderPath: `${VAULT}/Meetings/granola`, notes: 148, job: null,
}];
const platforms: PlatformInfo[] = [{ id: 'zoom', name: 'Zoom', available: true, connected: true, account: 'maya@example.com', accountName: 'Maya Chen', lastSyncAt: at(0, 8, 30).toISOString(), imported: 12, notes: 12, folderPath: `${VAULT}/Meetings/zoom`, job: null }];
const providers = [
  { id: 'zoom', name: 'Zoom', installed: true, access: true, enabled: false, version: '6.4.6', path: '/Applications/zoom.us.app', inCall: false, chat: false, running: true },
  { id: 'meet', name: 'Google Meet', installed: true, access: true, enabled: false, version: null, path: '/Applications/Google Chrome.app', inCall: false, chat: false, running: true },
  { id: 'teams', name: 'Microsoft Teams', installed: false, access: null, enabled: false, version: null, path: '', inCall: false, chat: false, running: null },
];

const sample: Partial<Bridge> = {
  launchId: 'site-preview',
  isDev: false,
  sitePreview: { quoteMs: 9000 },
  onboardingStatus: async () => ({ firstRun: false, defaultVaultDir: VAULT }),
  betaStatus: async () => ({ gate: false, on: false, code: null, plan: null, acceptedAt: null, machineId: null, lastHeartbeatAt: null }),
  betaCheck: async () => ({ ok: true, plan: 'free' }),
  screenContextStatus: async () => ({ on: true, granted: true }),
  screenContextSet: async (on: boolean) => ({ on, granted: true }),
  screenContextPrivacy: async () => {},
  keeperStatus: async () => ({ on: true, facts: true, running: false, lastRunAt: new Date().toISOString(), filed: 14, last: { filed: 2, skipped: 0, changed: 5, reason: 'note', at: new Date().toISOString(), error: null }, folders: { people: '02-people', projects: '03-projects', daily: '01-daily', meetings: '08-meetings' }, model: true, held: null, plugins: [] }),
  keeperSet: async (p: { on?: boolean; facts?: boolean }) => ({ on: p.on ?? true, facts: p.facts ?? true, running: false, lastRunAt: null, filed: 14, last: null, folders: {}, model: true, held: null, plugins: [] }),
  keeperRun: async () => ({ filed: 0, skipped: 0, changed: 0, reason: 'manual', at: new Date().toISOString(), error: null }),
  knowledgeStatus: async () => ({ autoInclude: false, mine: [], team: { root: VAULT.replace(/[^/]+$/, 'Quorum Team/Acme'), notes: 12, behind: 1, last: { written: 2, behind: 1, removed: 0, skipped: 0 } } }),
  knowledgeTeamOpen: async () => ({}),
  onboardingSetupSuggest: async () => ({ available: true, suggestion: { template: 'founder' as const, role: 'Product designer', goals: 'Ship the first version', projects: ['Quorum'], people: ['Ada Lovelace'], organize: 'areas' as const } }),
  setupRead: async () => ({ version: 1, name: 'My Agent OS', answers: { template: 'founder' as const, role: 'Product designer', goals: 'Ship the first version', projects: ['Quorum'], people: ['Ada Lovelace'], organize: 'areas' as const }, createdAt: new Date().toISOString() }),
  setupRerun: async () => ({ root: VAULT, vault: VAULT, name: 'Acme Notes', made: 'quorum' as const, written: [], markers: { agentOS: null, obsidian: true, search: true, safetyHooks: true } }),
  brain: async () => ({ root: VAULT, vault: VAULT, name: 'Acme Notes', made: 'quorum' as const, markers: { agentOS: null, obsidian: true, search: true, safetyHooks: true } }),
  user: async () => ({ name: 'Maya Chen', email: 'maya@example.com', photo: null }),
  getSettings: async () => ({ autoListen: false, model: 'sonnet', modelSource: 'claude-code', suggestions: false }),
  calendar: async () => ({ connected: true, status: 'granted', events: calendarEvents(), days: 7, showAll: false, hidden: 3 }),
  history: async () => history(),
  sourceIcons: async () => icons,
  readNote: async (file) => readNote(file),
  libraryIcons: async () => icons,
  sourcesList: async () => sources,
  meetingSources: async () => [{ id: 'granola', key: 'granola', name: 'Granola', manual: false, rel: 'Meetings/granola', notes: 148 }],
  meetingsDir: async () => ({ path: `${VAULT}/Meetings`, rel: 'Meetings', root: 'Meetings', notes: 5, chosen: true, sources: [{ key: 'granola', name: 'Granola', count: 148 }] }),
  disconnectBrain: async () => null,
  clearMeetingsDir: async () => true as const,
  platformsList: async () => platforms,
  meetingProviders: async () => providers,
  meetingProviderCheck: async () => {},
  mcpStatus: async () => ({ added: true, node: '/Applications/Quorum.app/Contents/MacOS/Quorum', cli: '/Applications/Quorum.app/Contents/Resources/cli/quorum.mjs', command: '"/Applications/Quorum.app/Contents/MacOS/Quorum" "/Applications/Quorum.app/Contents/Resources/cli/quorum.mjs" mcp' }),
  calendarStatus: async () => ({ source: 'mac', days: 7, enabled: true, status: 'granted', google: null }),
  guardrailsGet: async () => ({
    rules: [
      { id: 'built-in:secrets', kind: 'secret', label: 'Secret-looking files', what: 'Files named like keys, tokens, .env files and credentials are never read.', value: '', source: 'built-in', scope: 'individual', enabled: true, locked: false },
      { id: 'built-in:private-folders', kind: 'path', label: 'Private folders', what: 'Folders named personal or private, plus .git and node_modules, are never read or searched.', value: 'personal|private', source: 'built-in', scope: 'individual', enabled: true, locked: false },
      { id: 'built-in:confidential', kind: 'frontmatter', label: 'Notes marked confidential', what: 'A note with confidential: in its frontmatter is never read, synced or shared.', value: 'confidential', source: 'built-in', scope: 'individual', enabled: true, locked: false },
      { id: 'built-in:opt-outs', kind: 'term', label: 'Opted-out people and companies', what: 'Lines naming anyone on your opt-out list are withheld from transcripts, answers and the MCP server.', value: '', source: 'built-in', scope: 'individual', enabled: true, locked: false },
      { id: 'agent-os:hook:opted-out-guard.py', kind: 'hook', label: 'opted-out-guard.py', path: `${VAULT}/.claude/hooks/opted-out-guard.py`, value: '', what: 'Denies reads of notes naming a customer who opted out of AI.', stage: 'pre', mixed: false, wired: true, origin: 'hook', source: 'agent-os', scope: 'individual', enabled: false, locked: false, decision: null },
      { id: 'agent-os:path:Clients/northwind', kind: 'path', origin: 'claude-md', label: 'Clients/northwind/', path: `${VAULT}/Clients/northwind`, value: 'Clients/northwind', what: 'Your CLAUDE.md says: "Never share `Clients/northwind/` outside the account team." 12 notes inside are never read, searched, synced or shared.', count: 12, mixed: false, wired: true, source: 'agent-os', scope: 'individual', enabled: false, locked: false, decision: null },
      { id: 'agent-os:terms:scripts/embed-bench/excluded.txt', kind: 'term', label: 'Opt-out term list', path: `${VAULT}/scripts/embed-bench/excluded.txt`, value: `@${VAULT}/scripts/embed-bench/excluded.txt`, what: '14 names withheld wherever they appear in transcripts, answers and the MCP server.', origin: 'terms', source: 'agent-os', scope: 'individual', enabled: true, locked: false, decision: 'included' },
      { id: 'personal:1', kind: 'path', label: 'Board materials', value: 'Board', source: 'personal', scope: 'individual', enabled: true, locked: false },
      { id: 'ws:1', kind: 'frontmatter', label: 'Legal hold', value: 'legal_hold', source: 'workspace', scope: 'organization', enabled: true, locked: true },
    ],
    scanned: { notes: 212, at: Date.now() - 60000, truncated: false },
    skipped: [{ name: 'vault-reindex.sh', reason: 'does something else (memory, sessions, formatting or notifications), not a guard' }, { name: 'session-end.sh', reason: 'no sign that it guards reads or output' }],
    denials: [{ t: at(0, 8, 41).toISOString(), tool: 'Read', path: `${VAULT}/Board/2026-q4-pack.md`, reason: 'Quorum read guard: Board/ is private to this Agent OS.' }, { t: at(-1, 15, 12).toISOString(), tool: 'Grep', path: `${VAULT}/People/compensation.md`, reason: 'Quorum read guard: this note is marked confidential in its frontmatter.' }],
    summary: { on: 7, toReview: 2, denyDirs: 3, terms: 14 },
  }),
  guardrailsTest: async (rel: string) => ({ blocked: /board|personal/i.test(rel) ? `${rel.split('/')[0]}/ is private` : null }),
  // #update in the preview URL shows the Update button, for screenshots of that state
  updateStatus: async () => ({ status: location.hash.includes('update') ? 'ready' : 'idle', current: '0.2.7', version: location.hash.includes('update') ? '0.2.8' : null, percent: 0, notes: null, checkedAt: Date.now() - 600000, error: null }),
  vaultTree: async () => vault.tree,
  vaultGraph: async () => vault.graph,
  vaultLinkHealth: async () => [],
  vaultSearch: async () => [],
};

// Anything the sample does not define still answers: a subscription returns its unsubscribe, a call resolves to null.
// A bridge method added to the app later therefore needs no change here unless Home or Memory reads its result.
window.quorum = new Proxy(sample as Bridge, {
  get(target, key) {
    if (key in target) return target[key as keyof Bridge];
    if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => () => {};
    return () => Promise.resolve(null);
  },
});
