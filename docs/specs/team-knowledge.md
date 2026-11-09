# Team knowledge

Status: decisions folded in 2026-11-08, ready for build planning. Project: Quorum: Open-Source Local Edition + Cloud Foundation, rank 13.

## Problem

Every Quorum user keeps a personal Agent OS on their own Mac. When three people on one team hold notes on the same customer, nothing connects them, and a new hire starts from an empty folder. The schema already has workspaces, owner, admin and member roles, invites, domain join and a public or private flag on meetings (`supabase/migrations/0001` to `0003`). The app shows a Visibility pill and a disabled Copy link (`app/src/MeetingNote.tsx`), and the Knowledge page has a Team vault row labelled Soon. This spec defines the product those pieces form. Team knowledge is the third thing Cloud sells (`docs/open-source-strategy.md`) and the reason an existing Agent OS owner pays for Cloud.

## Audiences

1. **Existing Agent OS owners.** They keep their personal vault, mark some notes public, and let teammates' agents read them. Confidential notes never move.
2. **New Cloud workspaces.** A team that signs up together, often with a company email domain. They want one shared folder every member's Quorum reads, an admin deciding what counts as company knowledge, and Teams.

## The model

**Three kinds of vault per member.** The personal vault stays where it is. The workspace vault (company knowledge) is a second folder on each Mac, pulled by sync, read-only except through the contribution flow. Each Team the member belongs to is a third folder, writable by its teammates. Default paths `~/Documents/Quorum Team/<workspace>/` and `.../teams/<team>/`. Quorum and the read guard cover all of them.

**Visibility per note (decided).** Every note and meeting carries `visibility: private` (default) or `visibility: public` in frontmatter, matching `meetings.visibility`. Private means the owner only. Public means visible to workspace members only, through the workspace vault, its link in the app, and the web viewer behind sign-in. Anyone-with-the-link sharing is deferred; v1 adds no anonymous path.

**Roles (official).** Owner, admin and member, as in `0002_accounts.sql`. Owner: billing, remove members, delete workspace, plus every admin ability. Admin: invite and revoke, configure workspace settings, create and configure Teams, work the review queue. Member: read the workspace vault, contribute from their own notes and meetings, read and write in their Teams. A workspace keeps at least one owner.

**Billing (decided).** $9 per seat per month for every member of a workspace, Teams included.

**Invites and domain join.** Admins invite by email; an invite lasts 14 days and refreshes when re-sent. With domain join on, anyone with the workspace's email domain joins as a member. Public mail domains (`public_mail_domains`) can never be a workspace domain, and the app says why.

**Contributions and the admin queue (decided).** A member marks a note public. The workspace setting `auto_include` decides what happens next:

- On: the note enters the workspace vault and shared index at once.
- Off (default): the note waits in the admin queue with its title, folder and guard result. An admin includes or declines it; a declined note stays readable at its owner's link.

Included notes carry `included_by` and `included_at`. Turning `auto_include` on includes nothing retroactively.

**Teams (decided).** An admin creates a Team inside the workspace and adds members. A Team has its own knowledge segment, separate from company knowledge: a Team note enters the workspace vault only through the contribution flow.

- **Shared meeting folders.** When several teammates attend one meeting (matched by calendar event, or by title and start time within 10 minutes), each note lands in `teams/<team>/meetings/<date> <title>/`, one file per author. Topic folders work the same way.
- **Synthesized Team note.** Once every attendee's note is in, or after a configurable wait (default 2 hours), Quorum writes one `Team note.md` in that folder: agreed facts, decisions, open items, and points only one author captured. Any teammate can read it, including one who missed the meeting. Synthesis runs on the Mac of the first teammate whose app is open after the trigger, with that user's model source, and syncs to the others.
- **Synthesis toggle.** An admin can disable synthesis per Team; notes still collect in the shared folder.
- **Team vault access.** Writable by the Team's members. The admin sets the vault `private` (teammates only) or `workspace` (readable by every member), and `read` or `write` per teammate; `write` is the default.

**Company knowledge source.** An admin can connect a repository, wiki export or folder as a read-only source under `sources/<name>/` in the workspace vault; review applies to the source as a whole.

## What the app shows

1. **Agent OS switcher.** Lists the personal vault, the workspace vault and each Team vault; "All" queries every one.
2. **Knowledge page.** Workspace vault row (path, note count, last sync); one row per Team; the admin queue with its count and the auto-include toggle (admins); knowledge source rows; a Members link.
3. **Team settings (admins).** Name, members with read or write, visibility, synthesis on or off, synthesis wait.
4. **Public note links.** Copy link is active on a public note; it opens in Quorum when installed, otherwise in the web viewer. A private note opened by someone else shows "This note is private".
5. **Web viewer.** A read-only quorum.watch page behind sign-in, with the API's visibility checks.
6. **Members page.** Gains the queue count, domain join status and Team membership.

## Privacy and guard rules

1. Nothing leaves the Mac without sync on. Turning on sharing turns on sync after a confirmation listing what will be pushed.
2. Confidential notes (`confidential:` frontmatter), private folders, hidden paths and secret-looking files never sync, so they never enter a shared vault. The Visibility pill is disabled on a confidential note with the reason.
3. Transcript segments of private meetings never sync (`0001_init.sql`); making a meeting public later pushes them only after the user confirms. The opt-out redaction list applies before any push.
4. Switching a note from public to private removes it from every workspace vault within one sync cycle and revokes its link.
5. A removed member loses the workspace vault and every Team vault at the next sync; the app deletes the local copies. Their notes stay in the workspace. A teammate removed from a Team or set to `read` has local writes stop syncing, and the app says so.
6. The read guard runs on every vault. The runner from `starter-agent-os.md` indexes only included notes and Team notes the member can read. Synthesis reads only notes already in the shared folder.

## Data model notes

New tables and columns implied by this spec, on top of `0001` to `0003`:

- `workspaces.auto_include boolean not null default false`.
- `teams` (`id`, `workspace_id`, `name`, `slug`, `visibility` enum `private | workspace`, `synthesis_enabled boolean default true`, `synthesis_wait_minutes int default 120`, `created_by`, `created_at`).
- `team_members` (`team_id`, `user_id`, `access` enum `read | write` default `write`, `added_by`, `added_at`); primary key `(team_id, user_id)`; `user_id` must be a workspace member.
- `contributions` (`id`, `workspace_id`, `note_id`, `author_id`, `status` enum `pending | included | declined`, `guard_result`, `reviewed_by`, `reviewed_at`, `created_at`); the `included` row supplies `included_by` and `included_at`.
- `team_notes` (`id`, `team_id`, `folder_path`, `status` enum `collecting | synthesized | disabled`, `synthesized_by`, `synthesized_at`, `source_note_ids`), one row per shared folder.
- `notes.team_id nullable`: `null` for the personal vault, set for a Team; workspace vault membership comes from `contributions`.
- Row level security: Team rows readable by team members, or by all members when `visibility = workspace`; writable with `access = write`. `teams`, `team_members` and `contributions` are admin-writable, except a member may insert their own `pending` contribution.

## Acceptance criteria

1. With auto-include off, a member marks a note public; it enters the admin queue; an admin includes it; it reaches a second member's workspace vault within one sync cycle (under 5 minutes).
2. With auto-include on, the same note arrives with no admin action and the queue stays empty.
3. A note with `confidential: personal` cannot be marked public: the pill is disabled with the reason, and a direct API attempt is rejected.
4. Copy link is enabled on public notes only; a signed-in non-member and a signed-out visitor both see "This note is private".
5. A gmail.com user creating a workspace gets no domain and domain join off, with the reason shown; a matching company domain with domain join on lets the user join.
6. Switching a note to private removes it from a second member's vault and makes its link show the private view within one sync cycle.
7. Removing a member removes every shared vault from their Mac at the next sync and keeps their included notes.
8. An admin creates a Team with two members; both see the Team folder within one sync cycle; a third member sees it, read-only, only after visibility is set to `workspace`.
9. A teammate set to `read` can open Team notes; a local edit does not sync and the app says why.
10. Two teammates write notes for one meeting; both land in one team folder; `Team note.md` appears within the synthesis wait on every teammate's Mac, including one who did not attend. With synthesis off, none is written.
11. Questions under "All" return hits from every vault, and the read guard denies the same fixture files in each.
12. A connected knowledge source appears under `sources/<name>/` on every Mac and in search; the web viewer renders a public note and refuses a private one.
13. A workspace with eight members across two Teams is invoiced eight seats.
14. `npm run check:edition` and the writing-rules check pass in CI.

## Non-goals

- Real-time collaborative editing, comments, web editing.
- Anyone-with-the-link pages (deferred).
- SSO, audit export, retention policies: candidates for a later Team tier line, read from the workspace `plan` column.
- Cross-workspace sharing; nested Teams.

## Decisions (2026-11-08)

Approved by Eric. Additions:

1. Team knowledge is connected to, but separate from, local knowledge. When a member pulls a team item into their vault, the note carries a provenance bond in frontmatter (team item id, version, workspace, pulled at) and shows where it came from and whether the team copy has moved on. Sync never overwrites a bonded local note silently; it marks it as behind.
2. A local edit to a bonded note offers "Push improvement", which becomes a contribution in the admin review queue with a diff against the team version. Later, per-type rules and settings decide which changes go straight through.
3. Sources are many: a git repository, a folder on the admin's Mac, and tool connectors starting with Headways. Build as many as are possible now, behind one source manifest shape.
4. A meeting note that names a teammate needs no consent for inclusion.
5. Conflicts between two writers: the first save lands; later saves go to review as contributions instead of conflict copies.

## Open questions

1. Does a meeting note that names a teammate need that teammate's consent before inclusion?
2. Which knowledge source ships first: git repository, exported wiki, or a folder on the admin's Mac?
3. Two `write` teammates edit one Team file between syncs: last write wins with a conflict copy, or a merge prompt?

## Dependencies

- **Pull sync (rank 11).** Shared vaults exist only through pull.
- **Model source (rank 4).** Synthesis uses a teammate's model source.
- **Platform owner role, admin app, billing.** Plans, seats, invites, audit rows.

## Phased build order

1. **Public links.** Copy link and the web viewer for public notes.
2. **Workspace vault and contributions.** `contributions`, admin queue, `auto_include`, pull included notes; switcher and Knowledge page.
3. **Teams.** `teams`, `team_members`, Team folders with per-member access and visibility; Team settings page.
4. **Shared meeting folders and the Team note.** `team_notes`, attendance matching, synthesis on the Mac, per-Team toggle and wait.
5. **Domain join and invites in the Knowledge page.**
6. **Company knowledge source.** One source type, read-only, under `sources/`.
7. **Team tier instruments.** Seat counts and admin-control usage reported to the platform owner.
