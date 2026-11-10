# Meeting sources (connectors)

Draft, 2026-11-09. Decisions from Eric in chat; Granola is the first source.

## Shape

One manifest per source (id, name, logo, methods, dedupe key, tag). The Sources section lists every manifest. Each imported note carries `source: <id>` and `source_id: <meeting id>`; any method skips a meeting whose `source_id` already exists in the vault (first save wins).

## Methods

Each source offers up to three methods. One method is active per source at a time (radio). Switching is allowed and safe because of the dedupe key.

1. **Connect (recommended).** Quorum's own client: MCP OAuth with dynamic client registration (Granola, Wispr Notetaker, Fireflies, Read AI), or a user API key (Otter, Fathom, tl;dv), or a platform OAuth app (Zoom, Google Meet, Teams). Continuous sync from the app, deterministic copy, no model tokens. Token in Keychain.
2. **Import through your agent (fallback).** Offered only when a connected runner (Claude Code `~/.claude.json`, Codex `~/.codex/config.toml`, Antigravity) already has that source's MCP server configured. Runs the runner headless with a Quorum skill that writes through Quorum's MCP server. Tradeoffs shown on the card before the user starts: spends the user's model tokens; content passes through a model and can be dropped or reshaped; one-time by default; depends on the runner staying installed and signed in. Optional schedule (hourly or daily) runs on the user's tokens from the user's Mac, never on Quorum's account.
3. **Folder.** Point at an existing notes folder (already in onboarding).

Why one active method: running both repeats the same listing work and the agent path spends tokens doing what the connector does for free.

## Adapter contract

Granola set the shape; every meeting-notes source is a manifest in `app/sources/catalog.js` plus a module registered in `app/sources/adapters.js`. The Connectors UI changes per source only through the manifest.

- `verify(mcp)` (optional): right after sign-in, throws a plain-language error when the identity has no account at the source. The token is dropped and the user is told to pick another account.
- `sync({ mcp, existing, since, write, progress })` (required): lists every meeting since `since`, skips ids in `existing` (first save wins), fetches the rest and calls `write(fileName, markdown, meeting)` for each. Markdown carries `source: <id>` and `source_id: <meeting id>`. Returns `{ listed, imported, skipped, failed }`.
- `transcript(mcp, id)` (optional, behind the `transcripts` extra): the whole transcript for one meeting as `{ text, recorder }` or `{ text: null, unavailable: 'pending' | 'final' }`.

Extras are what a source provides beyond its notes. A manifest lists them in `extras`; each gets a checkbox on the connector's Settings tab, off by default. `transcripts` writes each meeting's transcript to a `transcripts/` subfolder next to the notes (History lists only the top level), links it from the note with a `transcript:` frontmatter line, and marks notes the source will never have a transcript for with `transcript: none`. It runs after the notes in the same job, covers already-imported meetings, and never costs a note when it fails. The Settings copy says why it is off by default: transcripts are long and an agent reading one spends far more tokens than on the note. Later extras follow the same pattern: attachments, action items.

## Import job UX

Imports run in the background with a visible progress state (source, count so far, elapsed). The user may leave the page; the card and a completion toast update when done. Failures list the meetings that did not import and offer retry.

## Runner notes

Google retired Gemini CLI for individual accounts on 2026-06-18. The Google runner is Antigravity CLI (`agy`, Google sign-in, free weekly quota, Google AI Pro raises it). Gemini API key remains the BYOK path.

## Agent import (fallback)

The third way in, after a direct connection and a folder: the person's own agent imports the source. Eric, 2026-11-09: the worst option, and an option Quorum offers as a fallback, with its costs stated. `sources/runners.js` reads the runners on this Mac and the MCP servers each has configured (Claude Code `~/.claude.json` at user and project scope, Codex `~/.codex/config.toml`, Antigravity `~/.gemini/config/mcp_config.json`) and matches a source by the host of its MCP URL. When a runner has the source, the connector's page shows "Import through your agent" under the Connectivity card, labelled as the fallback, with four costs listed before the button: it spends the person's model tokens, the notes pass through a model (wording can change), it runs once or on a schedule only while Quorum is open, and it depends on the runner's own sign-in to the source.

The run (`sources/agent-import.js`) starts the runner headless with one task: list the source's meetings through its server (since the last run), fetch each one, and call the quorum MCP server's `import_meeting` tool per meeting. Claude Code gets the quorum server through `--mcp-config` for the run and only `mcp__<server>__*` and `mcp__quorum__*` tools; Codex gets it as `-c mcp_servers.quorum.*` overrides on `codex exec --json`; Antigravity has to carry the quorum server in its own config, since `agy` has no per-run MCP flag. `import_meeting` (cli/quorum.mjs) writes `<meetings>/<source>/<date>-<slug>.md` with `source_id`, `source`, `imported_by: agent` and the notes as the body, and answers `skipped: true` for a meeting Quorum already has, so the run is idempotent. The result counts the notes that actually landed in the folder. An optional schedule (hourly or daily) runs the same job from the sources tick while the direct connection is off.

## Relay connect routes (relay/connect.js)

Platforms refuse loopback redirect URIs and their token exchange needs the client secret, so the relay stands between the app and the platform for Cloud users. Local (BYOK) users register their own platform app and may still use the bounce.

- `GET /v1/connect/<provider>/callback`: the registered redirect URI. Forwards code, state and any error to `http://127.0.0.1:47832/callback` on the user's Mac, where the app's existing loopback listener (sources/oauth.js) is waiting. A state ending in `.p<port>` picks another port; nothing but the loopback can be the destination.
- `POST /v1/connect/<provider>/token`: `{ grant: 'code', code, codeVerifier, redirectUri }` or `{ grant: 'refresh', refreshToken }`. Signed-in member of a paying workspace. The relay adds the client credentials and returns `{ accessToken, refreshToken, expiresAt, scope }`; the platform's own error body is never echoed.
- `POST` / `DELETE /v1/connect/<provider>/account`: `{ workspaceId, accountId, externalUserId }` remembers which platform account is the user's (table `connect_accounts`), so webhooks can be routed; DELETE on disconnect.
- `POST /v1/connect/zoom/webhook`: verifies `x-zm-signature` (v0 HMAC over `v0:<ts>:<body>`, five-minute tolerance), answers `endpoint.url_validation`, stores `recording.completed` and `recording.transcript_completed` in `connect_events` keyed by Zoom account id (a retry of the same recording lands once), ignores other events.
- `GET /v1/connect/events?workspace=&provider=zoom` and `POST /v1/connect/events/ack { workspaceId, provider, ids }`: the undelivered events for the caller's accounts, acknowledged once the app has fetched the recording.

Relay env: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET`. Migration 0014. The app side (task 07595120) does PKCE sign-in through the bounce, calls `GET /users/me` on Zoom to learn the account id and registers it, polls the events feed on its 30-minute tick, downloads recording files and transcripts with the user's token and writes the note.

## Platform apps (Eric creates)

- Zoom: General app, user-managed. Scopes `cloud_recording:read:recording`, `meeting:read:meeting`, `user:read:user`; webhook `recording.completed`. Unpublished apps serve only the developer's own account.
- Google Meet: same GCP project as Google sign-in. Meet REST API + Drive API; scopes `meetings.space.readonly`, `drive.meet.readonly`. Consent screen needs live Privacy and Terms URLs.
- Teams: Entra multi-tenant registration; delegated `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` (admin consent per tenant; no personal accounts). Ship last.
