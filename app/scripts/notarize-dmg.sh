#!/bin/zsh
# Signs, notarizes and staples the DMG that `npm run package` produced. electron-builder signs and notarizes the app
# inside the image; the image itself needs this pass so Gatekeeper accepts the download as "Notarized Developer ID".
# Needs: a Developer ID Application identity in Keychain, or CSC_LINK (base64 .p12 or a path to one) with
# CSC_KEY_PASSWORD as on CI, where electron-builder's own temporary keychain is gone by the time this runs; and the
# App Store Connect API key as APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER.
set -euo pipefail
cd "$(dirname "$0")/.."
dmg="${1:-$(ls -t release/*.dmg | head -1)}"
: "${APPLE_API_KEY:?set APPLE_API_KEY to the .p8 path}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
find_identity() { security find-identity -v -p codesigning "$@" | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1; }
identity="$(find_identity)"
keychain_args=()
if [ -z "$identity" ] && [ -n "${CSC_LINK:-}" ]; then
  # a temporary keychain of our own, removed on exit, so the certificate never lands in the login keychain
  work="$(mktemp -d)"
  kc="$work/notarize.keychain-db"
  kcpw="$(uuidgen)"
  cleanup() { security delete-keychain "$kc" 2>/dev/null || true; rm -rf "$work"; }
  trap cleanup EXIT
  if [ -f "$CSC_LINK" ]; then p12="$CSC_LINK"; else p12="$work/cert.p12"; printf '%s' "$CSC_LINK" | base64 --decode > "$p12"; fi
  security create-keychain -p "$kcpw" "$kc"
  security set-keychain-settings -lut 1800 "$kc"
  security unlock-keychain -p "$kcpw" "$kc"
  security import "$p12" -k "$kc" -P "${CSC_KEY_PASSWORD:-}" -T /usr/bin/codesign -T /usr/bin/security > /dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kcpw" "$kc" > /dev/null
  security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
  identity="$(find_identity "$kc")"
  keychain_args=(--keychain "$kc")
fi
[ -n "$identity" ] || { echo "no Developer ID Application identity in Keychain and no CSC_LINK to import"; exit 1; }
codesign --force --sign "$identity" "${keychain_args[@]}" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"
spctl -a -vv -t open --context context:primary-signature "$dmg"
