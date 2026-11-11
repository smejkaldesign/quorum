# Known gaps

Product gaps as of 2026-11-10. Each item says what is missing, what the app does meanwhile, and what closes it.

## Meetings

- **Microsoft Teams.** Detection and capture are wired and untested. There is no chat notice yet. Plan in `docs/plans/microsoft-teams.md`.
- **Cloud recordings.** The Zoom connector imports cloud recordings and their transcripts through Quorum Cloud (the relay holds the Zoom app's secret). Google Meet and Teams have no cloud-recording import yet; the live listener on this Mac covers them.
- **Google Meet replies.** STOP and GO replies are read only while the Meet tab is the active tab. Plan in `docs/plans/google-meet.md`.

## Agent OS

- **Starter folder upkeep.** The keeper files each meeting note into the index, the daily note and the people and project notes it concerns, and writes learned facts with the person's own model source (`docs/specs/starter-agent-os.md`, Build status). Notes the person writes by hand are not indexed by it yet.

- **Power-ups.** Settings, Memory, Power-ups lists what the scan found in the connected Agent OS and every item changes the answer once included: the index, search and the link graph feed the hints; folders are added to the read scope; instructions go into the system prompt; skills and agents load the vault's project settings for the run and open the Skill and Agent tools; MCP servers load from the vault's `.mcp.json` with their tools allowed by name (`app/agent.js`, `agentArgs`). Quorum's own guard hook runs on every variant.
- **Optional markers.** The features below turn on only when the connected folder has the file. Without it the app degrades quietly.

| Feature | Marker | Without it | Fix |
|---|---|---|---|
| Opt-out redaction list | `scripts/embed-bench/excluded.txt` | No term redaction in transcripts or suggestions | Create the file, one term per line |
| Link graph expansion | `scripts/graph_links.py` | Hints are keyword-only | Add the script, or leave the marker out |
| Semantic search | a vector index next to the search script | Settings labels search as "Keyword search" | Fine as is |

- **Meeting notes folder.** Saved notes land in `08-meetings/quorum/` under the vault. Imports from other note takers target a sibling folder, for example `08-meetings/granola/`.

## Cloud edition

- **Workspace vault.** Teammates' included notes pull into `~/Documents/Quorum Team/<workspace>/` with provenance bonds (`docs/specs/team-knowledge.md`, Build status). The agent does not read that folder yet, and an edited copy marked behind has no Push improvement yet.

- **Google sign-in.** Needs an OAuth client. Email code sign-in works today. (Google Calendar is separate and live: `docs/self-hosting.md`, Google Calendar connector.)
- **Auth mail when self-hosting.** The built-in Supabase sender allows about 2 emails per hour; a self-hosted project needs a custom SMTP provider (see `docs/self-hosting.md`). The hosted service has one.
- **Updates.** Both editions check a static feed (Local: GitHub Releases; Cloud: `quorum.watch/updates/cloud`, published at release time per `docs/release-checklist.md`) and show an Update button once a version is downloaded. A Cloud build packaged without `QUORUM_CLOUD_UPDATES_URL` still gets the default feed URL; the feed only exists once a release has been published there.
- **Hosted model access.** Beyond managed transcription, absent. Model calls use the user's Claude Code sign-in or the user's own API key in both editions.

## Guardrails

- **Workspace rules need migration 0015** (`workspace_settings.guardrails`, `workspace_guardrails_set`). Until it is applied to a hosted project, the Admin, Guardrails page shows an error on save and members run with built-in and personal rules only.
- **Hooks from the Agent OS run only with Claude Code.** An included hook is attached to Claude Code's run; Codex and Antigravity have no hook point, which is one reason the agent role stays with Claude Code.

## Runners

- **Codex and Antigravity run summary and notes only.** Both are providers in Settings, Connectors (print mode on the person's own sign-in; `app/runners.js`). The agent role, which reads the Agent OS, stays with Claude Code: its hooks carry Quorum's read guard, and neither runner has a per-run hook that could deny confidential notes. Letting them run the agent role without the guard is a product decision, not a code gap.
- **Install and sign-in from inside Quorum.** Not yet; the row says whether the runner is installed and links to its docs.

## Settings

- **Screen context** (Preferences, "Use what's on screen for spelling"). One screenshot of the front window at each capture or dictation start, read on the Mac with Vision; capitalized words, product words and acronyms join the recognizer's spelling hints (`helper/Sources/QuorumHelper/ScreenContext.swift`). Needs the Screen Recording permission, asked once when the toggle goes on. Read once per start: a slide shown later in the call is not picked up until the next start.

- Rows for features that have not shipped stay visible as a to-do map until the features ship.
