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

- **Knowledge tab.** A third top tab in a signed-in Cloud build lists the workspace vault's shared notes with search and a read view, and carries the admin review queue (Settings › Knowledge keeps the auto-include switch). The graph view is named Memory. The tab reads the vault folder on this Mac on every open (every note's frontmatter, synchronously; fine at tens of notes, and a per-note index can replace it later); it does not yet show who shared a note, since the pull keeps no author in the bond. The top bar and the ee pages each subscribe to the account on their own (App.tsx and ee/src/Account.tsx's useAccount); one shared hook would remove the second subscription.
- **Workspace vault.** Teammates' included notes pull into `~/Documents/Quorum Team/<workspace>/` with provenance bonds (`docs/specs/team-knowledge.md`, Build status). The agent does not read that folder yet, and an edited copy marked behind has no Push improvement yet.

- **Google sign-in.** Needs an OAuth client. Email code sign-in works today. (Google Calendar is separate and live: `docs/self-hosting.md`, Google Calendar connector.)
- **Auth mail when self-hosting.** The built-in Supabase sender allows about 2 emails per hour; a self-hosted project needs a custom SMTP provider (see `docs/self-hosting.md`). The hosted service has one.
- **Updates.** Both editions check a static feed on the latest published GitHub release (Local: `latest-mac.yml`; Cloud: `cloud-mac.yml`, the `cloud` channel) and show an Update button once a version is downloaded. The release workflow attaches both editions to one draft; nothing updates until the first release is published. `QUORUM_CLOUD_UPDATES_URL` at package time points a Cloud build at another feed host.
- **Hosted model access.** Beyond managed transcription, absent. Model calls use the user's Claude Code sign-in or the user's own API key in both editions.

## Guardrails

- **Two scopes.** Individual rules (built in, found in the Agent OS, the person's own) are the person's and work in both editions. Organization or team rules need migration 0015 (`workspace_settings.guardrails`, `workspace_guardrails_set`); admins set them under Admin, Guardrails, each one can be switched off there, and members cannot turn them off. Until 0015 is applied to a hosted project, that page shows an error on save and members run with individual rules only.
- **Discovery on connect reads the vault itself.** Besides guard hooks and opt-out lists, the review reads CLAUDE.md for sharing rules that name a folder or a frontmatter marker, tallies the marker keys notes carry (a value key such as `visibility:` counts only with a value that is not open, and is never offered as a key rule while any note sets it to `public` or the like), finds folders where nearly every note is marked, and reads the folders Obsidian excludes. Each becomes a folder or frontmatter rule the person includes or leaves out; nothing is on until reviewed, and an included rule keeps enforcing after the Agent OS stops offering it, marked as no longer found, until the person leaves it out. The scan reads the head of each note, runs in the background on connect and when the Guardrails page opens, stops at 5000 notes and says so, and its result is kept in settings; no hot path walks the vault. What was looked at and left out is listed on the page.
- **Hooks from the Agent OS run only with Claude Code.** An included hook is attached to Claude Code's run; Codex and Antigravity have no hook point, so with those runners a hook is recorded and the row says so. Every other kind of rule is enforced in both editions through the read guard, the sync exclusion, the vault index (a denied folder, file name or frontmatter key never enters search, and a rule change rebuilds the index) and the term filter.

## Runners

- **Codex and Antigravity run summary and notes only.** Both are providers in Settings, Connectors (print mode on the person's own sign-in; `app/runners.js`). The agent role, which reads the Agent OS, stays with Claude Code: its hooks carry Quorum's read guard, and neither runner has a per-run hook that could deny confidential notes. Letting them run the agent role without the guard is a product decision, not a code gap.
- **Install and sign-in from inside Quorum.** Not yet; the row says whether the runner is installed and links to its docs.

## Settings

- **Beta gate** (`app/beta.js`, `src/BetaGate.tsx`). While `quorumBetaGate` is true in `app/package.json` (or `QUORUM_BETA_GATE` is set), every install without an accepted access code shows the code screen before anything else, onboarded or not. The relay checks the code (`POST /v1/beta/check`) and the install reports code, an anonymous machine id and version once a day (`POST /v1/beta/heartbeat`); Preferences, About says so and shows the id. The Cloud edition's sign-up still claims the same code for the account. Nothing turns the reporting off during the beta; the gate ends by flipping the flag in a release.
- **Teams are opt-in** (migration 0019, Admin, Teams). A workspace starts as one person's. Members, organization connectors, voice and guardrails, knowledge review and the Knowledge tab's team content appear only after an owner or admin turns on "Enable a team"; the company name, description and logo live on that page. A project without 0019 reads every workspace as team off.
- **Billing page** (Admin, Billing). Plan, seats, packs and the Stripe pages moved here from General, with the card on file (relay `POST /v1/billing/card`, admins only), usage this month against seats plus packs, team billing once a team is on, and the Free and Cloud columns with the self-serve switch. The Local edition has no Billing page.
- **Screen context** (Preferences, "Use what's on screen for spelling"). One screenshot of the front window at each capture or dictation start, read on the Mac with Vision; capitalized words, product words and acronyms join the recognizer's spelling hints (`helper/Sources/QuorumHelper/ScreenContext.swift`). Needs the Screen Recording permission, asked once when the toggle goes on. Read once per start: a slide shown later in the call is not picked up until the next start.

- Rows for features that have not shipped stay visible as a to-do map until the features ship.
