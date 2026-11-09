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

## Import job UX

Imports run in the background with a visible progress state (source, count so far, elapsed). The user may leave the page; the card and a completion toast update when done. Failures list the meetings that did not import and offer retry.

## Runner notes

Google retired Gemini CLI for individual accounts on 2026-06-18. The Google runner is Antigravity CLI (`agy`, Google sign-in, free weekly quota, Google AI Pro raises it). Gemini API key remains the BYOK path.

## Platform apps (Eric creates)

- Zoom: General app, user-managed. Scopes `cloud_recording:read:recording`, `meeting:read:meeting`, `user:read:user`; webhook `recording.completed`. Unpublished apps serve only the developer's own account.
- Google Meet: same GCP project as Google sign-in. Meet REST API + Drive API; scopes `meetings.space.readonly`, `drive.meet.readonly`. Consent screen needs live Privacy and Terms URLs.
- Teams: Entra multi-tenant registration; delegated `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All` (admin consent per tenant; no personal accounts). Ship last.
