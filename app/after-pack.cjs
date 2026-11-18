// Signs the Swift helper before electron-builder signs the app around it: the helper sits in Resources, which the
// default signing pass does not reach. With a Developer ID certificate in Keychain the helper gets the hardened
// runtime, a timestamp and its entitlements, and electron-builder then signs and notarizes the app. Without one,
// the whole app is signed with the local development certificate, or ad hoc as a last resort (then macOS asks for
// mic and Accessibility again after every rebuild).
//
// Before any signing it flips the Electron fuses (FUSES below). electron-builder's own electronFuses option runs after
// this hook, which would break the local signature made here, so the fuses are flipped here for both signing paths.
//
// It also copies cli/*.mjs to Resources/cli, where the quorum command and the MCP servers run them. They stay in app.asar
// as well (main.js, keeper.js and appActions.js import them), and electron-builder leaves every file an extraResources
// entry names out of app.asar, so the copy happens here.
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// RunAsNode stays on: the quorum command and the MCP servers Claude Code and Codex start run as
// ELECTRON_RUN_AS_NODE=1 with this binary (main.js RUNTIME). Turning it off needs a separate runtime for the CLI first
const FUSES = {
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
};
exports.FUSES = FUSES;

function identities() {
  try { return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); } catch { return ''; }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const helper = path.join(app, 'Contents/Resources/QuorumHelper');
  const cli = path.join(app, 'Contents/Resources/cli');
  mkdirSync(cli, { recursive: true });
  for (const f of readdirSync(path.join(__dirname, 'cli')).filter((n) => n.endsWith('.mjs'))) copyFileSync(path.join(__dirname, 'cli', f), path.join(cli, f));
  await context.packager.addElectronFuses(context, { version: FuseVersion.V1, resetAdHocDarwinSignature: true, ...FUSES });
  const found = identities();
  const devId = found.match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (devId) {
    execFileSync('codesign', ['--force', '--sign', devId, '--options', 'runtime', '--timestamp', '--identifier', 'design.smejkal.quorum.helper',
      '--entitlements', path.join(__dirname, 'build/entitlements.helper.plist'), helper], { stdio: 'inherit' });
    return; // electron-builder signs and notarizes the app itself with the same identity
  }
  let identity = 'Quorum Local Signing';
  if (!found.includes(identity)) { identity = '-'; console.warn('after-pack: no Developer ID or "Quorum Local Signing" certificate in Keychain, signing ad hoc'); }
  execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'design.smejkal.quorum.helper', helper], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' });
};
