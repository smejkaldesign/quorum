# Parity gaps: this Mac versus the reference setup

Status on 2026-11-08, after the first port. The reference ran against a different second brain, so some features here find nothing to use. Each item says what is missing, what the app does meanwhile, and what closes it.

## Works now

- Build chain: `swift build`, `npm install`, `tsc --noEmit`, `vite build` all pass. Dev app launches as "Quorum Dev", indexes the vault (1,625 notes in about 400 ms), helper reports ready and Accessibility trusted.
- Brain detection: finds `~/Documents/GitHub/second-brain` (CLAUDE.md) and `MyBrain/` (.obsidian, index.md, search-memory.py).
- Claude Code sign-in is the personal claude.ai account, so agent questions and summaries run without any API key.
- Search hints and in-call suggestions call `search-memory.py --mode keyword` and parse its `N. [path:lines]` output. The reference script took `--keyword --cite --expand-graph`; this one does not, so the call sites and `parseHits` were rewritten.

## Missing in this vault (optional features, app degrades quietly)

| Feature | Reference file | Here | Effect | Fix |
|---|---|---|---|---|
| Read guards on the agent | `.claude/hooks/secret-file-guard.py`, `opted-out-guard.py`, `output-secret-tripwire.py` | Only `secret-guard.py` (a Bash guard, different hook shape) | Agent reads run with no file-level guard; Settings shows no "Guard hooks" item | Write a Read/Grep/Glob PreToolUse guard that denies `.env`, `*.pem`, `02-personal/` and `confidential:` files; add `output-secret-tripwire.py` PostToolUse |
| Opt-out redaction list | `MyBrain/scripts/embed-bench/excluded.txt` | Absent | No term redaction in transcripts or suggestions | Decide whether a personal exclusion list is needed; if so create the file (one term per line) |
| Decision checks (fast yes/no) | `scripts/openai_decisions.py` + OpenAI key in Keychain | Absent | STOP detection falls back to the regex only; suggestion gate skipped | Add the script and key in Settings › Workspace, or leave off |
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
3. Zoom is the only chat integration (STOP and GO). Google Meet and Teams capture audio fine but have no chat notice. Say which platforms matter.
4. Hosted backend choice (see `backend-plan.md`): a new Supabase project under Smejkal Design is the default; confirm before anything is created.
5. Final Quorum mark to replace `llama-glyph.svg`; the icon scripts regenerate everything from one SVG.
