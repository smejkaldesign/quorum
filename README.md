# Quorum

Quorum is a meeting notetaker for the Mac. It records your mic and the Mac's system audio as two tracks, transcribes them on-device, and writes the notes into your Agent OS: a folder of plain markdown that Claude Code already reads. Questions during and after a meeting run through Claude Code on your Mac. Audio never leaves the machine.

## Editions

| | Local | Cloud |
|---|---|---|
| License | Apache-2.0, free | Paid, one plan |
| Capture, on-device transcription, Zoom, Google Meet and Microsoft Teams detection, STOP and GO chat notice, end-of-call notes | Yes | Yes |
| Agent OS: connect a notes folder, knowledge graph, search, read guard | Yes | Yes |
| Model access | Your Claude Code sign-in or your own API key | Same |
| Account, workspaces, members, sync | No | Yes |

Full table and reasoning: `docs/open-source-strategy.md`.

## Prerequisites

- macOS 26 on Apple silicon
- Node 22 or newer
- Python 3
- Claude Code installed and signed in
- Xcode command line tools, for building the helper

## Quickstart

```sh
git clone https://github.com/smejkaldesign/quorum.git && cd quorum
cd helper && swift build -c release
cd ../app && npm ci && npm run start
```

`npm run start` builds the renderer and launches a development copy named "Quorum Dev" (green icon). The terminal you launch from needs Microphone, Screen and System Audio Recording, Calendar, and Accessibility in System Settings, Privacy and Security.

## Launch commands

- `npm run start`: Local edition. No account, no server.
- `npm run start:cloud`: Cloud edition against your own Supabase project. Setup in `docs/self-hosting.md`.

Other scripts: `npm run typecheck`, `npm run build`, `npm run check:edition`, `npm run package`, `npm run package:cloud`.

## Model access

Quorum uses your own Claude Code sign-in on this Mac, or an API key you add in Settings (kept in Keychain). Nothing is bundled, and nothing works until you pick one.

## Where notes live

On first launch Quorum creates `~/Documents/Quorum` with starter files, or connects a folder you already have (an Obsidian vault or a repo with a `CLAUDE.md`). Meeting notes land in `08-meetings/quorum/` inside that folder with `source: quorum` in the frontmatter. Session data lives in `~/Library/Application Support/Quorum/sessions/` and settings in `~/Library/Application Support/Quorum/settings.json`.

Markers Quorum looks for in the connected folder, by file name only: `CLAUDE.md` (agent root), `.obsidian` (vault), `index.md` (memory index), `scripts/search-memory.py` (search). A read guard ships with the app and denies the agent secret-looking files, notes with `confidential:` in the frontmatter, and private folders.

## Layout

- `helper/`: Swift CLI (`QuorumHelper`). Audio capture, on-device transcription, Zoom chat via Accessibility, calendar read. JSON lines over stdin and stdout.
- `app/`: Electron main process (`main.js`), React window (`src/`), vault index and link tools (`vault.js`, `vindex.js`, `linkparse.js`, `relink.js`), storage boundary (`store/`), read guard (`guards/`), CLI and read-only MCP server (`cli/quorum.mjs`, `claude mcp add quorum`).
- `app/ee/`: Cloud-only client code (account, sync, members).
- `supabase/`: migrations for the Cloud schema and a local Supabase project.
- `docs/`: `open-source-strategy.md`, `self-hosting.md`, `parity-gaps.md`, `plans/`.

## Editions and license

Quorum ships in two editions from one repo (`docs/open-source-strategy.md`). The Local edition is the default build: no account, no server, everything stays on the Mac. The Cloud edition adds sign-in, workspace sync and members; its client code lives in `app/ee/` and loads only when `QUORUM_EDITION=cloud` is set (`npm run build:cloud`, `npm run package:cloud`). `npm run check:edition` fails the build if anything outside `app/ee/` imports it or if the local renderer bundle contains it.

Everything outside `app/ee/` is Apache-2.0 (`LICENSE`, `NOTICE`). `app/ee/` is source available under the Quorum Enterprise License (`app/ee/LICENSE`): use it with a Quorum Cloud subscription.

## More

- `docs/self-hosting.md`: run the Cloud edition on your own Supabase project
- `docs/open-source-strategy.md`: editions, license split, decisions
- `CONTRIBUTING.md`: setup, checks, CLA, commit style
- `SECURITY.md`: how to report a vulnerability
- `LICENSE`, `app/ee/LICENSE`
