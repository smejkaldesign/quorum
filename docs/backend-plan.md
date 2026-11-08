# Backend plan: from local POC to hosted Quorum

Two editions share one codebase:

| Edition | Storage | Model calls | Who |
|---|---|---|---|
| Open source (local) | Markdown vault on disk, SQLite caches in app userData | User's own Claude Code sign-in or their own keys | Anyone who clones the repo |
| Hosted (Smejkal Design) | Same local files, plus a cloud store that syncs notes, meetings, chats and settings | Server-held keys behind an API, billed per seat | Eric first, then paying users |

The local edition stays the default and never requires an account. The hosted edition is a sync adapter on top of it, which is why everything below is phrased as a storage boundary and nothing as a rewrite.

## Storage boundary (do this first, local only)

Today `main.js` reads and writes files directly in about a dozen places (sessions, settings, chats, meeting notes, attachments, vault IPC). Step one is a `store/` module with a single interface the rest of the app calls:

- `notes`: list, read, write (atomic), rename, move, trash, watch
- `meetings`: create, append transcript segment, finalize, list
- `chats`: list, read, write
- `settings`: get, set
- `attachments`: stage, read, clear

`store/local.js` is the current file code moved behind that interface. No behavior change; this is the refactor that makes a second backend possible.

## Hosted backend (Supabase, same stack as Celune, Benefind and Smejkal Finance)

Proposed project codename `quorum`, namespace `mcp__supabase-quorum__*`, registered in `MyBrain/05-knowledge/supabase-projects.md` before creation per the vault rule.

Tables (all with `user_id`, `workspace_id`, `created_at`, `updated_at`, `deleted_at`; ULID primary keys so local-first ids survive sync):

- `workspaces`, `members`
- `notes` (path, frontmatter jsonb, body text, hash, mtime)
- `links` (from_note, to_note, anchor, unresolved) rebuilt server-side
- `meetings` (title, started_at, ended_at, participants jsonb, visibility)
- `transcript_segments` (meeting_id, channel, t, text) with a 180-day retention job
- `chats`, `chat_turns`
- `settings` (workspace level: stop and go words, opt-outs; user level: model, profile)
- `attachments` in Storage, metadata row in Postgres

Row level security on `user_id` or workspace membership for every table. Nothing is readable anonymously.

### Sync model

- Local SQLite is the write-ahead log. Every local change gets a row in `outbox`; a background worker pushes it and pulls remote changes by `updated_at` cursor.
- Conflicts on `notes.body`: last writer wins at the block level using the same hash-and-mtime check the editor already does, and the losing version is kept as a snapshot.
- Audio never syncs. Transcript segments sync only when the meeting's visibility is not `private`, which keeps the local-only promise for private calls.

### Model calls in the hosted edition

Local edition keeps spawning `claude` (Claude Code sign-in). Hosted edition adds `store/remote.js` calling an edge function `ask` that holds the Anthropic key, meters tokens per workspace, and streams back. The UI already treats the model list as data (`Composer.tsx` `MODELS`), so OpenAI and Gemini entries flip from `live: false` to `live: true` once the edge function supports them.

### Auth and billing

- Supabase Auth with magic link and Google.
- Stripe (Smejkal Design account) with one plan per seat per month; webhook writes `workspaces.plan` and `seats`.
- Free tier equals the local edition. Paid adds sync, web access to notes and meetings, and hosted model calls.

## Sequence

1. Storage boundary refactor (local only, no new deps). Verify: app behaves identically, `tsc` and `vite build` pass, a meeting saves and reopens.
2. Register the Supabase project in the vault registry, create it, apply the schema as migrations in `supabase/migrations/`.
3. `store/remote.js` with push-only sync for `notes` and `meetings`. Verify: a note edited locally appears in the table within 10 s.
4. Pull sync and conflict snapshots. Verify: edit the same note in two installs.
5. `ask` edge function and hosted model calls. Verify: a question answered with no `claude` binary on the machine.
6. Auth, Stripe, web viewer.

Step 1 is safe to start now. Step 2 waits for Eric's confirmation because it creates billable infrastructure.
