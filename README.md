# Quorum

Local meeting notetaker and second-brain app for the Mac, with an in-app assistant also called Quorum. Local proof of concept today; the hosted version comes next (see `docs/backend-plan.md`).

- Records your mic and the Mac's system audio as two separate tracks, transcribed on-device (Apple SpeechAnalyzer). Audio never leaves the Mac.
- Meeting providers: Zoom, Google Meet (in the browser) and Microsoft Teams. On Zoom, Quorum posts a notice in the chat when it starts and anyone can reply `STOP` to turn it off and delete the call, or `GO` to turn it back on. Meet and Teams show the notice on screen for now (plans in `docs/plans/`).
- Questions to Quorum and the end-of-meeting summary run through the signed-in Claude Code on this Mac (your claude.ai login), never a raw API key.
- The Knowledge view opens, edits, links, searches and graphs an Obsidian-style markdown vault. Files stay plain markdown, so Claude Code keeps working on the same folder.
- Session data lives in `~/Library/Application Support/Quorum/sessions/`. Settings in `~/Library/Application Support/Quorum/settings.json`.

## Agent OS connection

On first launch Quorum looks for `~/Documents/GitHub/second-brain/MyBrain`. If it finds it, the repo root (the folder with `CLAUDE.md`) becomes the brain root and `MyBrain/` the vault. Any other folder can be chosen in Settings.

What Quorum uses from the Agent OS, found by file name only:

| Marker | Path | Used for |
|---|---|---|
| Agent OS | `CLAUDE.md` | Claude Code runs inside this root, so its conventions apply |
| Vault | `MyBrain/.obsidian` | Knowledge view, graph, wikilinks |
| Memory index | `MyBrain/index.md` | Starting point for the agent |
| Search | `MyBrain/scripts/search-memory.py` | Hints before the agent runs, suggestion lookups during a call |
| Meeting notes | `MyBrain/08-meetings/quorum/` | Where saved meetings land (`source: quorum` in frontmatter) |

Built in, with no dependency on the connected Agent OS: a read guard on every file the agent opens (`app/guards/read-guard.py`: secrets, `confidential:` frontmatter, private folders) and decision checks on a System One model (OpenAI decisions or TypeSafe Jev, connected in Settings). Optional markers it also recognizes when present: `.claude/hooks/secret-file-guard.py`, `opted-out-guard.py`, `output-secret-tripwire.py` (extra read guards) and `scripts/embed-bench/excluded.txt` (opt-out redaction). See `docs/parity-gaps.md`.

## Run

```sh
cd helper && swift build
cd ../app && npm install && npm start
```

`npm start` builds the renderer with Vite and launches a dev copy of Electron named "Quorum Dev" (green icon, so it is never mistaken for the installed app). The terminal app you launch from needs Microphone, Screen and System Audio Recording, Calendar, and Accessibility in System Settings, Privacy and Security.

Other scripts: `npm run typecheck`, `npm run build`, `npm run package` (release build and DMG, signs with a local "Quorum Local Signing" certificate; create one in Keychain Access first).

## Layout

- `helper/`: Swift CLI (`QuorumHelper`). Audio capture (Core Audio process tap and mic), on-device transcription, Zoom chat via Accessibility, calendar read. Talks JSON lines over stdin and stdout.
- `app/`: Electron main process (`main.js`: capture lifecycle, STOP and GO handling, Claude calls, vault IPC) and the React window (`src/`). `vault.js`, `vindex.js`, `linkparse.js`, `relink.js` are the vault index, link parser and link-safe rename. `store/` is the storage boundary: `local.js` (files, the default) and `remote.js` (Supabase, used only when `QUORUM_SUPABASE_URL` and `QUORUM_SUPABASE_ANON_KEY` are set and `sync` is on in settings).
- `supabase/`: local Supabase project (`supabase start`) and `migrations/0001_init.sql`, the hosted schema with row level security.
- `app/cli/quorum.mjs`: CLI and read-only MCP server (`claude mcp add quorum`) over the app's notes, chats and live transcript.
- `app/assets/`: the Quorum owl (`quorum-filled.svg` bare, `quorum-outlined.svg` inside its disc) and the Swift scripts that render the app icon, tray images, avatar mark and DMG background from them.
- `docs/`: `backend-plan.md` (hosted version), `parity-gaps.md` (status and open items), `plans/google-meet.md` and `plans/microsoft-teams.md`.

Helper debug commands: `QuorumHelper dump-zoom [--open-chat]`, `test-capture <sec>`, `chat-read`, `chat-send <text>`.

## Theme

Dark shell with one accent, `--brand: #007aff`. All accent tints derive from it in `app/src/styles.css`; the graph accent is `#5ea9ff` in `Graph.tsx`.

## Editions and license

Quorum ships in two editions from one repo (`docs/open-source-strategy.md`). The Local edition is the default build: no account, no server, everything stays on the Mac. The Cloud edition adds sign-in, workspace sync and members; its client code lives in `app/ee/` and loads only when `QUORUM_EDITION=cloud` is set (`npm run build:cloud`, `npm run package:cloud`). `npm run check:edition` fails the build if anything outside `app/ee/` imports it or if the local renderer bundle contains it.

Everything outside `app/ee/` is Apache-2.0 (`LICENSE`, `NOTICE`). `app/ee/` is source available under the Quorum Enterprise License (`app/ee/LICENSE`): use it with a Quorum Cloud subscription.
