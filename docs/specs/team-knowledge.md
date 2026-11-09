# Team knowledge

Status: draft for review. Project: Quorum: Open-Source Local Edition + Cloud Foundation, rank 13.

## Problem

Every Quorum user keeps a personal Agent OS on their own Mac. When three people on one team hold notes on the same customer or project, nothing connects them. Meeting notes stay with the person who was in the call, and a new hire starts from an empty folder. The schema already has workspaces, members with owner, admin and member roles, invites, domain join and a public or private flag on meetings (`supabase/migrations/0001` to `0003`). The app shows a Visibility pill and a disabled Copy link (`app/src/MeetingNote.tsx`), and the Knowledge page is a zero state with a Team vault row labelled Soon. This spec defines the product those pieces form.

Team knowledge is the third thing Cloud sells (`docs/open-source-strategy.md`). It is also why an existing Agent OS owner pays for Cloud: team sharing and every-device access both need a server.

## Audiences

1. **Existing Agent OS owners.** They keep their personal vault as it is, mark some notes as shared, and have teammates' agents read them. Private, confidential and personal-folder notes must never move.
2. **New Cloud workspaces.** A team that signs up together, often with a company email domain. They want one shared folder that every member's Quorum reads, with an admin deciding what counts as company knowledge.

## The model

**Two vaults per member.** The personal vault stays where it is. The workspace vault is a second folder on each member's Mac, pulled by sync, read-only for members except through the review flow below. Default path `~/Documents/Quorum Team/<workspace name>`. Quorum reads both; the read guard runs on both.

**Visibility per note.** Every note and meeting carries `visibility: private` (default) or `visibility: public` in frontmatter, matching the `meetings.visibility` column. Private means the owner only. Public means every workspace member can open it, through the team vault, its link in the app, and the web viewer. Public never means anyone on the internet; see Open questions.

**Members and roles** come from `0002_accounts.sql` unchanged: owner (billing, remove members, delete workspace), admin (invite, revoke, review), member (read the team vault, propose notes). A workspace keeps at least one owner.

**Invites and domain join.** Admins invite by email; an invite lasts 14 days and refreshes when re-sent. A workspace with a company domain and domain join on lets anyone with that email domain join as a member. Public mail domains (`public_mail_domains`) can never be a workspace domain, and the app says why.

**Admin review.** A member marks a note public. It appears in the review queue with its title, folder and guard result. An admin includes it (team vault and shared index) or declines it (public at its owner's link only). The default is review; a workspace can set auto-include for chosen roles. Included notes carry `included_by` and `included_at`, one audit line per note.

**Company knowledge source.** An admin can also connect a repository, wiki export or folder as a read-only source; it syncs into `sources/<name>/` in the team vault and the shared index covers it. Review applies to the source as a whole.

## What the app shows

1. **Agent OS switcher.** The control that picks which folder Quorum reads lists the personal vault and each workspace vault. Questions run against the chosen one, or both under "All".
2. **Knowledge page.** Replaces the zero state with the team vault row (path, note count, last sync), the review queue (admins), company knowledge source rows, and a Members link.
3. **Public note links.** Copy link becomes active on a public note. The link opens in Quorum when installed and in the web viewer otherwise. A private note opened by someone else shows the existing "This note is private" view.
4. **Web viewer.** A read-only page at a quorum.watch address behind sign-in, rendering markdown and frontmatter with the API's visibility checks. Editing stays in the app.
5. **Members page.** Already in the Cloud app; gains the review queue count and domain join status.

## Where a Team tier line could sit later

Cloud includes all of the above for v1 at $5 per seat per month. The strategy doc keeps a Team tier open without committing to it. If demand shows, the line could sit at a seat count threshold, at admin controls (SSO, audit export, retention, forced review), or at more than one company knowledge source. The workspace `plan` column already exists and every admin control reads it, so moving the line later stays cheap.

## Privacy and guard rules

1. Nothing leaves the Mac without sync on. Turning on sharing turns on sync after a confirmation that lists what will be pushed.
2. Confidential notes (`confidential:` frontmatter), private folders, hidden paths and secret-looking files never sync, so they can never become public or enter a team vault. The Visibility pill is disabled on a confidential note with one sentence saying why.
3. Transcript segments of private meetings never sync (`0001_init.sql`); making a meeting public later pushes its segments only after the user confirms.
4. The opt-out redaction list applies before any text is pushed, as today.
5. Switching a note from public to private removes it from every member's team vault within one sync cycle and revokes its link.
6. A removed member loses the team vault at the next sync; the app deletes the local copy. Notes they authored stay in the workspace under their name.
7. The read guard runs on the team vault exactly as on the personal vault.
8. The runner from `starter-agent-os.md`, when a workspace uses it, indexes only included notes.

## Acceptance criteria

1. A member marks a note public; an admin includes it; it appears in the team vault on a second member's Mac within one sync cycle (under 5 minutes).
2. A note with `confidential: personal` cannot be marked public: the pill is disabled with the reason shown, and a direct API attempt is rejected by row level security or a trigger.
3. Copy link is enabled on public notes and disabled on private ones; the link opens in the app or the web viewer; a signed-in non-member sees "This note is private".
4. A user with a gmail.com address creating a workspace gets one with no domain and domain join off, with the reason shown.
5. A user whose company domain matches a workspace with domain join on sees it under domain matches and can join as a member.
6. Switching a note to private removes it from a second member's team vault and makes its link show the private view within one sync cycle.
7. Removing a member removes the team vault from their Mac at the next sync and keeps their included notes in the workspace.
8. Questions under "All" return hits from both vaults, and the read guard denies the same fixture files in the team vault as in the personal one.
9. A connected company knowledge source appears under `sources/<name>/` on every member's Mac and in search.
10. The web viewer renders a public note with the same markdown features as the app and refuses a private one.
11. `npm run check:edition` passes; all user-facing strings pass the writing-rules check in CI.

## Non-goals

- Real-time collaborative editing, comments, or editing in the web viewer.
- Anonymous public pages on the open internet (open question).
- SSO, audit export, retention policies (candidates for a later Team tier).
- Cross-workspace sharing; a note belongs to one workspace.

## Open questions

1. Should "public" ever mean anyone with the link, without sign-in? The schema has no anonymous path. Proposal: workspace-only in v1.
2. Review default: a review queue for every workspace, or auto-include for workspaces under five members?
3. Should the team vault be writable from the app, with the owner's copy as the source of truth, or read-only with edits proposed as new versions?
4. Does a meeting note that names a teammate need that teammate's consent before inclusion?
5. Which company knowledge source ships first: git repository, exported wiki, or a plain folder on the admin's Mac?

## Dependencies

- **Pull sync (rank 11).** The team vault exists only through pull.
- **Platform owner role.** Plan changes, seat counts and support access to audit rows.
- **Admin app.** Workspaces, plans, seats and invites for the platform owner.
- **Billing.** Seat counting for the $5 plan.

## Phased build order

1. **Public links.** Copy link and the web viewer for public notes within a workspace; uses the existing visibility column.
2. **Team vault.** Pull included notes into the second folder; switcher lists both vaults; Knowledge page shows the vault row.
3. **Review queue.** Admin include and decline, audit columns, Members page count.
4. **Domain join and invites in the Knowledge page.** Surface what `0002` and `0003` already support.
5. **Company knowledge source.** One source type, read-only, under `sources/`.
6. **Team tier instruments.** Seat counts and admin-control usage reported to the platform owner to inform the tier line.
