# Known gaps

Product gaps as of 2026-11-10. Each item says what is missing, what the app does meanwhile, and what closes it.

## Meetings

- **Microsoft Teams.** Detection and capture are wired and untested. There is no chat notice yet. Plan in `docs/plans/microsoft-teams.md`.
- **Cloud recordings.** The Zoom connector imports cloud recordings and their transcripts through Quorum Cloud (the relay holds the Zoom app's secret). Google Meet and Teams have no cloud-recording import yet; the live listener on this Mac covers them.
- **Google Meet replies.** STOP and GO replies are read only while the Meet tab is the active tab. Plan in `docs/plans/google-meet.md`.

## Agent OS

- **Power-ups.** Settings, Memory, Power-ups lists what the scan found in the connected Agent OS: memory index, search, link graph, guard hooks, agent instructions, skills, agents and MCP servers. Index, search, graph and folders feed the agent today. Instructions, skills, agents and MCP servers are listed and will become runnable later.
- **Optional markers.** The features below turn on only when the connected folder has the file. Without it the app degrades quietly.

| Feature | Marker | Without it | Fix |
|---|---|---|---|
| Opt-out redaction list | `scripts/embed-bench/excluded.txt` | No term redaction in transcripts or suggestions | Create the file, one term per line |
| Link graph expansion | `scripts/graph_links.py` | Hints are keyword-only | Add the script, or leave the marker out |
| Semantic search | a vector index next to the search script | Settings labels search as "Keyword search" | Fine as is |

- **Meeting notes folder.** Saved notes land in `08-meetings/quorum/` under the vault. Imports from other note takers target a sibling folder, for example `08-meetings/granola/`.

## Cloud edition

- **Google sign-in.** Needs an OAuth client. Email code sign-in works today. (Google Calendar is separate and live: `docs/self-hosting.md`, Google Calendar connector.)
- **Auth mail when self-hosting.** The built-in Supabase sender allows about 2 emails per hour; a self-hosted project needs a custom SMTP provider (see `docs/self-hosting.md`). The hosted service has one.
- **Updates.** The Cloud edition ships from quorum.watch and has no update feed; it does not check for updates. The Local edition updates from GitHub Releases. The plan is an electron-updater `generic` feed on quorum.watch (`docs/release-checklist.md`).
- **Hosted model access.** Beyond managed transcription, absent. Model calls use the user's Claude Code sign-in or the user's own API key in both editions.

## Runners

- **Codex and Antigravity run summary and notes only.** Both are providers in Settings, Connectors (print mode on the person's own sign-in; `app/runners.js`). The agent role, which reads the Agent OS, stays with Claude Code: its hooks carry Quorum's read guard, and neither runner has a per-run hook that could deny confidential notes. Letting them run the agent role without the guard is a product decision, not a code gap.
- **Install and sign-in from inside Quorum.** Not yet; the row says whether the runner is installed and links to its docs.

## Settings

- Rows for features that have not shipped stay visible as a to-do map until the features ship.
