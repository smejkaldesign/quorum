// The tools that do what the person can do in Memory health and Knowledge, as the quorum MCP server lists them. Pure
// data, shared by the CLI and the app: each call runs in the running app (appActions.js) through the same handlers as
// the app's buttons. write: refused while Quorum is set to read only. gated: also needs Settings > Memory, Let AI tools
// change memory and knowledge bases.
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const ids = { type: 'array', items: { type: 'string' }, description: 'item ids from review_items' };

export const APP_TOOLS = [
  {
    name: 'review_items', write: false, gated: false,
    description: 'The items in Memory health, Needs review: missing links, review rule findings, past fixes to correct and rules Quorum proposes. Newest first, each with an id for the other review tools, the note it is about, the problem and what Approve does.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['link', 'finding', 'past-fix', 'ignore'], description: 'only this kind' }, unread: { type: 'boolean', description: 'only unread items' }, query: str('only items whose text has every word'), limit: num('1 to 100, default 25'), offset: num('skip this many, default 0') } },
  },
  {
    name: 'review_item', write: false, gated: false,
    description: 'One Needs review item in full: the problem, the proposed fix, why, and the evidence.',
    inputSchema: { type: 'object', properties: { id: str('item id from review_items') }, required: ['id'] },
  },
  {
    name: 'review_approve', write: true, gated: true, blocked: 'approve Needs review items',
    description: 'Approve Needs review items, the same as Approve in Memory health. One id runs that item\'s fix. Several ids run as one batch with one Undo, and the batch can be stopped with fix_cancel. Fixes run in the fix journal and save versions; undo one with fix_undo. Needs Settings > Memory, Let AI tools change memory and knowledge bases.',
    inputSchema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'review_dismiss', write: true, gated: true, blocked: 'archive Needs review items',
    description: 'Archive Needs review items without fixing them, the same as Archive in Memory health: nothing in the notes changes. Needs Settings > Memory, Let AI tools change memory and knowledge bases.',
    inputSchema: { type: 'object', properties: { ids }, required: ['ids'] },
  },
  {
    name: 'review_mark_read', write: true, gated: false,
    description: 'Mark Needs review items read, or unread with unread: true. Changes no notes.',
    inputSchema: { type: 'object', properties: { ids, unread: { type: 'boolean' } }, required: ['ids'] },
  },
  {
    name: 'memory_check_start', write: true, gated: false,
    description: 'Check everything now, the same as the button in Settings > Memory: the memory agent reads every note and adds what it finds to Needs review. It changes no notes. It runs on the person\'s Claude Code sign-in and turns on Let the agent draft fixes if that is off.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_check_status', write: false, gated: false,
    description: 'Whether Check everything now is running, how far it is, and what it found.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fix_runs', write: false, gated: false,
    description: 'The Memory health fixes from the last week, newest first: each with an id for fix_undo, its batch for fix_cancel, its status, what it changed, who approved it, and whether it can be undone.',
    inputSchema: { type: 'object', properties: { limit: num('1 to 100, default 20') } },
  },
  {
    name: 'fix_cancel', write: true, gated: false,
    description: 'Cancel a batch of fixes, the same as Cancel on the batch banner: queued fixes end without running, and the running one stops and puts back every note it changed.',
    inputSchema: { type: 'object', properties: { batch: str('batch id from review_approve or fix_runs') }, required: ['batch'] },
  },
  {
    name: 'fix_undo', write: true, gated: true, blocked: 'undo memory fixes',
    description: 'Undo a fix that ran, the same as Undo in Notifications: its notes go back to how they were and its items return to Needs review. Refused when a note changed after the fix. Needs Settings > Memory, Let AI tools change memory and knowledge bases.',
    inputSchema: { type: 'object', properties: { id: str('fix id from fix_runs') }, required: ['id'] },
  },
  {
    name: 'kb_create', write: true, gated: true, blocked: 'create knowledge bases',
    description: 'Create a Quorum Cloud knowledge base in the person\'s workspace, optionally for one team. Needs the app signed in and Settings > Memory, Let AI tools change memory and knowledge bases.',
    inputSchema: { type: 'object', properties: { name: str('up to 120 characters'), team: str('team id, for a team\'s knowledge base') }, required: ['name'] },
  },
  {
    name: 'kb_attach_github', write: true, gated: true, blocked: 'attach GitHub repositories to knowledge bases',
    description: 'Keep a GitHub repository, or a folder in it, synced into a knowledge base, at its top level. The person must be an admin of the knowledge base. Quorum opens a GitHub sign-in in the browser for the person to finish. Needs Settings > Memory, Let AI tools change memory and knowledge bases.',
    inputSchema: { type: 'object', properties: { kb: str('knowledge base id from kb_list'), url: str('the repository or folder link on github.com'), branch: str('default branch when left out') }, required: ['kb', 'url'] },
  },
  {
    name: 'kb_list_attachments', write: false, gated: false,
    description: 'The folders synced into a knowledge base from Google Drive and GitHub, with their status.',
    inputSchema: { type: 'object', properties: { kb: str('knowledge base id from kb_list') }, required: ['kb'] },
  },
  {
    name: 'connector_status', write: false, gated: false,
    description: 'The accounts the person can connect in Quorum (Google Calendar, Google Drive, Notion, Slack, GitHub): whether each is connected, as whom, any sign-in error, and which read tools it gives.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const appTool = (name) => APP_TOOLS.find((t) => t.name === name) ?? null;
export const AGENT_SETTING = 'Let AI tools change memory and knowledge bases';
