// the Dock names an app from its bundle, so dev runs from a renamed copy of Electron.app
const { execFileSync, spawn } = require('node:child_process');
const { cpSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, 'node_modules/electron/dist/Electron.app');
const dest = path.join(__dirname, '.dev/Quorum Dev.app');
const stamp = path.join(__dirname, '.dev/electron-version');
// bump the suffix when the plist below changes, so the copy gets rebuilt
const version = `${readFileSync(path.join(__dirname, 'node_modules/electron/package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)[1]}+cal`;

if (!existsSync(dest) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== version) {
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  const plist = path.join(dest, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('plutil', ['-replace', key, '-string', 'Quorum Dev', plist]);
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'design.smejkal.quorum.dev', plist]);
  execFileSync('plutil', ['-replace', 'NSCalendarsFullAccessUsageDescription', '-string', 'Quorum shows your upcoming meetings on Home.', plist]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', dest]);
  writeFileSync(stamp, version);
}

// the development copy runs in the development environment (edition.js ENV) unless the shell sets QUORUM_ENV itself
spawn(path.join(dest, 'Contents/MacOS/Electron'), [__dirname], { stdio: 'inherit', env: { QUORUM_ENV: 'development', ...process.env } }).on('exit', (code) => process.exit(code ?? 0));
