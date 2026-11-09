# Starter Agent OS

Status: decisions folded in 2026-11-08, ready for build planning. Project: Quorum: Open-Source Local Edition + Cloud Foundation, rank 12.

## Problem

Quorum writes meeting notes into an Agent OS: a folder of plain markdown with an index, instructions, guard hooks, skills and a search layer that Claude Code reads. Users who have none get the local starter folder from `app/onboarding.js`: README, `index.md`, `CLAUDE.md`, inbox, daily and meetings folders. Nothing maintains it: the index stops matching the notes within a week, `CLAUDE.md` never learns what the user works on, and there is no search layer.

Default model memory in a chat product holds a few hundred facts with no structure and no guard rules. An Agent OS holds thousands of notes, states how an agent uses them, blocks what it may never read, and serves several tools at once. Cloud sells the parts that need a server: template storage, sync, every-device access and team features. Local stays free and complete (`docs/open-source-strategy.md`).

## Who it is for

1. **No Agent OS yet.** A person who downloads Quorum for meetings, reaches "connect a folder", and has nothing to connect.
2. **Owns an Agent OS already.** A person with a working vault who wants index, instructions and search kept current from meetings, and the folder reachable from every Mac and a browser. The runner works against the existing layout with no template. This path is in v1 as the second template choice, labelled "Maintain my existing vault".

## What the service does

1. **Creates the folder** from a chosen template inside the user's workspace and pulls it to the Mac through sync. Default local path `~/Documents/Quorum`. "Maintain my existing vault" registers the existing folder instead.
2. **Maintains `index.md`.** After every change: one line per note, grouped by folder, stale lines removed. Past a size the agent can read in one pass, it splits by folder under a top-level index.
3. **Maintains `CLAUDE.md`.** Layout, rules, and a short section of facts learned from meetings (people, projects, decisions). Every change lands in a dated `## Changelog` entry the user can see and revert.
4. **Applies the guard rules.** The rules from `app/guards/read-guard.py` (secret-looking file names, private folders, `confidential:` frontmatter) decide what enters the index, the search layer and the learned facts.
5. **Keeps a search layer.** A full-text index over the notes, exposed on the Mac as the `scripts/search-memory.py` that `scanBrain` in `app/main.js` already runs. A query never leaves the Mac.
6. **Ships skills and guards.** Guard hooks in `.claude/hooks/`, a `.claude/skills/` set for the template's audience, and `.claude/settings.json` wiring them, updated with the template version.
7. **Files meetings.** When a meeting note lands: an index line, links from the people and project notes it names, a daily note line, updated learned facts. The meeting note body is never rewritten.

## Where the runner executes (decided 2026-11-08)

The runner executes on the user's Mac inside the Quorum app, with the user's own model source. Cloud provides template storage and versioning, the sync store, web access and team features. Cloud never makes a model call on the user's behalf in v1.

Reasons: Smejkal Design does not carry model costs; every Cloud dollar pays for hosting, ease of use and teams. A runner on the Mac keeps the model path identical to Local.

| On the Mac | Hosted (Cloud) |
|---|---|
| Capture, transcription, note writing, audio | Template storage, folder creation, version updates |
| Runner: index, instructions, links, learned facts, guard rules | Sync store (Supabase), web viewer, members |
| Search index and script; Claude Code, CLI and MCP reads; sync client | Billing, workspace settings |

The runner triggers after each meeting note is written and after each synced change arrives. It runs while the app is open; changes made while the app is closed are processed at next launch.

## Model source and key storage

The runner uses the app's model source from Settings: Claude Code sign-in on this Mac, the user's own API key, or a local model. Nothing runs until one is chosen, and the app says so.

**OAuth reality.** Anthropic and OpenAI do not offer a third-party OAuth flow that hands an app a user's API key or a metered token on their account. "Connect your AI account" therefore means one of two things: the app uses the user's local Claude Code sign-in through the Claude Code process already on the Mac, or the user pastes a key that the app stores in the Mac's Keychain. The Settings copy states this; the app never implies a sign-in button will fetch a key from a provider.

**Key storage (decided).** No user keys are stored server-side in v1. Keys live in the Mac's Keychain and never sync. If a server-side runner is added later, keys are encrypted at rest with per-workspace keys, chosen for security and scale.

**Server-side runner (later option only).** If demand shows for filing while the Mac is closed, a hosted runner can be added. If it runs on a company key, tokens bill straight through monthly at cost with a user-set cap; the suggested range is $10 to $20 per month on top of the $5 seat. At the cap the runner stops until the next month or a higher cap, and Settings says so.

Cost boundary: $5 per seat per month covers hosting, storage, sync and team features. Model cost is the user's in every v1 path.

## Upsell moments and copy constraints

1. **Connect a folder (onboarding).** When the user has nothing to connect, the step shows two equal choices: "Create a free folder on this Mac" first, then "Have Quorum build and maintain one ($5 per seat per month)". A user with a folder sees "Maintain my existing vault" with the same price line.
2. **Settings.** The Memory page with no folder connected, and the Knowledge page, show one row with the same sentences and a Start button; for audience 2 it reads "Keep this folder maintained and reach it from every device".

Copy constraints: plain sentences stating what the service does, what it costs, that the free folder stays available, that model calls use the user's own source, what leaves the Mac (notes, with sync on) and what never does (audio, confidential notes, private folders, keys). No countdowns, discount framing or named competitors. The repository writing rules apply.

## Privacy rules

1. Nothing leaves the Mac until sync is on. Starting the service turns sync on after a confirmation listing what will be pushed.
2. `confidential:` frontmatter, private folders, hidden paths and secret-looking file names never sync and are never indexed (the rules in `app/ee/sync.js`).
3. Audio never leaves the Mac. Transcript segments of private meetings never sync (`0001_init.sql`).
4. The runner reads only the connected vault and writes only `index.md`, `CLAUDE.md`, link sections, daily notes and files under `.claude/`.
5. Each of the seven behaviors has its own toggle in Settings. The privacy page states what the runner reads and which model source receives it.
6. API keys never leave the Keychain; the sync client refuses any file matching the key pattern.

## Templates to ship first

1. **Personal.** `00-inbox/`, `01-daily/`, `02-people/`, `03-projects/`, `05-knowledge/`, `08-meetings/`. Skills: file an inbox note, weekly review.
2. **Founder.** Adds `04-company/`, `06-customers/` and a `decisions/` log (Context, Options, Choice, Outcome). Skills: decision entry, customer note from a meeting, weekly metrics. Guards add `confidential: finance`.
3. **Team lead.** Adds one note per report in `02-people/`, `07-one-on-ones/`, project status lines. Skills: one-on-one prep from the last three meetings, project roll-up. Guards add `confidential: people` for report notes.
4. **Maintain my existing vault.** Creates nothing. The runner reads the existing layout, adds `index.md` and a `## Changelog` section to `CLAUDE.md` if missing, and installs `.claude/` guards and skills only after the user confirms the list.

Each template is `supabase/templates/<name>/template.json` (version, folders, files, skills, guards) plus its files; adding one needs no code change.

## Acceptance criteria

1. A new user with no folder sees both choices at "connect a folder", free first; the free choice creates the local starter folder with no account.
2. Choosing the service, signing in and picking a template pulls the folder to the chosen path within 60 seconds; `scanBrain` detects index, instructions, guards, skills and search.
3. Adding a local note yields a matching `index.md` line within one runner cycle (under 5 minutes with the app open); deleting it removes the line.
4. A note with `confidential: personal` never appears in the index, search results or `CLAUDE.md` (fixture per template).
5. A file matching the secret pattern is never pushed; the sync log shows it skipped.
6. After a meeting note is written, the people and project notes it names link to it and the daily note gains one line, within one runner cycle.
7. Every runner change to `CLAUDE.md` appends a dated changelog entry; a hand revert survives the next run.
8. With no model source chosen the runner stays idle and Settings says why in one sentence; choosing one starts it on the next cycle.
9. No request from the app to Cloud carries an API key; a test asserts this on every sync payload and settings row.
10. "Maintain my existing vault" on a fixture vault adds `index.md` and the changelog section, changes no note body, and installs `.claude/` files only after confirmation.
11. Canceling Cloud leaves every file in place; Local opens the folder and the runner keeps working with the same model source.
12. `npm run check:edition` passes; every upsell string passes the writing-rules check in CI.

## Non-goals

- Hosted chat or hosted model access.
- Restructuring an existing vault; audience 2 gets maintenance only.
- A server-side runner, token passthrough and caps (later option).
- Windows or Linux clients; web editing; Teams (`team-knowledge.md`).

## Open questions

1. Changelog inside `CLAUDE.md` or in a sibling file?
2. After days with the app closed, does the runner process the backlog in one pass or in batches?

## Dependencies

- **Pull sync (rank 11).** Templates are stored on the server; without pull nothing reaches the Mac.
- **Model source (rank 4).** The runner reuses the model-source setting and the Keychain store.
- **Platform owner role.** Template rollout and version pinning.
- **Billing.** The $5 seat.

## Phased build order

1. **Templates and creation.** `template.json`, four templates including "Maintain my existing vault", pull to Mac, both upsell moments.
2. **Index and guards.** Runner on the Mac, guard rules, index maintenance, search index and local `search-memory.py`.
3. **Filing from meetings.** Links, daily lines, learned facts with changelog.
4. **Existing vault hardening.** Fixture vaults from Obsidian and repo layouts; conflict handling for hand edits.
5. **Later option, unscheduled.** Server-side runner with per-workspace encrypted keys, passthrough billing and caps.
