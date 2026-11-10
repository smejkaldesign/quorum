# Contributing

## Setup

Prerequisites are in `README.md`. Then:

```sh
cd helper && swift build -c release
cd ../app && npm ci && npm run start
```

## Checks

Run these before opening a pull request. CI runs the same commands.

```sh
cd app
npm run typecheck
npm run lint
npm test
npm run check:content
npm run build && npm run check:edition
```

`npm run check:content` is the founder content guard: it fails on home paths, personal email addresses and internal names that do not belong in a public repository. CI also runs gitleaks over the history; `gitleaks git .` runs the same scan locally if you have it installed.

## Edition boundary

Code under `app/ee/` is the Cloud edition and carries its own license. Nothing outside `app/ee/` may import from it, with two exceptions: `app/edition.js` (main process, through `loadEE`) and `app/src/edition.tsx` (renderer). `npm run check:edition` fails on any other import and on any `ee/` code in the Local renderer bundle. Put new Cloud-only code under `app/ee/` and reach it through those two files.

## Contributor license agreement

Contributions need a signed contributor license agreement with Smejkal Design; the text is in `CLA.md`. A bot comments on your first pull request with the sentence to reply with. Sign once and it applies to later pull requests.

## Commits

- One change per commit.
- Plain sentences in the message: what changed and why.
- Keep the diff to the change. Formatting passes go in their own commit.

## Pull requests

Describe what changed, how you verified it, and anything a reviewer should look at first. Vulnerabilities go to the address in `SECURITY.md`, never to a public issue.
