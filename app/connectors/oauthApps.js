// Quorum's own registered OAuth apps for personal connectors, one per provider, used by both editions. Pure data so the
// renderer and the main process share it. Client ids are public and come from the environment or the packaged
// package.json (sources/accounts.js reads them); client secrets never live in the app, apart from Google's Desktop
// client secret, which Google treats as a public identifier for installed apps (sources/gcal.js reads it).
//
// exchange says who swaps the authorization code for tokens:
//   direct  the app calls the provider itself (Google: Desktop client, PKCE, loopback redirect)
//   relay   the relay adds the server-held client secret (relay/oauth.js) and the provider redirects to the relay,
//           which sends the browser on to the app's loopback
// delegate names a connector whose sign-in lives in its own module (Google Calendar in sources/gcal.js); accounts.js
// still owns its status and its disconnect, so the shared Google client is revoked only when nothing else uses it.
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';

export const OAUTH_APPS = {
  'google-calendar': {
    name: 'Google Calendar', client: 'google', exchange: 'direct', pkce: true, delegate: 'gcal',
    authorize: GOOGLE_AUTHORIZE,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'], scopeParam: 'scope', scopeSep: ' ',
    params: { access_type: 'offline', prompt: 'consent select_account' },
    scopeNote: 'calendar.readonly: Quorum reads events and never writes to your calendar',
  },
  'google-drive': {
    name: 'Google Drive', client: 'google', exchange: 'direct', pkce: true,
    authorize: GOOGLE_AUTHORIZE,
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
    // user scopes: Quorum uses the person's own user token, in the channels they are already in
    scopes: ['channels:read', 'groups:read', 'chat:write', 'users:read'], scopeParam: 'user_scope', scopeSep: ',',
    params: {},
    scopeNote: 'channels:read, groups:read, chat:write, users:read, with your own user token',
  },
  github: {
    // a GitHub App with user-to-server tokens: no OAuth scopes; the app's permissions (Contents and Metadata, read
    // only) apply, limited to the repositories where the person installs the app
    name: 'GitHub', client: 'github', exchange: 'relay', pkce: true,
    authorize: 'https://github.com/login/oauth/authorize',
    scopes: [], scopeParam: null, scopeSep: ' ',
    params: { allow_signup: 'false' },
    scopeNote: 'Read-only Contents and Metadata, on the repositories where you install the Quorum GitHub App',
  },
};

// the environment variable that carries each client id; the packaged package.json carries the same values under
// quorumOAuth.<client> (quorumGoogle for the Google pair)
export const CLIENT_ID_ENV = { google: 'QUORUM_GOOGLE_CLIENT_ID', notion: 'QUORUM_NOTION_CLIENT_ID', slack: 'QUORUM_SLACK_CLIENT_ID', github: 'QUORUM_GITHUB_APP_CLIENT_ID' };
// the GitHub App's URL name, for the page where the person picks the repositories it may read
export const GITHUB_APP_SLUG_ENV = 'QUORUM_GITHUB_APP_SLUG';
export const isOAuthApp = (id) => Object.hasOwn(OAUTH_APPS, id);
