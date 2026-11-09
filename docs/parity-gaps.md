# Known gaps

Product gaps as of 2026-11-08. Each item says what is missing, what the app does meanwhile, and what closes it.

## Meetings

- **Microsoft Teams.** Detection and capture are wired and untested. There is no chat notice yet. Plan in `docs/plans/microsoft-teams.md`.
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

- **Google sign-in.** Needs an OAuth client. Email code sign-in works today.
- **Auth mail.** The built-in Supabase sender allows about 2 emails per hour. Real use needs a custom SMTP provider (see `docs/self-hosting.md`).
- **Sync.** Push-only. Notes and meetings upload when sync is on; pull sync and conflict snapshots are open.
- **Hosted model access.** Absent. Model calls use the user's Claude Code sign-in or the user's own API key in both editions.

## Settings

- Rows for features that have not shipped stay visible as a to-do map until the features ship.
