// The connector library: every tool Quorum connects to or plans to, grouped the way Settings › Connectors shows them.
// Shared by the renderer (the library sheet and the connectors list) and the main process (icons). A connector that
// is not built yet is listed with status 'soon' so people can see where Quorum is going; it never offers an action.
//
// kind says what Connect does when it is available:
//   mcp-source   a meeting-notes source over its MCP server (sources/*.js)
//   macos        a permission on this Mac (Calendar)
//   quorum-mcp   registers Quorum's own MCP server in a coding tool (the quorum CLI)
//   oauth        a hosted OAuth app Quorum registers once and every user authorizes (relay callback)
export const CATEGORIES = [
  { id: 'meeting-notes', name: 'Meeting notes', blurb: 'Tools that already record your meetings. Their notes land in your meeting notes folder, tagged with where they came from.' },
  { id: 'calendar', name: 'Calendar', blurb: 'Upcoming meetings on Home, a reminder before each one, and the right title and people on every note.' },
  { id: 'meetings', name: 'Meeting apps', blurb: 'Cloud recordings and transcripts from the apps your calls run in.' },
  { id: 'communication', name: 'Communication', blurb: 'Share notes where your team talks and draft follow-ups where you write.' },
  { id: 'crm', name: 'Customers', blurb: 'Send meeting notes to the matching people, companies and deals.' },
  { id: 'tasks', name: 'Project management', blurb: 'Turn action items into tasks and issues.' },
  { id: 'docs', name: 'Docs and storage', blurb: 'Save notes where your documents live.' },
  { id: 'ai', name: 'AI and automation', blurb: 'Give your AI tools your meeting notes, and send notes anywhere with automations.' },
];

const c = (id, name, category, domain, description, status = 'soon', kind = 'oauth', extra = {}) => ({ id, name, category, domain, description, status, kind, ...extra });

export const CONNECTORS = [
  // meeting notes
  c('granola', 'Granola', 'meeting-notes', 'granola.ai', 'Notes and summaries from your Granola meetings, kept in sync while Quorum runs.', 'available', 'mcp-source', { source: 'granola', app: 'granola' }),
  c('wispr', 'Wispr Notetaker', 'meeting-notes', 'wisprflow.ai', 'Notes, summaries and transcripts from Wispr Notetaker meetings.', 'soon', 'mcp-source'),
  c('fireflies', 'Fireflies', 'meeting-notes', 'fireflies.ai', 'Notes and transcripts from Fireflies meetings.', 'soon', 'mcp-source'),
  c('read-ai', 'Read AI', 'meeting-notes', 'read.ai', 'Notes and transcripts from Read AI meetings.', 'soon', 'mcp-source'),
  c('otter', 'Otter', 'meeting-notes', 'otter.ai', 'Notes and transcripts from Otter meetings.'),
  c('fathom', 'Fathom', 'meeting-notes', 'fathom.video', 'Notes and transcripts from Fathom meetings.'),
  c('tldv', 'tl;dv', 'meeting-notes', 'tldv.io', 'Notes and transcripts from tl;dv meetings.'),
  // calendar
  c('apple-calendar', 'Calendar on this Mac', 'calendar', 'apple.com', 'Reads the calendars you already have in the Calendar app. Upcoming meetings show on Home.', 'available', 'macos'),
  c('google-calendar', 'Google Calendar', 'calendar', 'calendar.google.com', 'See your upcoming meetings, get a reminder before each one, and give every note the right context.'),
  c('outlook', 'Outlook', 'calendar', 'outlook.com', 'See your upcoming meetings, get a reminder before each one, and give every note the right context.'),
  // meeting apps
  c('zoom', 'Zoom', 'meetings', 'zoom.us', 'Cloud recordings and transcripts from your Zoom meetings.', 'soon', 'oauth', { app: 'zoom' }),
  c('google-meet', 'Google Meet', 'meetings', 'meet.google.com', 'Recordings and transcripts from your Google Meet calls.', 'soon', 'oauth', { app: 'meet' }),
  c('teams', 'Microsoft Teams', 'meetings', 'teams.microsoft.com', 'Transcripts from your Teams meetings, where your organization allows it.', 'soon', 'oauth', { app: 'teams' }),
  // communication
  c('slack', 'Slack', 'communication', 'slack.com', 'Share meeting notes to any Slack channel, or post them from a folder on their own.'),
  c('gmail', 'Gmail', 'communication', 'gmail.com', 'Follow-up emails drafted after your meetings, ready to review and send.'),
  // crm
  c('affinity', 'Affinity', 'crm', 'affinity.co', 'Send meeting notes to the matching Affinity records.'),
  c('attio', 'Attio', 'crm', 'attio.com', 'Send meeting notes to the matching Attio people, companies and deals.'),
  c('gainsight', 'Gainsight', 'crm', 'gainsight.com', 'Send meeting notes to Gainsight.'),
  c('hubspot', 'HubSpot', 'crm', 'hubspot.com', 'Send meeting notes to the right HubSpot contact, company or deal.'),
  c('mailchimp', 'Mailchimp', 'crm', 'mailchimp.com', 'Send meeting notes to Mailchimp.'),
  c('pipedrive', 'Pipedrive', 'crm', 'pipedrive.com', 'Send meeting notes to Pipedrive.'),
  c('salesforce', 'Salesforce', 'crm', 'salesforce.com', 'Send meeting notes to Salesforce as Opportunities, Contacts and Tasks.'),
  // project management
  c('asana', 'Asana', 'tasks', 'asana.com', 'Turn action items into Asana tasks.'),
  c('clickup', 'ClickUp', 'tasks', 'clickup.com', 'Turn action items into ClickUp tasks.'),
  c('github', 'GitHub', 'tasks', 'github.com', 'Turn action items into GitHub issues.'),
  c('jira', 'Jira', 'tasks', 'atlassian.com', 'Turn action items into Jira issues.'),
  c('linear', 'Linear', 'tasks', 'linear.app', 'Turn action items into Linear issues.'),
  c('monday', 'monday.com', 'tasks', 'monday.com', 'Turn action items into monday.com items.'),
  c('trello', 'Trello', 'tasks', 'trello.com', 'Turn action items into Trello cards.'),
  // docs
  c('google-docs', 'Google Docs', 'docs', 'docs.google.com', 'Save meeting notes to Google Docs.'),
  c('google-drive', 'Google Drive', 'docs', 'drive.google.com', 'Save meeting notes to Google Drive.'),
  c('notion', 'Notion', 'docs', 'notion.so', 'Send meeting notes to a Notion database you can sort, filter and build on.'),
  c('onedrive', 'OneDrive', 'docs', 'onedrive.live.com', 'Save meeting notes to OneDrive.'),
  c('onenote', 'OneNote', 'docs', 'onenote.com', 'Save meeting notes to OneNote.'),
  // ai and automation
  c('claude-code', 'Claude Code', 'ai', 'claude.com', 'Ask about your meetings and write specs, PRs and bug reports from what was said, through the quorum MCP server.', 'available', 'quorum-mcp'),
  c('codex', 'Codex', 'ai', 'openai.com', 'Bring your meeting notes into Codex through the quorum MCP server.', 'soon', 'quorum-mcp'),
  c('cursor', 'Cursor', 'ai', 'cursor.com', 'Bring your meeting notes into Cursor through the quorum MCP server.', 'soon', 'quorum-mcp'),
  c('claude', 'Claude', 'ai', 'claude.ai', 'Ask Claude about your meetings: search notes, pull out action items, answer from your history.'),
  c('chatgpt', 'ChatGPT', 'ai', 'chatgpt.com', 'Ask ChatGPT about your meetings: search notes, pull out action items, answer from your history.'),
  c('gemini', 'Gemini', 'ai', 'gemini.google.com', 'Bring your meeting notes into Gemini.'),
  c('copilot', 'Microsoft 365 Copilot', 'ai', 'microsoft.com', 'Bring your meeting notes into Microsoft 365 Copilot.'),
  c('figma', 'Figma', 'ai', 'figma.com', 'Bring your meeting notes into Figma.'),
  c('lovable', 'Lovable', 'ai', 'lovable.dev', 'Bring your meeting notes into Lovable.'),
  c('manus', 'Manus', 'ai', 'manus.im', 'Bring your meeting notes into Manus.'),
  c('replit', 'Replit', 'ai', 'replit.com', 'Bring your meeting notes into Replit.'),
  c('v0', 'v0', 'ai', 'v0.dev', 'Bring your meeting notes into v0.'),
  c('grok', 'Grok', 'ai', 'x.ai', 'Bring your meeting notes into Grok.'),
  c('zapier', 'Zapier', 'ai', 'zapier.com', 'Send your meeting notes to thousands of apps with Zapier automations.'),
];

// What connecting a tool enables, as plain statements. Most tools in a category enable the same things; the overrides
// name what is specific. Shown behind the "Enables N features" badge on every tile and row.
const BY_CATEGORY = {
  'meeting-notes': (n) => [`Imports ${n} notes and summaries into your meeting notes folder, tagged source: ${n.toLowerCase()}`, `Keeps importing new ${n} meetings while Quorum runs`, `Uses ${n}'s own recording and AI; Quorum is the knowledge store`, `Lets ${n} keep running as its own system while Quorum stays in sync`],
  calendar: (n) => [`Shows upcoming meetings from ${n} on Home`, 'Gives each note the meeting title and the people in it', 'Reminds you before each meeting'],
  meetings: (n) => [`Imports cloud recordings and transcripts from ${n} as meeting notes`, `Picks up a recording as soon as ${n} finishes processing it`, 'Covers calls Quorum did not listen to live'],
  communication: (n) => [`Shares a meeting note to ${n}`],
  crm: (n) => [`Sends meeting notes to the matching people, companies and deals in ${n}`, `Logs the meeting on the ${n} record`],
  tasks: (n) => [`Turns action items into ${n} tasks`, 'Links each task back to the meeting note'],
  docs: (n) => [`Saves meeting notes to ${n}`, 'Keeps a copy where your documents already live'],
  ai: (n) => [`Lets ${n} search your meeting notes and answer from them`, `Pulls action items and decisions into ${n}`],
};
const OVERRIDES = {
  'apple-calendar': () => ['Shows upcoming meetings from the Calendar app on Home', 'Gives each note the meeting title and the people in it', 'Reads on this Mac; nothing leaves it'],
  slack: () => ['Shares a meeting note to any Slack channel', 'Posts notes from a folder on their own'],
  gmail: () => ['Drafts a follow-up email after each meeting, ready to review and send'],
  'claude-code': () => ['Lets Claude Code search your notes and meetings through the quorum MCP server', 'Writes specs, PRs and bug reports from what was said', 'Runs on this Mac; no server in between'],
  codex: () => ['Lets Codex search your notes and meetings through the quorum MCP server', 'Writes specs, PRs and bug reports from what was said'],
  cursor: () => ['Lets Cursor search your notes and meetings through the quorum MCP server', 'Writes specs and issues from what was said'],
  zapier: () => ['Sends a meeting note to thousands of apps through a Zap', 'Starts an automation when a note is saved'],
  github: () => ['Turns action items into GitHub issues', 'Links each issue back to the meeting note'],
  jira: () => ['Turns action items into Jira issues', 'Links each issue back to the meeting note'],
  linear: () => ['Turns action items into Linear issues', 'Links each issue back to the meeting note'],
  trello: () => ['Turns action items into Trello cards', 'Links each card back to the meeting note'],
  notion: () => ['Sends meeting notes to a Notion database you can sort, filter and build on', 'Keeps the Notion page in step with the note'],
};
export const featuresOf = (x) => (OVERRIDES[x.id] ?? BY_CATEGORY[x.category] ?? (() => []))(x.name);

export const CONNECTOR_BY_ID = Object.fromEntries(CONNECTORS.map((x) => [x.id, x]));
export const byCategory = (categoryId) => CONNECTORS.filter((x) => x.category === categoryId);
