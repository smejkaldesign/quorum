# Quorum's OAuth apps for personal connectors

Settings, Connectors, Accounts lists Google Drive, Notion, Slack and GitHub. Each connects with one sign-in through an OAuth app Quorum registers once with the provider, and both editions use the same apps. This page lists what to register under Quorum's developer accounts, the redirect URIs to enter, and where each value goes.

Until a provider's client id is in the build, its row shows "Not available yet" and offers no button.

## How the flow works

1. The app opens the provider's consent page with a random `state` and, where the provider supports it, a PKCE challenge (Google and GitHub).
2. The provider redirects the browser:
   - Google: straight to the app's loopback, `http://127.0.0.1:47832/callback`.
   - Notion, Slack, GitHub: to the relay, `https://relay.quorum.watch/v1/oauth/<provider>/callback`, which answers with a redirect to the same loopback. The relay stores nothing.
3. The app checks `state`, then exchanges the code:
   - Google: the app calls Google's token endpoint with the Desktop client id and secret (Google treats that secret as a public identifier for installed apps).
   - Notion, Slack, GitHub: the app posts `{ provider, code, code_verifier, redirect_uri }` to `https://relay.quorum.watch/v1/oauth/token`. The relay checks the provider and the redirect URI against its allowlists, adds the client secret from its environment, calls the provider and returns the tokens. Nothing is stored and no token, code or verifier is logged. The route is rate limited per address.
4. Tokens go to the Mac's Keychain (service `quorum-source-account-<id>`). Settings keep only whether the account is connected and its label.
5. Refresh runs a minute before expiry: Google directly, the others through the same relay route with `grant_type: refresh_token`.
6. Disconnect revokes the token with the provider (Google and Slack from the app, Notion and GitHub through `/v1/oauth/revoke` on the relay, since their revoke calls need the secret), then deletes it from the Keychain. If the revoke fails, the local token is deleted anyway.

Google Calendar is the same Google client with the `calendar.readonly` scope and keeps its own flow (`app/sources/gcal.js`).

## Google (Calendar and Drive)

Use the Google Cloud project that already holds the Desktop client `247537775138-ms93108a3kv4a50ulnnia80ipfs1hha6.apps.googleusercontent.com`.

1. APIs and services, Library: enable **Google Calendar API** and **Google Drive API**.
2. Google Auth Platform, Branding: app name Quorum, the support email, the logo, home page `https://quorum.watch`, the privacy policy and terms URLs on quorum.watch, and `quorum.watch` under Authorized domains. Verify the domain in Google Search Console with the same Google account.
3. Google Auth Platform, Audience: user type External.
4. Google Auth Platform, Data Access, Add or remove scopes:
   - `openid` and `.../auth/userinfo.email` (non-sensitive)
   - `https://www.googleapis.com/auth/calendar.readonly` (sensitive)
   - `https://www.googleapis.com/auth/drive.file` (non-sensitive)
5. Clients: keep the existing Desktop app client. Desktop clients accept the loopback redirect on any port, so there is no redirect URI to enter.
6. Verification. `calendar.readonly` is a sensitive scope, so publishing to production needs Google's verification: the scope justification, a short screen recording of the Connect flow and of where Quorum shows calendar events, and the verified domain. Sensitive scope verification is free and takes a few days to a few weeks. `drive.file` is non-sensitive and needs no extra review. Neither scope is restricted, so no CASA security assessment applies. Until verification passes, keep the app in Testing and add test users; Google expires refresh tokens issued in Testing after 7 days.

Values: the client id and client secret are already the repository secrets `QUORUM_GOOGLE_CLIENT_ID` and `QUORUM_GOOGLE_CLIENT_SECRET`. Nothing new is needed for Drive.

## Notion

1. Open `https://www.notion.so/profile/integrations` and choose New integration.
2. Type: **Public**. Associated workspace: the Smejkal Design workspace.
3. Company name Smejkal Design, website `https://quorum.watch`, the privacy policy and terms URLs, and the support email.
4. Redirect URIs: `https://relay.quorum.watch/v1/oauth/notion/callback`
5. Capabilities: Read content, Update content, Insert content. User capabilities: Read user information including email addresses (the connected row shows the email).
6. Save, then copy the OAuth client ID and the OAuth client secret from the Configuration tab.

Notion does not review public integrations unless they are listed in its marketplace.

## Slack

1. Open `https://api.slack.com/apps`, Create New App, From scratch. Name Quorum, development workspace: Smejkal Design.
2. OAuth and Permissions, Redirect URLs: add `https://relay.quorum.watch/v1/oauth/slack/callback` and save.
3. OAuth and Permissions, User Token Scopes: `channels:read`, `groups:read`, `chat:write`, `users:read`. Leave Bot Token Scopes empty; Quorum acts with the person's own user token.
4. Optional: turn on token rotation under OAuth and Permissions. The app and relay already handle the refresh token it adds.
5. Manage Distribution: complete the checklist and activate public distribution, so people outside the development workspace can connect.
6. Basic Information, App Credentials: copy the Client ID and the Client Secret.

The Slack Marketplace review is optional; a distributed app that is not listed works with the Connect button.

## GitHub

1. Open `https://github.com/organizations/smejkaldesign/settings/applications` (or Settings, Developer settings, OAuth Apps on the personal account) and choose New OAuth app.
2. Application name Quorum, homepage URL `https://quorum.watch`.
3. Authorization callback URL: `https://relay.quorum.watch/v1/oauth/github/callback`
4. Leave Enable Device Flow off. Register the app.
5. Generate a new client secret and copy it with the Client ID.

The app asks for `repo` and `read:user`. OAuth apps have no read-only scope for private repositories, so `repo` is the narrowest scope that lets a later knowledge base import read them. GitHub does not review OAuth apps.

## Where the values go

### App (both editions)

The client ids are public. They go into the build; the secrets for Notion, Slack and GitHub never do.

| Variable | Where to set it | Used for |
|---|---|---|
| `QUORUM_GOOGLE_CLIENT_ID`, `QUORUM_GOOGLE_CLIENT_SECRET` | repository secrets (already set); shell or repo `.env` for a dev build | Google Calendar and Google Drive |
| `QUORUM_NOTION_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | Notion |
| `QUORUM_SLACK_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | Slack |
| `QUORUM_GITHUB_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | GitHub |
| `QUORUM_RELAY_URL` | optional; shell for a dev build | a relay other than `wss://relay.quorum.watch` |

The release workflow writes the three new ids into the packaged `package.json` as `quorumOAuth.<provider>.clientId`, the same way it writes `quorumGoogle`.

### Relay (Railway, service relay)

| Variable | Value |
|---|---|
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | from the Notion integration |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | from the Slack app |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | from the GitHub OAuth app |
| `RELAY_PUBLIC_URL` | leave unset; the default is `https://relay.quorum.watch` |
| `OAUTH_EXTRA_REDIRECT_URIS` | leave unset in production; a development relay lists its own callback URLs here, comma separated |

After the variables are set and the relay is deployed, `https://relay.quorum.watch/healthz` reports `"oauth": { "notion": true, "slack": true, "github": true }`.

## Testing against a relay on the Mac

Run the relay with `RELAY_PUBLIC_URL=http://127.0.0.1:8787` and start the app with `QUORUM_RELAY_URL=ws://127.0.0.1:8787`. Add `http://127.0.0.1:8787/v1/oauth/<provider>/callback` as a second redirect URI on the Notion integration and the GitHub app. Slack expects HTTPS redirect URLs, so test Slack against the deployed relay.

## Self-hosting

Register your own apps with the steps above, using your relay's address in every redirect URI, then set the app and relay variables with your values. See `docs/self-hosting.md`, Personal account connectors.
