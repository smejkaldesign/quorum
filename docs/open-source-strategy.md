# Quorum open-source and cloud strategy

Status: decided 2026-11-08 (price, tiers); other sections current as of that date. Follows the pattern Celune settled in September 2026 (Apache-2.0 core, `ee/` under its own license, bring your own key, one Cloud plan, one public repo) so the studio runs two products on one playbook.

## The rule that decides everything

The open-source edition costs Smejkal Design $0 to operate. Every feature in it runs on the user's Mac with the user's own accounts and keys. Anything that needs a server, a company key, or a company account is Cloud.

The open-source edition is the same app with the same features. It is never a crippled build. The difference is where things run: on your Mac with your keys (Local), or hosted by Smejkal Design (Cloud). Every model path in Local is bring your own key.

## What Cloud sells

1. **Starter Agent OS.** A hosted service that builds and maintains an agentic memory system for someone who has none: a structured notes folder with index, instructions, guards, skills and a search layer, far beyond a default Claude memory, kept current from their meetings and connected to Claude or another AI tool. Needs hosting, so it is paid. The app surfaces it as an upsell at the moment a user with no Agent OS reaches the "connect a folder" step, and again in Settings.
2. **Sync and web access.** Notes and meetings across Macs and in a browser.
3. **Team knowledge.** Shared workspace notes, members, invites, domain join, visibility rules. This is also the pitch to people who already run their own second brain: Cloud is what lets them share it with a team and reach it from every device.

## Editions

| | Local (open source) | Cloud (paid) | Team (later tier, same code path as Cloud) |
|---|---|---|---|
| Price | Free, Apache-2.0 | One paid plan for v1: $5 per seat per month | Not a tier in v1; Cloud gets team features first, the line moves when demand shows |
| Meetings: capture, on-device transcription, Zoom/Meet/Teams detection, STOP/GO chat notice, end-of-call notes | Yes | Yes | Yes |
| Agent OS: connect an existing notes folder (Obsidian vault, repo with CLAUDE.md), knowledge graph, search, read guard | Yes | Yes | Yes |
| Model access | User's own Claude Code sign-in; bring your own API key (Anthropic, OpenAI, local Ollama); default is none | Same, plus hosted model access as a later option | Same |
| Decision checks (System One models) | Bring your own key, off by default | Same | Same |
| Granola and other source-app imports | Yes, local folders | Yes | Yes |
| Quorum CLI and MCP server (local) | Yes | Yes | Yes |
| Account, sign-in | None | Email code, Google sign-in | Same |
| Sync notes and meetings to a workspace, web access | No | Yes | Yes |
| Build my Agent OS: a hosted flow that creates and maintains a notes folder for someone who has none, connected to Claude or another tool | No | Yes | Yes |
| Team knowledge: shared workspace notes, members, invites, domain join, visibility public/private | No | Yes, included for now | Yes; moves to Team tier when seats and admin controls justify it |
| Auto-update | GitHub Releases feed, free | Same | Same |

## What leaves the open-source build

1. Company Supabase URL and anon key. The source build has no cloud config. The signed DMG that Smejkal Design distributes carries the Cloud config, so a user who downloads from quorum.watch can sign in; a user who builds from source gets the Local edition unless they point it at a server with `QUORUM_CLOUD_URL` and `QUORUM_CLOUD_ANON_KEY`.
2. Any company model key or hosted model call. Model access defaults to none. Settings shows three choices: Claude Code on this Mac, your own API key (Keychain), or a local model. Nothing works until the user picks one, and the app says so plainly.
3. Any URL on smejkal.design or headways.ai. Placeholder links point at quorum.watch or at nothing.
4. Analytics, crash reporting, update checks that hit a company server. Updates come from GitHub Releases.

## License and repo layout

- One public repo `smejkaldesign/quorum`, Apache-2.0 at the root; copyright holder Smejkal Design (sole proprietorship). CLA enforced with the CLA Assistant GitHub app; SECURITY.md with a contact address. Permissive so a company can run it on every laptop without legal review; the moat is the hosted service, not the client code.
- `app/ee/` holds Cloud-only client code (account, sync, members, Build my Agent OS, team knowledge UI) under `ee/LICENSE` (source available, use only with a Quorum Cloud subscription). `supabase/` lives under the same terms. This mirrors Celune's boundary and reuses its CLA and license text.
- CI check: the Local build must not import from `app/ee/`. A `QUORUM_EDITION=local|cloud` build flag selects the entry points; the default is `local`.
- Secrets scan (gitleaks) and a founder-content guard (no personal paths, emails, customer names) run on every push, as on Celune.

## Why this split

- Local-first is the credible position in this category. Granola, Obsidian, MacWhisper and the open-source note takers all compete on "audio and notes stay on your machine". Quorum's distinct claim is the Agent OS: meetings land in the user's own markdown knowledge base that Claude Code already reads. That claim is strongest when the client is open and the data format is plain files.
- The things people pay for are the things that need a server: sync between machines, a web view, a team sharing a workspace, and a service that builds and tends the knowledge base for someone who will never set up a vault by hand. Those map directly to Cloud and stay out of the free edition without crippling it.
- BYOK keeps Cloud margins predictable (no model bills) and keeps Local at $0.

## Distribution

- Signed and notarized DMG on GitHub Releases, auto-update through the Releases feed.
- quorum.watch: landing page, download button, pricing table with two columns (Open source, Cloud) and a subdued Enterprise row, same as celune.ai.
- Supabase Auth site URL moves to quorum.watch.

## Decisions (Eric, 2026-11-08)

1. One paid tier for v1. Team tier planned later; members and invites ship inside Cloud, watch seat counts.
2. Price: $5 per seat per month (revised from $9 the same day).
3. Dead Settings rows stay visible as a to-do map until the features ship.
4. Hosted model access in Cloud: not in the first release. BYOK only; revisit when support load shows people stuck on keys.

## Environments and administration

- Development runs against the local Supabase stack (`supabase start`) with the same migrations; production (`quorum`) is for the signed release. A second hosted project costs $10 a month on the Pro organization, so a hosted dev project is optional later, in a free organization. The dev build signs in against its own environment with its own account and session file; nothing is shared with production. Pointing a dev build at production needs an explicit switch in the developer section of Settings and shows a banner while it is on.
- Super admin: Eric's account carries a `platform_owner` role in production (same pattern as Celune), outside any workspace, with the ability to list workspaces and members, set plans by hand, and read audit rows.
- Admin app: a small web app at admin.quorum.watch, its own directory and UI, for the platform owner only: workspaces, plans, seats, invites, feature flags, environment banner. Phase 2 of the Cloud work, after sync.

## Accounts and documents, logged on the tasks that need them

Apple Developer Program (signing task), Stripe activation, Terms and Privacy pages and Stripe Tax (billing task), Google OAuth consent screen and Resend SMTP (Google sign-in task), support mailbox and a trademark search note (quorum.watch task). None of these are started until their task is.

## Related

- docs/parity-gaps.md, docs/backend-plan.md
- Vault: `MyBrain/04-projects/celune-oss-narrative-draft.md`, `celune-cloud-pricing-simplification.md`, `celune-oss-phase2-one-repo-prd.md`
