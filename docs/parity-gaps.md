# Parity gaps: this Mac versus the reference setup

Status on 2026-11-08, after the first port. The reference ran against a different Agent OS, so some features here find nothing to use. Each item says what is missing, what the app does meanwhile, and what closes it.

## Works now

- Build chain: `swift build`, `npm install`, `tsc --noEmit`, `vite build` all pass. Dev app launches as "Quorum Dev", indexes the vault (1,625 notes in about 400 ms), helper reports ready and Accessibility trusted.
- Brain detection: finds `~/Documents/GitHub/second-brain` (CLAUDE.md) and `MyBrain/` (.obsidian, index.md, search-memory.py).
- Claude Code sign-in is the personal claude.ai account, so agent questions and summaries run without any API key.
- Search hints and in-call suggestions call `search-memory.py --mode keyword` and parse its `N. [path:lines]` output. The reference script took `--keyword --cite --expand-graph`; this one does not, so the call sites and `parseHits` were rewritten.

## Now native (no longer depend on the connected Agent OS)

- **Power-ups.** Settings › Memory › Power-ups lists what the scan found in the connected Agent OS: memory index, search, link graph, guard hooks, agent instructions, skills, agents and MCP servers. Index, search, graph and folders feed the agent today; instructions, skills, agents and MCP servers are listed and will become runnable later.

- **Read guard.** `app/guards/read-guard.py` ships with the app and runs on every Read, Grep and Glob the agent makes: secret-looking files, notes with `confidential:` in frontmatter, and private folders (the user's `privateDirs` setting, else any folder named personal or private) are denied. Guard hooks found in the connected Agent OS still run in addition.
- **Decision checks.** `app/decisions.js` is a provider abstraction over System One models: OpenAI decisions and TypeSafe Jev. Connect either in Settings › Workspace › Connections; the key stays in Keychain. Quick checks run whenever a provider is connected.

## Missing in this vault (optional features, app degrades quietly)

| Feature | Reference file | Here | Effect | Fix |
|---|---|---|---|---|
| Opt-out redaction list | `MyBrain/scripts/embed-bench/excluded.txt` | Absent | No term redaction in transcripts or suggestions | Decide whether a personal exclusion list is needed; if so create the file (one term per line) |
| Link graph expansion | `scripts/graph_links.py` | Absent | Hints are keyword-only | `search-memory.py --related` is wired in when the graph marker exists; add a `graph_links.py` shim or drop the marker |
| Semantic search | `MyBrain/memory/vectors.sqlite` | Absent (hybrid mode here uses Voyage through `brain.sqlite`) | Settings labels search as "Keyword search" | Fine as is; relabel later if hybrid is preferred |
| Meeting notes folder | `MyBrain/08-meetings/` | Created empty, `quorum/` subfolder | Saved notes land in `08-meetings/quorum/`; Granola import target is `08-meetings/granola/` | Run a Granola export into `08-meetings/granola/` when wanted |

## Changed from the reference on purpose

- Names: Herd → Quorum (app), Ilma → Quorum (assistant), `HerdHelper` → `QuorumHelper`, `herd://` → `quorum://`, env vars `HERD_*` → `QUORUM_*`, Keychain account `vanta` → `quorum`, bundle id `com.vanta.herd` → `design.smejkal.quorum`.
- Theme: brand purple `#8c3dff` → blue `#3d7bff`, with every derived tint remapped. App icon regenerated in blue from the same llama glyph (placeholder art).
- Removed: `docs/plans/` from the reference (employer-internal content). Replaced by `backend-plan.md` and the vault project page `04-projects/quorum.md`.
- Removed: `package-lock.json` download URLs that pointed at a corporate npm proxy; rewritten to registry.npmjs.org.
- Fresh git history. The reference history belonged to another org.

## Needs Eric

1. System permissions on first real use: Microphone, Screen and System Audio Recording, Calendar, Accessibility for Terminal (dev) and later for Quorum.app.
2. A "Quorum Local Signing" code-signing certificate in Keychain Access before `npm run package`, so macOS keeps permission grants across rebuilds.
3. Google Meet: detection and the STOP and GO chat notice are verified live (see `docs/plans/google-meet.md`, Status). Replies are read only while the Meet tab is the active tab. Microsoft Teams: wired (detect, capture) but untested, no chat notice yet; plan in `docs/plans/microsoft-teams.md`.
4. Hosted backend: Supabase project `frlpvwagtcgbnqzykqbq` ("Quorum Prod", us-east-1, free plan) exists and `0001_init` is applied (10 tables, RLS, 40 policies). `QUORUM_SUPABASE_URL` and the publishable key sit in the gitignored `.env`. Writes are denied until Supabase Auth gives the app a session, which is the next backend step (`docs/backend-plan.md`, step 3).
5. Final Quorum mark to replace `llama-glyph.svg`; the icon scripts regenerate everything from one SVG.
