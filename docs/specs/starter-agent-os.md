# Starter Agent OS

Status: draft for review. Project: Quorum: Open-Source Local Edition + Cloud Foundation, rank 12.

## Problem

Quorum writes meeting notes into an Agent OS: a folder of plain markdown with an index, instructions, guard hooks, skills and a search layer that Claude Code reads. Users who have none get the local starter folder from `app/onboarding.js`: README, `index.md`, `CLAUDE.md`, inbox, daily and meetings folders. Nothing maintains it: the index stops matching the notes within a week, `CLAUDE.md` never learns what the user works on, and there is no search layer.

Default model memory in a chat product holds a few hundred facts with no structure, no guard rules and no second tool that can read it. An Agent OS holds thousands of notes, states how an agent uses them, blocks what it may never read, and serves several tools at once. Tending one by hand takes weeks. A service that does it needs a server, so it is paid; Local stays free and complete (`docs/open-source-strategy.md`).

## Who it is for

1. **No Agent OS yet.** A person who downloads Quorum for meetings, reaches "connect a folder", and has nothing to connect.
2. **Owns an Agent OS already.** A person with a working vault who wants index, instructions and search kept current from meetings, and the folder reachable from every Mac and a browser. The service runs against the existing layout with no template.

## What the hosted service does

1. **Creates the folder** from a chosen template inside the user's workspace and pulls it to the Mac through sync. Default local path `~/Documents/Quorum`.
2. **Maintains `index.md`.** After every synced change: one line per note, grouped by folder, stale lines removed. Past a size the agent can read in one pass, it splits by folder under a top-level index.
3. **Maintains `CLAUDE.md`.** Layout, rules, and a short section of facts learned from meetings (people, projects, decisions). Every change lands in a dated `## Changelog` entry the user can see and revert.
4. **Runs the guard rules server-side.** The rules from `app/guards/read-guard.py` (secret-looking file names, private folders, `confidential:` frontmatter) decide what enters the index, the search layer and the learned facts.
5. **Keeps a search layer.** A full-text index over synced notes, exposed on the Mac as the `scripts/search-memory.py` that `scanBrain` in `app/main.js` already runs. The script answers from a local copy of the index kept current by sync, so a query never leaves the Mac.
6. **Ships skills and guards.** Guard hooks in `.claude/hooks/`, a `.claude/skills/` set for the template's audience, and `.claude/settings.json` wiring them, updated with the template version.
7. **Files meetings.** When a meeting note syncs: an index line, links from the people and project notes it names, a daily note line, updated learned facts. The meeting note body is never rewritten.

## What runs where

| On the Mac | Hosted |
|---|---|
| Capture, transcription, note writing, audio | Template rendering, folder creation |
| Claude Code, CLI and MCP server reads; read guard hooks | Index, instructions, links, learned facts; guard rules before indexing |
| Search script over the synced local index; sync client | Search index build; sync store (Supabase) |
## Model path for the hosted runner

Filing needs a model call. Two paths:

1. **The user's own key (v1).** Added in Settings, encrypted at rest in the workspace settings row, used only by that workspace's runner. Smejkal Design pays nothing for model calls. This matches the strategy decision that Cloud ships bring-your-own-key only.
2. **The company key with per-workspace metering (later).** Every call is metered to the workspace. Each seat includes a monthly token allowance; at the allowance the runner stops until the next month or until the user adds a key, and Settings says so. The allowance keeps model cost per seat under a fixed share of the $5 price; the platform owner reads usage and changes it without a release.

Cost boundary: $5 per seat per month covers hosting, storage and sync. Model cost is the user's on path 1 and capped per seat on path 2. No path lets a workspace incur an unbounded model bill for Smejkal Design.

## Upsell moments and copy constraints

1. **Connect a folder (onboarding).** When the user has nothing to connect, the step shows two equal choices: "Create a free folder on this Mac" first, then "Have Quorum build and maintain one ($5 per seat per month)".
2. **Settings.** The Memory page with no folder connected, and the Knowledge page, show one row with the same sentences and a Start button; for audience 2 it reads "Keep this folder maintained and reach it from every device".

Copy constraints: plain sentences stating what the service does, what it costs, that the free folder stays available, what leaves the Mac (notes, with sync on) and what never does (audio, confidential notes, private folders). No countdowns, discount framing or named competitors; Local is never described as limited. The repository writing rules apply.

## Privacy rules

1. Nothing leaves the Mac until sync is on. Starting the service turns sync on after a confirmation that lists what will be pushed.
2. `confidential:` frontmatter, private folders, hidden paths and secret-looking file names never sync and are never indexed (the rules in `app/ee/sync.js` today).
3. Audio never leaves the Mac. Transcript segments of private meetings never sync (`0001_init.sql`).
4. The runner reads only its own workspace and writes only `index.md`, `CLAUDE.md`, link sections, daily notes and files under `.claude/`.
5. Each of the seven behaviors has its own toggle in Settings. The privacy page states what the runner reads and which provider receives it, per path.

## Templates to ship first

1. **Personal.** `00-inbox/`, `01-daily/`, `02-people/`, `03-projects/`, `05-knowledge/`, `08-meetings/`. Skills: file an inbox note, weekly review.
2. **Founder.** Adds `04-company/`, `06-customers/` and a `decisions/` log (Context, Options, Choice, Outcome). Skills: decision entry, customer note from a meeting, weekly metrics. Guards add `confidential: finance`.
3. **Team lead.** Adds one note per report in `02-people/`, `07-one-on-ones/`, project status lines. Skills: one-on-one prep from the last three meetings with that person, project roll-up. Guards add `confidential: people` for report notes.

Each template is `supabase/templates/<name>/template.json` (version, folders, files, skills, guards) plus its files; adding one needs no code change.

## Acceptance criteria

1. A new user with no folder sees both choices at "connect a folder", free first; the free choice creates the local starter folder with no account.
2. Choosing the service, signing in and picking a template pulls the folder to the chosen path within 60 seconds; `scanBrain` detects index, instructions, guards, skills and search.
3. Adding a local note yields a matching `index.md` line within one sync cycle (under 5 minutes); deleting it removes the line.
4. A note with `confidential: personal` never appears in the index, search results or `CLAUDE.md` (fixture per template).
5. A file matching the secret pattern is never pushed; the sync log shows it skipped.
6. After a meeting note syncs, the people and project notes it names link to it and the daily note gains one line, within one sync cycle.
7. Every runner change to `CLAUDE.md` appends a dated changelog entry; a hand revert survives the next run.
8. With no key on path 1 the runner stays idle and Settings says why in one sentence; adding a key starts it on the next cycle.
9. On path 2 a workspace at its allowance stops filing; Settings and the platform owner view show allowance, usage and reset date.
10. Canceling Cloud leaves every file in place; Local opens the folder and the search script answers from the last synced index.
11. `npm run check:edition` passes; every upsell string passes the writing-rules check in CI.

## Non-goals

- Hosted chat or hosted model access for questions.
- Restructuring an existing vault; audience 2 gets maintenance only.
- Windows or Linux clients; web editing; a Team tier (`team-knowledge.md`).

## Open questions

1. Monthly token allowance per seat on path 2, and the share of the $5 it may use.
2. Key storage on path 1: encrypted server-side, or a short-lived token from the Mac each cycle?
3. Is audience 2 in v1, or does v1 ship template-only until filing quality is proven?
4. Changelog inside `CLAUDE.md` or in a sibling file?
5. Default provider for path 2?

## Dependencies

- **Pull sync (rank 11).** The service writes on the server; without pull nothing reaches the Mac.
- **Platform owner role.** Metering, allowance changes and template rollout need the `platform_owner` account.
- **Billing.** The $5 seat. The key storage decision blocks path 1.

## Phased build order

1. **Templates and creation.** `template.json`, three templates, pull to Mac, both upsell moments.
2. **Index and guards.** Server-side guard rules, index maintenance, search index and local `search-memory.py`.
3. **Filing from meetings.** Links, daily lines, learned facts with changelog. Path 1 only.
4. **Existing vault mode.** Audience 2.
5. **Metered company key.** Path 2, allowance, platform owner usage view.
