# Self-hosting the Cloud edition

The Cloud edition adds sign-in, workspaces, members and sync on top of the Local edition. It talks to a Supabase project. This guide runs it against a project you own.

The Local edition needs none of this. Build from source with `npm run start` or `npm run package` and skip this page.

## 1. Create a Supabase project

Create a project in the Supabase dashboard or with the CLI. Note the project URL and the anon (publishable) key from Project Settings, API.

## 2. Apply the migrations

Apply every file in `supabase/migrations/` in file-name order. With the CLI, from the repo root:

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

## What sync stores

Notes and meetings push to your project when sync is on in Settings. Audio never leaves the Mac. Hidden paths, private folders, notes with `confidential:` in their frontmatter and withheld transcript lines are skipped. Sync is off by default.

## Related

- `docs/open-source-strategy.md`: the edition split and what each edition includes
- `docs/parity-gaps.md`: open items in the Cloud edition
- `app/ee/LICENSE`: terms for the code under `app/ee/` and `supabase/`
