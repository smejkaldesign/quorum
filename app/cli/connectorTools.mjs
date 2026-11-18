// The read tools for connected accounts (Slack, Notion, GitHub), as the quorum MCP server and the in-app chat list them.
// Pure data, shared by the CLI and the app: the app runs each call with the person's own token (connectors/tools/).
// A tool is listed only while its account is connected.
export const CONNECTOR_SERVER = 'quorum-connectors';

export const ACCOUNT_NAMES = { slack: 'Slack', notion: 'Notion', github: 'GitHub' };

const num = (description) => ({ type: 'number', description });
const str = (description) => ({ type: 'string', description });

export const CONNECTOR_TOOLS = [
  {
    name: 'slack_search', account: 'slack', step: 'Searching Slack',
    description: 'Search Slack messages in the channels the person can see, with their own Slack sign-in in Quorum. Direct messages are left out. Each result has the channel, who wrote it, the text, the time, a ts for slack_thread and a link. Slack search syntax works: in:#channel, from:@name, before:2026-01-31.',
    inputSchema: { type: 'object', properties: { query: str('what to search for'), limit: num('1 to 50, default 20'), page: num('page number from the previous answer, default 1') }, required: ['query'] },
  },
  {
    name: 'slack_channels', account: 'slack', step: 'Listing Slack channels',
    description: 'The Slack channels the person is in, public and private, with an id for slack_channel_history. Archived channels are left out.',
    inputSchema: { type: 'object', properties: { query: str('only channels whose name contains this') } },
  },
  {
    name: 'slack_channel_history', account: 'slack', step: 'Reading a Slack channel',
    description: 'Recent messages in one Slack channel the person is in, newest first. Takes the channel id from slack_channels or a #name. Messages with replies have a ts and a reply count for slack_thread.',
    inputSchema: { type: 'object', properties: { channel: str('channel id (C...) or #name'), limit: num('1 to 200, default 50'), oldest: str('only messages after this: an ISO date or a Slack ts') }, required: ['channel'] },
  },
  {
    name: 'slack_thread', account: 'slack', step: 'Reading a Slack thread',
    description: 'A Slack thread: the first message and its replies in order. Takes the channel id and the ts of the first message.',
    inputSchema: { type: 'object', properties: { channel: str('channel id (C...) or #name'), ts: str('the ts of the first message') }, required: ['channel', 'ts'] },
  },
  {
    name: 'notion_search', account: 'notion', step: 'Searching Notion',
    description: 'Search the Notion pages and databases the person shared with Quorum, by title. Each result has an id for notion_page, the title, the link and when it was last edited.',
    inputSchema: { type: 'object', properties: { query: str('words in the title'), type: { type: 'string', enum: ['page', 'database'], description: 'only pages or only databases' }, limit: num('1 to 50, default 10') } },
  },
  {
    name: 'notion_page', account: 'notion', step: 'Reading a Notion page',
    description: 'One Notion page as markdown: its properties, then its blocks, with nested blocks up to three levels deep. Takes the id from notion_search or the page link.',
    inputSchema: { type: 'object', properties: { id: str('page id or link') }, required: ['id'] },
  },
  {
    name: 'github_repos', account: 'github', step: 'Listing GitHub repositories',
    description: 'The GitHub repositories where the person installed the Quorum GitHub App, with the owner/name to pass to github_file and github_search_code.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'github_search_code', account: 'github', step: 'Searching GitHub code',
    description: 'Search code in the repositories where the Quorum GitHub App is installed (default branches only). Each result has the repository, the file path for github_file, a link and the matching lines.',
    inputSchema: { type: 'object', properties: { query: str('what to search for; GitHub code search syntax works, for example language:ts'), repo: str('only this repository, owner/name'), limit: num('1 to 50, default 20') }, required: ['query'] },
  },
  {
    name: 'github_file', account: 'github', step: 'Reading a GitHub file',
    description: 'A text file from a GitHub repository where the Quorum GitHub App is installed, at a path and an optional branch, tag or commit. A folder path lists what is in it. Files over 200 KB and binary files are refused.',
    inputSchema: { type: 'object', properties: { repo: str('owner/name'), path: str('file or folder path, empty for the top'), ref: str('branch, tag or commit; default branch when left out') }, required: ['repo'] },
  },
];

export const isConnectorTool = (name) => CONNECTOR_TOOLS.some((t) => t.name === name);
export const connectorTool = (name) => CONNECTOR_TOOLS.find((t) => t.name === name) ?? null;
// the tools whose account is connected, in catalog order
export const toolsFor = (connected) => CONNECTOR_TOOLS.filter((t) => connected.includes(t.account));
export const howToConnect = (account) => `${ACCOUNT_NAMES[account]} is not connected in Quorum. Connect it in Quorum under Settings > Connectors > ${ACCOUNT_NAMES[account]}, then try again.`;
