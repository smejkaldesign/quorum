#!/bin/zsh
# Signs, notarizes and staples the DMG that `npm run package` produced. electron-builder signs and notarizes the app
# inside the image; the image itself needs this pass so Gatekeeper accepts the download as "Notarized Developer ID".
# Needs: a Developer ID Application identity in Keychain, and the App Store Connect API key as
#   APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER.
set -euo pipefail
cd "$(dirname "$0")/.."
dmg="${1:-$(ls -t release/*.dmg | head -1)}"
identity="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)"
[ -n "$identity" ] || { echo "no Developer ID Application identity in Keychain"; exit 1; }
: "${APPLE_API_KEY:?set APPLE_API_KEY to the .p8 path}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"
codesign --force --sign "$identity" --timestamp "$dmg"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"
spctl -a -vv -t open --context context:primary-signature "$dmg"
