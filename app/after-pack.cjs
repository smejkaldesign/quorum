// signs with the local Quorum cert so macOS keeps mic, audio and accessibility grants across rebuilds
// electron-builder will not sign with an untrusted identity, so we do it here
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // the audio helper sits in Resources, which --deep doesn't reach, so it's signed first, then the app around it
  const helper = path.join(app, 'Contents/Resources/QuorumHelper');
  // without the local certificate the build is signed ad hoc: it runs, but macOS asks for mic and Accessibility again after every rebuild
  let identity = 'Quorum Local Signing';
  try { if (!execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes(identity)) identity = '-'; } catch { identity = '-'; }
  if (identity === '-') console.warn('after-pack: no "Quorum Local Signing" certificate in Keychain, signing ad hoc');
  execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'design.smejkal.quorum.helper', helper], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' });
};
