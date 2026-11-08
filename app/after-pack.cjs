// signs with the local Quorum cert so macOS keeps mic, audio and accessibility grants across rebuilds
// electron-builder will not sign with an untrusted identity, so we do it here
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // the audio helper sits in Resources, which --deep doesn't reach, so it's signed first, then the app around it
  const helper = path.join(app, 'Contents/Resources/QuorumHelper');
  execFileSync('codesign', ['--force', '--sign', 'Quorum Local Signing', '--identifier', 'design.smejkal.quorum.helper', helper], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', 'Quorum Local Signing', app], { stdio: 'inherit' });
};
