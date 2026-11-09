# Quorum open-source and cloud strategy

Status: decided 2026-11-08 (price, tiers); other sections current as of that date. The pattern: Apache-2.0 core, `ee/` under its own license, bring your own key, one Cloud plan, one public repo.

## The rule that decides everything

The open-source edition costs Smejkal Design $0 to operate. Every feature in it runs on the user's Mac with the user's own accounts and keys. Anything that needs a server, a company key, or a company account is Cloud.

The open-source edition is the same app with the same features. It is never a crippled build. The difference is where things run: on your Mac with your keys (Local), or hosted by Smejkal Design (Cloud). Every model path in Local is bring your own key.

## What Cloud sells

1. **Starter Agent OS.** A service that builds and maintains an agentic memory system for someone who has none: a structured notes folder with index, instructions, guards, skills and a search layer, far beyond a default Claude memory, kept current from their meetings and connected to Claude or another AI tool. Cloud stores the templates, syncs the folder and makes it reachable from every device; that hosting is what is paid for. The runner that maintains the folder executes on the user's Mac inside the app, with the user's own model source. The app surfaces it as an upsell at the moment a user with no Agent OS reaches the "connect a folder" step, and again in Settings. A second path, "Maintain my existing vault", applies the same runner to a folder the user already has.
2. **Sync and web access.** Notes and meetings across Macs and in a browser.
3. **Team knowledge.** Shared workspace notes, members with owner, admin and member roles, invites, domain join, visibility rules, an admin review queue for member contributions with an auto-include toggle, and Teams inside a workspace with their own knowledge segment and a synthesized Team note per shared meeting. This is also the pitch to people who already run their own Agent OS: Cloud is what lets them share it with a team and reach it from every device.

**Tokens.** Cloud charges for hosting, ease of use and teams. Cloud never bills tokens in v1 and never makes a model call on the user's behalf; every model path, Local or Cloud, is the user's Claude Code sign-in, the user's own key in the Mac's Keychain, or a local model. Anthropic and OpenAI offer no third-party OAuth that hands an app a user's key, so "connect your AI account" means one of those three sources. No user key is stored server-side in v1. A server-side runner is a later option; if one ever runs on a company key, tokens bill straight through monthly at cost with a user-set cap (suggested $10 to $20 on top of the $5 seat), and keys are encrypted at rest with per-workspace keys.

## Editions

| | Local (open source) | Cloud (paid) | Team (later tier, same code path as Cloud) |
|---|---|---|---|
| Price | Free, Apache-2.0 | One paid plan for v1: $5 per seat per month | Not a tier in v1; Cloud gets team features first, the line moves when demand shows |
| Meetings: capture, on-device transcription, Zoom/Meet/Teams detection, STOP/GO chat notice, end-of-call notes | Yes | Yes | Yes |
| Agent OS: connect an existing notes folder (Obsidian vault, repo with CLAUDE.md), knowledge graph, search, read guard | Yes | Yes | Yes |
| Model access | User's own Claude Code sign-in; bring your own API key (Anthropic, OpenAI, local Ollama); default is none | Same; Cloud bills no tokens in v1 | Same |
| Tokens and model cost | $0 to Smejkal Design in every case | $0 to Smejkal Design in v1; a server-side runner with monthly passthrough billing and a user-set cap is a later option | Same as Cloud |
| Decision checks (System One models) | Bring your own key, off by default | Same | Same |
| Granola and other source-app imports | Yes, local folders | Yes | Yes |
| Quorum CLI and MCP server (local) | Yes | Yes | Yes |
| Account, sign-in | None | Email code, Google sign-in | Same |
| Sync notes and meetings to a workspace, web access | No | Yes | Yes |
| Starter Agent OS: templates, sync and every-device access for a notes folder Quorum creates or already maintains; the runner executes on the user's Mac with the user's model source | No | Yes | Yes |
| Team knowledge: shared workspace notes, owner/admin/member roles, invites, domain join, visibility public (workspace members) or private, admin review queue with auto-include toggle, Teams with segmented knowledge and a synthesized Team note | No | Yes, included for now; $5 per seat for every member, Teams included | Yes; moves to Team tier when seats and admin controls justify it |
| Auto-update | GitHub Releases feed, free | Same | Same |

## What leaves the open-source build

1. Company Supabase URL and anon key. The source build has no cloud config. The signed DMG that Smejkal Design distributes carries the Cloud config, so a user who downloads from quorum.watch can sign in; a user who builds from source gets the Local edition unless they point it at a server with `QUORUM_SUPABASE_URL` and `QUORUM_SUPABASE_ANON_KEY`.
2. Any company model key or hosted model call. Model access defaults to none. Settings shows three choices: Claude Code on this Mac, your own API key (Keychain), or a local model. Nothing works until the user picks one, and the app says so plainly.
3. Any URL on a company site other than quorum.watch. Placeholder links point at quorum.watch or at nothing.
4. Analytics, crash reporting, update checks that hit a company server. Updates come from GitHub Releases.

## License and repo layout

- One public repo `smejkaldesign/quorum`, Apache-2.0 at the root; copyright holder Smejkal Design (sole proprietorship). CLA enforced with the CLA Assistant GitHub app; SECURITY.md with a contact address. Permissive so a company can run it on every laptop without legal review. The hosted service is what is sold.
- `app/ee/` holds Cloud-only client code (account, sync, members, Starter Agent OS, team knowledge UI) under `ee/LICENSE` (source available, use only with a Quorum Cloud subscription). `supabase/` lives under the same terms.
- CI check: the Local build must not import from `app/ee/`. A `QUORUM_EDITION=local|cloud` build flag selects the entry points; the default is `local`.
- Secrets scan (gitleaks) and a founder-content guard (no personal paths, emails, customer names) run on every push.

## Why this split

- Local-first is the credible position in this category. Granola, Obsidian, MacWhisper and the open-source note takers all compete on "audio and notes stay on your machine". Quorum's distinct claim is the Agent OS: meetings land in the user's own markdown knowledge base that Claude Code already reads. That claim is strongest when the client is open and the data format is plain files.
- The things people pay for are the things that need a server: sync between machines, a web view, a team sharing a workspace, and a service that builds and tends the knowledge base for someone who will never set up a vault by hand. Those map directly to Cloud and stay out of the free edition without crippling it.
- BYOK keeps Cloud margins predictable (no model bills) and keeps Local at $0.

## Distribution

- Signed and notarized DMG on GitHub Releases, auto-update through the Releases feed.
- quorum.watch: landing page, download button, pricing table with two columns (Open source, Cloud) and a subdued Enterprise row.
- Supabase Auth site URL moves to quorum.watch.

## Decisions (2026-11-08)

1. One paid tier for v1. Team tier planned later; members and invites ship inside Cloud, watch seat counts.
2. Price: $5 per seat per month (revised from $9 the same day).
3. Dead Settings rows stay visible as a to-do map until the features ship.
4. Hosted model access in Cloud stays out of the first release. BYOK only; revisit when support load shows people stuck on keys.
5. Tokens: Cloud bills no tokens in v1. The Starter Agent OS runner executes on the user's Mac with the user's model source; no user key is stored server-side. A server-side runner with passthrough billing and a user-set cap ($10 to $20 suggested) is a later option.
6. Team knowledge: "public" means workspace members only; anyone-with-the-link is deferred. Roles are owner, admin, member. Admins hold a review queue with an auto-include toggle, create Teams with their own knowledge segment and a synthesized Team note (disable per Team), and set Team vault visibility and per-member read or write. Every member is a $5 seat, Teams included. "Maintain my existing vault" is in v1.

## Environments and administration

- Development runs against the local Supabase stack (`supabase start`) with the same migrations; production (`quorum`) is for the signed release. A second hosted project costs $10 a month on the Pro organization, so a hosted dev project is optional later, in a free organization. The dev build signs in against its own environment with its own account and session file; nothing is shared with production. Pointing a dev build at production needs an explicit switch in the developer section of Settings and shows a banner while it is on.
- Super admin: the platform owner account carries a `platform_owner` role in production, outside any workspace, with the ability to list workspaces and members, set plans by hand, and read audit rows.
- Admin app: a small web app at admin.quorum.watch, its own directory and UI, for the platform owner only: workspaces, plans, seats, invites, feature flags, environment banner. Phase 2 of the Cloud work, after sync.

## Accounts and documents, logged on the tasks that need them

Apple Developer Program (signing task), payment processor activation, Terms and Privacy pages and sales tax (billing task), Google OAuth consent screen and custom SMTP (Google sign-in task), support mailbox and a trademark search note (quorum.watch task). None of these are started until their task is.

## Related

- docs/parity-gaps.md, docs/self-hosting.md
