# Release checklist

The ordered steps for the first public release of Quorum, and the shorter list for every release after it. Steps marked **owner** need the repository owner's account or an explicit decision; everything else an agent can run.

## Before the repository turns public

Run once, in this order, from a clean clone of `main`. Every step must pass before the next.

### 1. Verify from a clean clone

```sh
git clone https://github.com/smejkaldesign/quorum.git /tmp/quorum-clean && cd /tmp/quorum-clean
(cd helper && swift build && swift test)
(cd app && npm ci && npm run typecheck && npm run lint && npm test && npm run check:content)
(cd app && npm run build && npm run check:edition)
(cd app && QUORUM_EDITION=cloud npm run build:cloud && QUORUM_EDITION=cloud npm run check:edition)
(cd app && npm run build:site-preview)
(cd relay && npm ci && npm test)
gitleaks git .
```

`gitleaks git .` scans the full history with `.gitleaks.toml`. The one allowlisted value is the local Supabase stack's anon key, which is public by design. Any other finding blocks the release until the history is rewritten (step 3) or the value is rotated.

### 2. Confirm the tree carries nothing personal

`npm run check:content` covers tracked files at HEAD. The names it looks for are in `app/scripts/check-founder-content.mjs`; `.founder-guard-allow` lists the literals that may appear. Before the first public push also check the history, because early revisions of the docs named the founder's employer's product:

```sh
# one run per literal in the guard's RULES array; the names are not repeated here because this file is scanned too
git log --oneline -i -G"<name>" | wc -l
```

A non-zero count for any name is why step 3 exists.

### 3. Squash the history to one commit (**owner**, decided 2026-11-09)

The private history stays in the private clone. The public repository starts from one commit that holds the current tree. The commands below never touch `main` until the last two lines, which run only on the owner's explicit go; a force push to a shared `main` without that word is out of bounds.

```sh
cd /path/to/quorum && git checkout main && git pull --ff-only
git checkout --orphan public-main
git add -A
git commit -m "Quorum $(node -p "require('./app/package.json').version"): first public release"
# the guards again, on the orphan
(cd app && npm run check:content)
gitleaks git .
git log --oneline            # exactly one line
# publish the orphan as its own branch first; nothing is overwritten
git push origin public-main
```

Open `public-main` on GitHub and read the tree once. Then, **with the owner's go**:

```sh
git branch -M public-main main           # the local main now points at the single commit; the old main is kept as a tag below
git tag private-history-2026-11 $(git rev-parse origin/main)   # a local tag only; never push it
git push --force origin main
git push origin --delete public-main
```

Afterwards every other clone and worktree of the repository (runner agents, a second Mac) must re-clone; a pull will not fast-forward. Open pull requests based on the old history need their commits cherry-picked onto the new `main`. Railway redeploys the relay and the site from the new `main` on its own.

### 4. Repository settings (**owner**)

- Settings, General: description and website `https://quorum.watch`; features: issues on, wiki off, discussions off for now.
- Settings, Branches: protect `main` (require the CI workflow to pass, no force pushes). Set this after step 3, since the squash is itself a force push.
- Settings, Secrets and variables, Actions: the five release secrets (step 5) and `RAILWAY_TOKEN` for the site deploy.
- Settings, General, Danger Zone: change visibility to public. This is the last step; everything above happens while the repository is private.

### 5. Release secrets (**owner**)

The release workflow (`.github/workflows/release.yml`) reads five secrets. Set them with the `gh` CLI; each command reads the value from a file or a prompt so the value never lands in shell history. Do not pass `--body -`: with that form `gh` stores the literal dash.

```sh
# App Store Connect API key (App Store Connect, Users and Access, Integrations, Team Keys): the .p8 file, its key id, the issuer id
gh secret set APPLE_API_KEY --repo smejkaldesign/quorum < ~/Downloads/AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID --repo smejkaldesign/quorum     # paste the 10-character key id at the prompt
gh secret set APPLE_API_ISSUER --repo smejkaldesign/quorum     # paste the issuer id (a UUID) at the prompt

# Developer ID Application certificate: export it from Keychain Access as a .p12 with a password, then
base64 -i ~/Downloads/developer-id.p12 | gh secret set CSC_LINK --repo smejkaldesign/quorum
gh secret set CSC_KEY_PASSWORD --repo smejkaldesign/quorum     # the .p12 password at the prompt
rm ~/Downloads/developer-id.p12
```

Check with `gh secret list --repo smejkaldesign/quorum`. Without `CSC_LINK` and `CSC_KEY_PASSWORD` the workflow still runs, signs the app ad hoc, skips notarization and says so in the job summary; the draft release it produces is a dry run and must not be published.

### 6. First tag

```sh
cd app && npm version 0.2.7 --no-git-tag-version   # only if the version needs to move; the tag must match app/package.json
git commit -am "Release 0.2.7" && git tag v0.2.7 && git push origin main v0.2.7
```

The Release workflow builds, signs, notarizes and attaches `Quorum-0.2.7-arm64.dmg`, `Quorum-0.2.7-arm64-mac.zip`, the blockmaps, `latest-mac.yml` and `SHA256SUMS.txt` to a draft release. Download the DMG from the draft, open it on a Mac that has never run Quorum, and confirm Gatekeeper reports "Notarized Developer ID" (`spctl -a -vv -t open --context context:primary-signature Quorum-0.2.7-arm64.dmg`). Then publish the draft (**owner**). Installed Local builds check this feed on launch and every six hours.

### 7. Announce

- `README.md` download link points at the latest release.
- quorum.watch download button points at the DMG asset of the published release.

## Every later release

1. `main` is green in CI and the clean-clone checks in step 1 pass.
2. Bump `app/package.json` version, commit, tag `v<version>`, push the tag.
3. Wait for the Release workflow, test the DMG from the draft on a clean Mac, publish the draft.
4. The Cloud edition: `npm run package:cloud` on a Mac with the Developer ID identity and the App Store Connect key in the shell (`APPLE_API_KEY` as the .p8 path, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), then `zsh scripts/notarize-dmg.sh`. Then publish the update feed the installed Cloud apps read: copy `app/release/latest-mac.yml`, `Quorum-<version>-arm64-mac.zip` and its `.blockmap` into `site/updates/cloud/` and run `npm run deploy` in `site/`. The DMG goes to the quorum.watch download location. Installed Cloud apps check `https://quorum.watch/updates/cloud/latest-mac.yml` on launch and every six hours and show an Update button once the zip is downloaded.

## Open items

- `GITLEAKS_LICENSE` is only needed if the repository moves to an organization account.
