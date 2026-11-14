// Quorum's own registered OAuth apps for personal connectors, one per provider, used by both editions. Pure data so the
// renderer and the main process share it. Client ids are public and come from the environment or the packaged
// package.json (sources/accounts.js reads them); client secrets never live in the app, apart from Google's Desktop
// client secret, which Google treats as a public identifier for installed apps and which is read the same way as for the
// Google Calendar connector (sources/gcal.js).
//
// exchange says who swaps the authorization code for tokens:
//   direct  the app calls the provider itself (Google: Desktop client, PKCE, loopback redirect)
//   relay   the relay adds the server-held client secret (relay/oauth.js) and the provider redirects to the relay,
//           which bounces the browser to the app's loopback
// Google Calendar is the same Google client with the calendar.readonly scope and keeps its own flow in sources/gcal.js.
export const OAUTH_APPS = {
  'google-drive': {
    name: 'Google Drive', client: 'google', exchange: 'direct', pkce: true,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    // drive.file reaches only the files Quorum creates or the person opens with it, so it needs no security assessment
    scopes: ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'], scopeParam: 'scope', scopeSep: ' ',
    params: { access_type: 'offline', prompt: 'consent select_account' },
    scopeNote: 'drive.file: only the files Quorum creates or you open with it',
  },
  notion: {
    name: 'Notion', client: 'notion', exchange: 'relay', pkce: false,
    authorize: 'https://api.notion.com/v1/oauth/authorize',
    scopes: [], scopeParam: null, scopeSep: ' ',
    params: { owner: 'user' },
    scopeNote: 'The pages and databases you pick on Notion\'s consent screen',
  },
  slack: {
    name: 'Slack', client: 'slack', exchange: 'relay', pkce: false,
    authorize: 'https://slack.com/oauth/v2/authorize',
    // user scopes: Quorum acts as the person, in the channels they are already in
    scopes: ['channels:read', 'groups:read', 'chat:write', 'users:read'], scopeParam: 'user_scope', scopeSep: ',',
    params: {},
    scopeNote: 'channels:read, groups:read, chat:write, users:read, as you',
  },
  github: {
    name: 'GitHub', client: 'github', exchange: 'relay', pkce: true,
    authorize: 'https://github.com/login/oauth/authorize',
    // OAuth apps have no read-only scope for private repositories; repo is the narrowest that reads them
    scopes: ['repo', 'read:user'], scopeParam: 'scope', scopeSep: ' ',
    params: { allow_signup: 'false' },
    scopeNote: 'repo and read:user: reads your repositories for knowledge base imports',
  },
};

// the environment variable and the packaged package.json field that carry each client id
export const CLIENT_ID_ENV = { google: 'QUORUM_GOOGLE_CLIENT_ID', notion: 'QUORUM_NOTION_CLIENT_ID', slack: 'QUORUM_SLACK_CLIENT_ID', github: 'QUORUM_GITHUB_CLIENT_ID' };
export const OAUTH_APP_IDS = Object.keys(OAUTH_APPS);
export const isOAuthApp = (id) => Object.hasOwn(OAUTH_APPS, id);
