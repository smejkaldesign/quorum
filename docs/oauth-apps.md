# Quorum's OAuth apps for personal connectors

Settings, Connectors lists Google Calendar and, under Accounts, Google Drive, Notion, Slack and GitHub. Each connects with one sign-in through an app Quorum registers once with the provider (for GitHub, a GitHub App), and both editions use the same apps. This page lists what to register under Quorum's developer accounts, the redirect URIs to enter, and where each value goes.

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
6. Disconnect revokes the token with the provider (Google and Slack from the app, Notion and GitHub through `/v1/oauth/revoke` on the relay, since their revoke calls need the secret), then deletes it from the Keychain. If the revoke fails, the local token is deleted anyway. Google Calendar and Google Drive share one Google client, and revoking any token ends the whole grant to that client, so Quorum revokes with Google only when the other Google connector is not connected to the same account; otherwise it deletes the local token only.

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
6. Verification. `calendar.readonly` is a sensitive scope, so publishing to production needs Google's verification: the scope justification, a short screen recording of the Connect flow and of where Quorum shows calendar events, and the verified domain. Sensitive scope verification is free and takes a few days to a few weeks. `drive.file` is non-sensitive and needs no extra review. Neither scope is restricted, so no CASA security assessment applies. Until verification passes, keep the app in Testing and add test users; Google expires refresh tokens issued in Testing after 7 days. The step-by-step submission, with text to paste and the video shot list, is in `docs/google-verification.md`.

Values: the client id and client secret are already the repository secrets `QUORUM_GOOGLE_CLIENT_ID` and `QUORUM_GOOGLE_CLIENT_SECRET`.

### Google Picker (Add from Google Drive)

With `drive.file`, Quorum can read a Drive file only after the person picks it in the Google Picker. The knowledge base page and the Knowledge tab's folder menu open the picker for a KB admin. The picker is Google's web component, so it needs a browser page: the app serves that page on the loopback, `http://127.0.0.1:47833/picker/<random>`, opens it in the default browser, and the page posts the picked file ids back to the same address. The access token goes from the Keychain to that page and to Google only. Picking grants `drive.file` access to each picked file for Quorum's Google client; the Picker's app id (the Google Cloud project number) ties the grant to that client.

1. APIs and services, Library: enable **Google Picker API** (Google Drive API is already on from step 1).
2. APIs and services, Credentials, Create credentials, API key. Name it Quorum Picker, then edit it:
   - Application restrictions: Websites, and add `http://127.0.0.1:47833/*`.
   - API restrictions: Restrict key, and pick Google Picker API and Google Drive API.
3. Copy the key. It ships inside the app, as every Picker key does in a web page, so the two restrictions above are what protect it.
4. The app id is the project number (Google Cloud console, the project's Dashboard, Project info). The client id starts with the same number, and the app uses that number when no app id is set.

Values: `QUORUM_GOOGLE_PICKER_API_KEY` (repository secret) and, only when the project number differs from the client id's prefix, `QUORUM_GOOGLE_PICKER_APP_ID` (repository variable). Until the key is in the build, Add from Google Drive says it is not available yet.

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

## GitHub (a GitHub App)

GitHub uses a GitHub App with user-to-server tokens. A GitHub App can be limited to read-only repository contents, which an OAuth app cannot: the narrowest OAuth app scope that reads private repositories is `repo`, which also grants write access.

1. Open `https://github.com/organizations/smejkaldesign/settings/apps/new` (or Settings, Developer settings, GitHub Apps, New GitHub App on the personal account).
2. GitHub App name Quorum, homepage URL `https://quorum.watch`. The name sets the app's URL name (its slug), shown afterwards as `https://github.com/apps/<slug>`.
3. Identifying and authorizing users:
   - Callback URL: `https://relay.quorum.watch/v1/oauth/github/callback`
   - Expire user authorization tokens: on (the default). Tokens last 8 hours and come with a refresh token; the app refreshes them through the relay.
   - Request user authorization (OAuth) during installation: off. With it on, GitHub sends a code from the install page to the callback without the state and PKCE challenge Quorum's Connect sends, and no Quorum sign-in is waiting for it. Connect authorizes the account; installing is a separate step (below).
   - Enable Device Flow: off.
4. Post installation: leave the Setup URL empty and Redirect on update off.
5. Webhook: clear Active. Quorum needs no webhook.
6. Permissions, Repository permissions: **Contents: Read-only**. **Metadata: Read-only** is set automatically. Leave every other repository, organization and account permission at No access.
7. Where can this GitHub App be installed: Any account.
8. Create the app. On its page, copy the Client ID (it starts with `Iv`), generate a client secret and copy it, and note the slug. Quorum does not use the app's private key or installation tokens.

What this changes for the person: Connect signs them in and the token can read only repositories where the Quorum app is installed and that they can already read. The connected row's menu has Choose repositories, which opens `https://github.com/apps/<slug>/installations/new` to install the app on their account or organization and pick repositories. PKCE, the relay exchange, refresh and revoke (`DELETE /applications/<client_id>/grant`) work the same way as for an OAuth app. GitHub does not review GitHub Apps.

## Where the values go

### App (both editions)

The client ids are public. They go into the build; the secrets for Notion, Slack and GitHub never do.

| Variable | Where to set it | Used for |
|---|---|---|
| `QUORUM_GOOGLE_CLIENT_ID`, `QUORUM_GOOGLE_CLIENT_SECRET` | repository secrets (already set); shell or repo `.env` for a dev build | Google Calendar and Google Drive |
| `QUORUM_NOTION_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | Notion |
| `QUORUM_SLACK_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | Slack |
| `QUORUM_GITHUB_APP_CLIENT_ID` | repository variable; shell or repo `.env` for a dev build | GitHub (the GitHub App's Client ID) |
| `QUORUM_GITHUB_APP_SLUG` | repository variable; shell or repo `.env` for a dev build | the Choose repositories link |
| `QUORUM_GOOGLE_PICKER_API_KEY` | repository secret; shell or repo `.env` for a dev build | the Google Picker behind Add from Google Drive |
| `QUORUM_GOOGLE_PICKER_APP_ID` | optional repository variable; shell or repo `.env` for a dev build | the Picker's app id when it is not the client id's project number |
| `QUORUM_RELAY_URL` | optional; shell for a dev build | a relay other than `wss://relay.quorum.watch` |

The release workflow writes the new ids into the packaged `package.json` as `quorumOAuth.<provider>.clientId` (and `quorumOAuth.github.slug`, and `quorumOAuth.googlePicker.apiKey` and `.appId`), the same way it writes `quorumGoogle`.

### Relay (Railway, service relay)

| Variable | Value |
|---|---|
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | from the Notion integration |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | from the Slack app |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | from the GitHub App |
| `RELAY_PUBLIC_URL` | leave unset; the default is `https://relay.quorum.watch` |
| `OAUTH_EXTRA_REDIRECT_URIS` | leave unset in production; a development relay lists its own callback URLs here, comma separated |

After the variables are set and the relay is deployed, `https://relay.quorum.watch/healthz` reports `"oauth": { "notion": true, "slack": true, "github": true }`.

## Testing against a relay on the Mac

Run the relay with `RELAY_PUBLIC_URL=http://127.0.0.1:8787` and start the app with `QUORUM_RELAY_URL=ws://127.0.0.1:8787`. Add `http://127.0.0.1:8787/v1/oauth/<provider>/callback` as a second redirect URI on the Notion integration and as a second callback URL on the GitHub App. Slack expects HTTPS redirect URLs, so test Slack against the deployed relay.

## Self-hosting

Register your own apps with the steps above, using your relay's address in every redirect URI, then set the app and relay variables with your values. See `docs/self-hosting.md`, Personal account connectors.
