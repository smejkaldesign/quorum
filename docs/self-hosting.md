# Self-hosting the Cloud edition

The Cloud edition adds sign-in, workspaces, members and sync on top of the Local edition. It talks to a Supabase project. This guide runs it against a project you own.

The Local edition needs none of this. Build from source with `npm run start` or `npm run package` and skip this page.

## 1. Create a Supabase project

Create a project in the Supabase dashboard or with the CLI. Note the project URL and the anon (publishable) key from Project Settings, API.

## 2. Apply the migrations

Apply every file in `supabase/migrations/` in file-name order (`0007_relay.sql` is only needed with the relay below). With the CLI, from the repo root:

```sh
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste each file into the SQL editor in order (`0001_init.sql`, then `0002_accounts.sql`, and so on). Every table has row level security on; nothing is readable without a session.

For local development, `supabase start` runs the same migrations in a local stack.

## 3. Configure Auth

In Authentication, Email Templates, set the Magic Link template body to send the code instead of a link. The app signs in with a 6-digit code, so the body must contain `{{ .Token }}`, for example:

```
Your Quorum sign-in code is {{ .Token }}
```

In Authentication, URL Configuration, set the Site URL to an address you control. The app completes sign-in with the code and does not follow a redirect, but Supabase requires a value.

The built-in email sender allows about 2 messages per hour. For more than one user, set a custom SMTP provider under Authentication, SMTP Settings.

## 4. Point the app at your project

Create a file named `.env` at the repo root (it is gitignored) with two lines:

```
QUORUM_SUPABASE_URL=https://<your-project-ref>.supabase.co
QUORUM_SUPABASE_ANON_KEY=<your anon key>
```

The app reads this file when the two variables are absent from the environment.

## 5. Build

```sh
cd helper && swift build -c release
cd ../app && npm ci
npm run start:cloud        # development copy
npm run package:cloud      # signed release build and DMG
```

`npm run package:cloud` sets `QUORUM_EDITION=cloud` in the packaged `package.json`, so the installed app loads the code under `app/ee/`. Signing needs an identity in your Keychain; see `app/package.json` for the electron-builder settings.

## Development

A copy started from a checkout (`npm run start` or `npm run start:cloud`) runs in the development environment; the installed build runs in production. `QUORUM_ENV=production` or `QUORUM_ENV=development` in the shell overrides that (`app/edition.js`).

**Where data lives.** The development copy keeps everything under `~/Library/Application Support/Quorum Dev`: `settings.json`, `auth.json`, `sync-ids.json`, `sessions/`, `chats/`, `attachments/` and the control socket `quorum.sock`. The installed app keeps the same files under `~/Library/Application Support/Quorum`. The two copies still share one single-instance lock, so only one runs at a time (`npm run dev` quits the installed app first). The `quorum` command reads the installed app's folder; set `QUORUM_ENV=development` to point it at the development copy.

**Local Supabase stack.** With Docker running:

```sh
cd app && npm run db:local      # supabase start from the repo root, then prints the API, Studio and mail URLs
npm run start:cloud             # the development copy, signed in against the local stack
```

`supabase start` applies `supabase/migrations/` and `supabase/seed.sql`. Sign-in emails from the local stack land in Mailpit (the URL `supabase status` prints); `supabase/config.toml` sets the magic link template to send the 6-digit code. Stop the stack with `supabase stop`.

**Which project the app talks to.** `app/ee/account.js` resolves the Supabase URL and anon key in this order:

1. `QUORUM_SUPABASE_URL` and `QUORUM_SUPABASE_ANON_KEY` set in the shell.
2. Production, or a development copy with the developer switch on: `.env` at the repo root.
3. Development: `.env.development` at the repo root (gitignored) when present, else the local stack at `http://127.0.0.1:54321` with the stack's published anon key (read from `supabase status` when the CLI is installed).

Production never falls back to the local stack. Without `.env` it runs with hosted accounts unconfigured.

**The developer switch.** Settings shows a "Use production data" toggle in development copies only. On, the development copy loads `.env` instead of its own config, keeps a separate session file (`auth-production.json`) and sync id map (`sync-ids-production.json`), and shows "Connected to production" in red while it is on. The setting is `devUseProduction` in the development copy's `settings.json`.

## Platform owner and the admin app

Migration `0008_platform_owner.sql` adds a role outside any workspace for whoever runs the deployment: the platform owner. The owner works in the admin app under `admin/` (hosted at admin.quorum.watch for the Quorum service), never in the desktop app, which carries no operator surface. The admin app shows beta access requests and the access codes they turn into (migrations 0009, 0016 and 0018: approving a request picks the plan the code grants, free or cloud, and a cloud code puts the workspace the person creates on the cloud plan), every install that checked in with a code, every workspace with its members, usage this period and a form that sets the plan, seats included and notes by hand, the accounts list, and the audit log; each change writes a row to `platform_audit`. The owner reads nothing from the tables directly; everything goes through the `platform_*` RPCs, which refuse any other account.

Signing in to the admin app takes the email code and then a passkey (migration `0017_platform_passkeys.sql`, relay `passkeys.js`). The first passkey is registered from the admin app itself; from then on the owner-only RPCs answer only while a passkey session is live, which the app proves with the `x-quorum-passkey` request header. An owner who loses every passkey gets back in by deleting the rows in `platform_passkeys` for that account, after which the email code alone works again until a new passkey is registered.

To run the admin app: `cd admin && npm ci && npm run build && npm start`, with `QUORUM_SUPABASE_URL`, `QUORUM_SUPABASE_ANON_KEY` and `RELAY_URL` set at build time (a development build with nothing set uses the local stack and a relay on localhost). On Railway, point a service at the `admin/` directory with those three variables and give it the admin hostname; the relay needs that hostname in `CORS_ORIGINS`, `PASSKEY_RP_ID` set to the registrable domain (`quorum.watch`), and `RESEND_API_KEY` for the code email.

Nothing in the migrations grants the role. `supabase/seed/platform-owner.sql` grants it to one email, which must have signed in once already:

```sh
# local stack
cd app && EMAIL=owner@example.com npm run db:seed-owner

# a hosted project: the connection string from Project Settings, Database
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v email="'owner@example.com'" -f supabase/seed/platform-owner.sql
```

The script prints the row it holds for that email, or nothing when the account does not exist yet. Revoke with `delete from public.platform_owners where user_id = '<id>'`.

## What sync stores

Notes and meetings push to your project when sync is on in Settings. Audio never leaves the Mac. Hidden paths, private folders, notes with `confidential:` in their frontmatter and withheld transcript lines are skipped. Sync is off by default.

**Pull.** With sync on, the app also pulls what other devices wrote. While signed in with a workspace chosen, the app holds a Supabase Realtime channel on the workspace's `notes` and `meetings` rows and pulls within a second of each change; Settings shows "Live" while the channel is subscribed and "Polling" when it is not. Realtime streams only tables in the `supabase_realtime` publication, which migration `0005_realtime.sql` adds them to; without it the channel subscribes but no events arrive. The app also pulls at sign-in, when you switch workspace, when the window comes to the front and every three minutes in between, so a dropped socket costs at most one poll interval. In the other direction the app watches the vault folder and pushes a markdown file 1.5 seconds after it stops changing; files the pull itself wrote are skipped because their hash already matches `sync-ids.json`. Rows changed since the last pull (`sync-pull.json`, next to `sync-ids.json`) are written to the vault at the path each row stores, never inside a private folder. A file you edited that also changed remotely keeps the remote text and your text lands next to it as `<name> (conflict <date>).md`; a note removed remotely is renamed `<name> (removed).md`. Pulls never delete a file. A pulled note with `confidential:` frontmatter is written but this device will not push it again.

## Google Calendar connector

The Google Calendar connector (Settings, Connectors, Calendar) reads upcoming events with the person's own Google account: Desktop-type OAuth client, PKCE, the loopback redirect `http://127.0.0.1:47832/callback`, scope `calendar.readonly`, tokens in the Mac's Keychain. It works in both editions and costs the operator nothing. Google requires the client secret in the token request for Desktop clients even with PKCE, and its documentation treats that value as a public identifier for installed apps, so the app reads the pair at run time and the repository holds neither.

1. In Google Cloud, create an OAuth client of type Desktop app in the project whose consent screen lists the `calendar.readonly` scope. While the consent screen is in Testing, only its test users can sign in.
2. Give the app the pair. A build from source reads `QUORUM_GOOGLE_CLIENT_ID` and `QUORUM_GOOGLE_CLIENT_SECRET` from the shell, then from `.env` or `.env.development` at the repo root. A packaged build reads `quorumGoogle.clientId` and `quorumGoogle.clientSecret` from its `package.json`; the release workflow writes them from the repository secrets of the same names when they are set (`.github/workflows/release.yml`). Without a secret the connector's page says what to set and Connect does nothing else.
3. Connect from Settings, Connectors, Google Calendar. Home's Up next merges the Calendar app and Google events (one row for a meeting both can see), and the people on a call come from either.

The client id defaults to the one Quorum's own builds use, which is a public identifier; the secret has no default.

## Running the transcription relay

The Local edition never needs this. The relay (`relay/`) is the Cloud edition's managed transcription: the app streams 16 kHz audio to it over one websocket, it forwards each channel to a speech engine (AssemblyAI Universal-Streaming by default, Deepgram Nova-3 as the alternative) and returns the same transcript events the on-device engine emits. It also runs the running summary and the final notes on a managed model key (`POST /v1/notes`, streamed as server-sent events). Audio is forwarded and dropped; the relay stores none of it and logs durations and engine names only.

**Migration.** Apply `supabase/migrations/0007_relay.sql` with the others. It adds `workspaces.hour_packs`, `workspace_usage_events.engine`, the service-role RPC `relay_connector_secret` that reads a workspace connector's key from Vault, and a `required` flag in `workspace_settings.voice`. Billing needs `0011_billing.sql`, the Zoom connection routes need `0014_connect.sql` (`connect_accounts`, `connect_events`), workspace guardrails (Settings, Admin, Guardrails) need `0015_guardrails.sql`, the beta access intake needs `0016_access_requests.sql`, the owner's passkey needs `0017_platform_passkeys.sql`, and the plan a code grants plus the beta install gate need `0018_access_plans.sql`.

**Run it.**

```sh
cd relay && npm ci
cp .env.example .env     # fill in the values below
node server.js           # health at http://127.0.0.1:8787/healthz
```

| Variable | What it is |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | your project; the anon key checks the app's session token (`auth.getUser`) |
| `SUPABASE_SERVICE_ROLE_KEY` | membership, settings and allowance reads, usage writes, the connector secret RPC |
| `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY` | at least the one `RELAY_ENGINE` names (`assemblyai` or `deepgram`) |
| `ANTHROPIC_API_KEY` | the summary and notes steps on your key; leave empty to serve speech only |
| `RELAY_OPENAI_MODEL` | model for an OpenAI or OpenAI-compatible connector an admin pointed summary or notes at (default `gpt-4o-mini`) |
| `RELAY_MAX_SESSION_SECONDS`, `RELAY_IDLE_MS` | one connection carries at most this much audio (default 14400, four hours) and closes after this long without a frame (default 20000) |
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | the Zoom app's client credentials (`docs/specs/meeting-sources.md`). The relay exchanges the app's authorization code and refreshes tokens at `/v1/connect/zoom/token`, so the secret never ships inside the desktop app. Leave empty to serve no Zoom connections |
| `ZOOM_WEBHOOK_SECRET` | the Zoom app's Secret Token. Zoom posts `recording.completed` to `/v1/connect/zoom/webhook`; the relay checks the signature and keeps the event in `connect_events` until the member's app fetches it |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | billing (`relay/billing.js`): Checkout sessions and the webhook at `/v1/billing/webhook`. Leave empty to run without paid plans |
| `STRIPE_SEAT_PRICE`, `STRIPE_PACK_PRICE` | the Stripe price ids for a seat and for a 20-hour pack |
| `BILLING_RETURN_URL` | where Checkout and the billing portal return to (default `https://quorum.watch`) |
| `CORS_ORIGINS` | the browser pages allowed to call the beta access intake, the code email and the passkey routes (`relay/platform.js`, `relay/passkeys.js`): the site and the admin app (default `https://quorum.watch,https://www.quorum.watch,https://admin.quorum.watch`) |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO` | the code email the admin app sends to an approved request, through Resend; leave the key empty and the admin app offers Copy instead. `MAIL_FROM` defaults to `Quorum <noreply@quorum.watch>` |
| `MAIL_NOTIFY_TO` | where the relay sends a one-line notice for each new beta signup from the site (default `eric@smejkal.design`; set your own address, or leave the Resend key empty for no notices) |
| `DOWNLOAD_URL` | the download link in that email (default the latest release's Cloud DMG on GitHub) |
| `/v1/beta/check`, `/v1/beta/heartbeat` | not variables: the two public routes the app calls during the beta (`relay/beta.js`, migration 0018). The check takes the access code, a machine id, the edition and the version, records the install in `beta_installs` and answers the plan the code grants; the heartbeat sends only the code, the machine id and the version, and updates `last_seen`. A free code admits one Mac; a cloud code follows the account |
| `PASSKEY_RP_ID` | the WebAuthn relying party id for the owner's passkey: the registrable domain the admin app lives under (default `quorum.watch`; `localhost` for a local admin build) |
| `PORT` | default 8787 |

`relay/.env.example` lists the same variables with a one-line note each.

On Railway, create a service from the repo with the config file `relay/railway.json` (build `cd relay && npm ci --omit=dev`, start `node relay/server.js`, health check `/healthz`) and set the same variables. The relay imports `app/notes.js` for the prompts, so the service builds from the repo root.

**Point the app at it.** The Cloud app uses `wss://relay.quorum.watch` in production and `ws://127.0.0.1:8787` when it runs against the local Supabase stack. `QUORUM_RELAY_URL` in the shell or `.env` overrides both.

**How a call is routed.** The relay checks the token, the caller's membership, then `workspace_settings.voice`. With `speech` set to an organization connector, the audio goes to that provider on the organization's key and the hours do not count. Otherwise it runs on the relay's own key and the workspace pool applies: 20 hours a seat plus 20 for each `hour_packs`, per calendar month, pooled across the workspace, less this month's `managed_hours` from the `workspace_usage` view. An empty pool refuses the session with `allowance` and the app continues on the on-device engine; a session that reaches the pool or the 4 hour per-connection cap closes with `cap` and the app starts a fresh local segment. 20 seconds without a frame closes the socket. One `workspace_usage_events` row is written per session (recorded seconds, engine, connector) and per notes call (seconds 0, the model as engine).

**In the app.** The on-device engine is the default. A call goes through the relay when the workspace sets `voice.required`, when `voice.speech` names a connector, or when `settings.transcription.engine` is `managed` (set it with `quorum settings-set` until Settings has the switch).

**Protocol.** Connect to `/v1/transcribe`, send one JSON hello `{ token, workspaceId, meetingId, channels: ['me','them'], sampleRate: 16000, terms: [...], locale }` (the token may come as an `Authorization: Bearer` header instead), wait for `{event:'ready', engine, counted, remainingSeconds}`, then send binary frames of one channel-index byte followed by PCM16LE. Events come back as `{event:'transcript', channel, text, isFinal, start, end}`; `{event:'stop'}` ends the session cleanly. `relay/scripts/stream-wav.mjs` streams a WAV file through a running relay and prints the finals.

## Related

- `docs/open-source-strategy.md`: the edition split and what each edition includes
- `docs/parity-gaps.md`: open items in the Cloud edition
- `app/ee/LICENSE`: terms for the code under `app/ee/`
