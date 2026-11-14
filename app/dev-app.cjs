// the Dock names an app from its bundle, so dev runs from a renamed copy of Electron.app
const { execFileSync, spawn } = require('node:child_process');
const { cpSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { startupFlag, startupText } = require('./argv.cjs');

// `node dev-app.cjs --version` answers and exits before the wrapper builds a copy or quits a running dev app
const flag = startupFlag(process.argv);
if (flag) {
  require('node:fs').writeSync(1, startupText(flag, JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version));
  process.exit(0);
}

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

// one development copy at a time: an earlier instance still running (a wrapper killed without its child, a window left
// open from the last start) is told to quit before the new one starts, so the Dock never fills with old versions
const bin = path.join(dest, 'Contents/MacOS/Electron');
try {
  const mine = String(process.pid);
  const pids = execFileSync('pgrep', ['-f', bin], { encoding: 'utf8' }).split('\n').map((x) => x.trim()).filter((x) => x && x !== mine);
  if (pids.length) {
    console.log(`quitting ${pids.length} earlier dev app${pids.length === 1 ? '' : 's'}`);
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} }
    // an instance that ignores the polite signal (seen on 2026-11-10) gets the hard one after a moment
    execFileSync('sleep', ['1.5']);
    for (const pid of pids) { try { process.kill(Number(pid), 0); process.kill(Number(pid), 'SIGKILL'); } catch {} }
  }
} catch {}

// the development copy runs in the development environment (edition.js ENV) unless the shell sets QUORUM_ENV itself.
// The app dies with this wrapper: a signal here is passed on, so a plain kill of the wrapper takes the window with it
const child = spawn(bin, [__dirname], { stdio: 'inherit', env: { QUORUM_ENV: 'development', ...process.env } });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(0), 1500).unref(); });
