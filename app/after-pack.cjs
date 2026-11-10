// Signs the Swift helper before electron-builder signs the app around it: the helper sits in Resources, which the
// default signing pass does not reach. With a Developer ID certificate in Keychain the helper gets the hardened
// runtime, a timestamp and its entitlements, and electron-builder then signs and notarizes the app. Without one,
// the whole app is signed with the local development certificate, or ad hoc as a last resort (then macOS asks for
// mic and Accessibility again after every rebuild).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function identities() {
  try { return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); } catch { return ''; }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const helper = path.join(app, 'Contents/Resources/QuorumHelper');
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
