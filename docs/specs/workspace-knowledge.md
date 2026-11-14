# Workspace connectors and team knowledge bases

Status: decided by Eric, 2026-11-12. Extends `team-knowledge.md` and replaces its single "company knowledge source" (migration 0020) with knowledge bases.

## Problem

Quorum no longer takes its own meeting notes. Its value is the knowledge it combines from other tools and keeps current. Today the connectors page lists 48 entries, mixes local automatic detection (Zoom, Meet, Teams) with imports, and has no notion of a team approving a connector. Team knowledge has one source per workspace (sync, a folder, or a git repo), which cannot hold several bodies of knowledge or pull from Google Drive.

## Two connector modes

**Individual.** Every user, solo or on a team, has personal connectors. The page shows the full library of connectors Quorum supports. Connecting is a quick OAuth from the Mac (or an MCP sign-in, as Granola works today). Quorum registers one OAuth app per provider and both editions use it. Tokens stay in the Mac's Keychain. Content lands in the person's own Agent OS folder. No admin is involved.

**Workspace.** A team admin opens Admin > Workspace > Connectors and enables the connectors the organization approves. Enabling one means filling a configuration form: the organization's own OAuth client id and secret, or an API key, plus scope choices. The secret is stored in Supabase Vault, the same way 0006 stores provider keys. Once enabled, the connector appears in every member's list under "From your workspace", and each member runs their own OAuth to reach the content they already have access to. A workspace connector can also be used by a knowledge base admin to attach folders (below).

**Solo users.** A solo user is the owner of a one-person workspace. They never see the workspace form. They see the full library and connect directly. If they later invite a teammate, nothing they connected changes; the Workspace section appears for them as owner.

**On a team, what a member sees:** the individual library minus anything the admin turns off with a "Members may only use approved connectors" switch (on by default for teams). With the switch on, the list shows only workspace-enabled connectors.

### By edition

| | Free (local) | Cloud |
|---|---|---|
| Individual connectors from the Mac (Granola, Calendar, Agent OS folder, Claude Code) | Yes | Yes |
| Individual OAuth connectors (Google, Microsoft, Slack, Notion, Zoom) | Yes, through Quorum's registered apps; tokens stay on the Mac and sync runs on the Mac | Yes; tokens can also be held server-side for background sync |
| Workspace connectors, Admin > Workspace | No | Yes |
| Team knowledge bases | No | Yes |

The free edition keeps its $0 rule. Registering OAuth apps with providers is free. For providers whose token exchange needs a server-held secret (Notion, Slack), the relay performs a stateless code exchange: it swaps the code for tokens, returns them to the Mac and stores nothing. Self-hosters may replace Quorum's client ids with their own.

## The individual Connections page

The first four groups shipped in PR 18. A "From your workspace" group is added for team members once workspace connectors exist.

1. **Your notes**: the Agent OS folder. Connected or Choose folder.
2. **Calendar**: Apple Calendar or Google Calendar.
3. **Meeting notes**: Granola; Zoom cloud recordings with a Cloud badge.
4. **AI**: Claude Code, which powers answers. Required.
5. **From your workspace** (team members only): each enabled workspace connector with Connect for the member's own OAuth.
6. A "More coming" line that opens the full roadmap list.

Removed: Zoom, Google Meet and Teams as local entries (they only existed for call detection, now behind `meeting-capture`), the "Found in your Agent OS" automatic scan as a connector, and any connector that turns on without the person choosing it. Each row has one status: Connected, Not connected, or Needs attention.

## Team knowledge bases

**Structure.** The Knowledge tab holds a tree. Each top-level folder is one knowledge base (KB) with its own admins and readers. Inside, folders nest without limit, the same way Google Drive does.

**Filling a KB in the MVP.** A KB is created empty, from a GitHub repository URL, or from an uploaded zip. Quorum-hosted storage for KBs is a later Cloud option. Connector attachments come after the MVP.

**Sources inside a KB.** A KB folder can hold:
- Notes written in Quorum or contributed by members (today's review queue applies).
- **Attachments from a connector.** A KB admin picks a workspace connector (for example Google Drive), then a remote folder or individual files, and attaches them to a KB folder. Quorum syncs them as markdown with a source line on each note. Attaching a folder brings that folder only. Attaching a file brings that file only. Nothing else from the admin's account is attached.
- **Meeting notes.** A KB can be marked as a meetings KB for a team. Meeting notes from members' meeting-notes connectors (Granola today) are saved into it automatically, one folder per month. Each note has a "keep private" toggle that keeps it out of the team KB. Built in migration 0029 and `app/ee/meetingsKb.js`: a workspace has one team, so it has one meetings KB, made when the team switch turns on and readable by the whole workspace until an admin narrows it. A note recorded in Quorum (Record, Start listening, a call) is shared by default unless it is confidential or the person turned off "Save meeting notes to the team's meetings knowledge base" (Settings, Meetings). A meeting-notes connector account can hold another organization's meetings, so each source account (each Granola account, Zoom) is asked once per workspace whether to share; until the person answers, its notes stay private. The choice per source is editable on Settings, Meetings, with a one-time "Share past meeting notes from this source". Notes from before a default started are left as they were.

**Maintenance.** An attached file inherits agent maintenance: Quorum's maintenance runner can update links, summaries and the index for it. Changes made in the source tool keep flowing in on the next sync. Quorum never writes back to the source tool in v1; agent edits apply to Quorum's copy and are marked as such, and the next upstream change wins with the agent edit kept as a suggestion.

**Links between KBs.** Notes can link across KBs with ordinary wiki links. A KB's readers can follow a link only into KBs they can read; otherwise the link shows as restricted.

**Access.** Readers per KB: the whole workspace, chosen teams, or chosen people. A team's meetings KB defaults to that team only; its admin can grant read access to other teams so they can look up decisions.

**Use.** Quorum chat answers from every KB the asker can read, with sources cited (the Glean-style experience). The Quorum MCP server and CLI expose the same search and read tools to Claude Code and Codex, under the same permissions.

## Data model

- `workspace_integrations` (new; the 0006 `workspace_connectors` table stays for model provider keys): id, workspace_id, provider (google_drive, google_docs, notion, slack, ...), config jsonb (scopes, domain), secret_id into Vault, enabled, created_by, timestamps. RLS: members read the non-secret columns of enabled rows; owners and admins write through security definer RPCs; secrets never return to a client.
- `member_integrations`: user_id, integration_id, status, last_sync. The member's OAuth tokens for Cloud-side sync are stored in Vault and referenced here. RLS: the user sees their own rows.
- `knowledge_bases`: id, workspace_id, name, kind (general, meetings), team_id null, created_by. `kb_access`: kb_id, principal (workspace, team, user), role (admin, reader).
- `kb_folders`: id, kb_id, parent_id, name, position.
- `kb_attachments`: id, folder_id, integration_id, remote_id, remote_kind (folder, file), attached_by, last_synced_at, cursor.
- Notes gain `kb_id` and `folder_id` (nullable for personal notes). Note RLS becomes "can read the KB" for KB notes.

**Migration from 0020.** `workspaces.team_source` becomes the default KB: kind sync maps to a KB named after the workspace; folder and git sources stay as Mac-side sources attached to that KB. The 0020 RPC stays for one release and then is removed.

## Where sync runs

- **Individual connectors:** on the Mac, as Granola does today. Free edition and Cloud alike.
- **KB attachments:** on the relay, in a worker on Railway, using the organization's OAuth client and the attaching admin's grant. A KB must keep syncing when no member's Mac is open, so this runs server-side. The worker writes markdown notes into Supabase; members' Macs receive them through the existing pull sync.
- Cost to Eric: Railway CPU and Supabase storage, covered by the $8 seat. No model tokens: summaries and maintenance run on members' Macs with their own model source, as decided for v1.

## Google verification cost

Reading a person's whole Drive needs a restricted Google scope, which requires Google's verification and an annual paid CASA security assessment. Quorum avoids it: Google Drive uses the Google Picker with the `drive.file` scope, so a person picks individual files or folders and Quorum reads only those. `drive.file` is not a restricted scope and needs no CASA assessment. This is all the MVP needs. Google Calendar uses a sensitive scope that needs Google's free verification, which takes a few weeks. Organizations that want broader Drive access later can register their own internal OAuth client in a workspace connector.

## Phased plan

**MVP:**
1. Knowledge bases as custom folders (`knowledge_bases`, `kb_folders`, `kb_access`): each top-level folder is a KB with nested folders; create empty, from a GitHub repository URL, or from an uploaded zip.
2. Admin > Workspace > Knowledge to create KBs, manage folders and readers.
3. A meetings KB per team, filled automatically, with a per-note "keep private" toggle.
4. Migrate the 0020 team source into a default KB.
5. Chat and the Quorum MCP server and CLI answer from readable KBs.
6. Quorum-registered OAuth apps for personal connectors in both editions, with the relay's stateless code exchange.
7. Google Picker with `drive.file` to attach individual Drive files.
8. Submit Google Calendar for sensitive-scope verification.

--- MVP line ---

**Later:** workspace connectors with a configuration form and two identity modes per connector (org shared identity with an API key, accountable owner and custom scopes; personal, where each member authorizes their own account); "approved connectors only" on by default for teams; server-side token storage and relay sync workers for Cloud; connector folder sync into KBs; agent edits kept as suggestions on upstream change; Quorum-hosted KB storage; cross-team KB permissions; removal of the 0020 RPC one release after the migration.

## Decisions (Eric, 2026-11-12)

1. **KBs in the MVP** are custom folders only, filled from a GitHub repository URL or a zip. No connectors in the MVP. Quorum-hosted storage is a later Cloud option.
2. **Personal connectors** use Quorum-registered OAuth apps in both editions. Free users connect with one click; no user builds their own connector. Google Drive uses the Picker with `drive.file`.
3. **"Approved connectors only"** is on by default for teams.
4. **Meeting notes** save automatically into the team's meetings KB, with a per-note "keep private" toggle.
5. **Agent edits to synced files** change Quorum's copy only; an upstream change after that keeps the agent edit as a suggestion.
6. **The 0020 single team source** is migrated into a default KB and its RPC removed one release later.
