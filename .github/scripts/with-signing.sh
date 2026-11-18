#!/bin/bash
# Runs one command with the release signing credentials. The calling step passes them in its own env, so no other step
# sees them. electron-builder treats an empty CSC_LINK as a certificate path and fails, so empty values are unset. The
# App Store Connect key arrives as the .p8 contents in APPLE_API_KEY_CONTENTS; electron-builder and notarize-dmg.sh read
# APPLE_API_KEY as a path, so the key is written to a private file that is removed when the command ends.
set -uo pipefail
for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_API_KEY_CONTENTS; do
  [ -n "${!name:-}" ] || unset "$name"
done
keydir=""
cleanup() { if [ -n "$keydir" ]; then rm -rf "$keydir"; fi; }
trap cleanup EXIT
if [ -n "${APPLE_API_KEY_CONTENTS:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ]; then
  keydir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/asc.XXXXXX")"
  chmod 700 "$keydir"
  (umask 077 && printf '%s' "$APPLE_API_KEY_CONTENTS" > "$keydir/AuthKey_$APPLE_API_KEY_ID.p8")
  export APPLE_API_KEY="$keydir/AuthKey_$APPLE_API_KEY_ID.p8"
fi
unset APPLE_API_KEY_CONTENTS
"$@"
