// flags answered before the app starts: `Quorum --version` prints one line and exits, with no window, no
// single-instance hand-over and no start-up log, so a script can check the installed version. CommonJS so the
// dev-app.cjs wrapper can use it too
const FLAGS = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' };

// argv[0] is the binary; in development argv[1] is the app folder, which never matches a flag
function startupFlag(argv) {
  for (const arg of argv.slice(1)) if (Object.hasOwn(FLAGS, arg)) return FLAGS[arg];
  return null;
}

function startupText(flag, version) {
  if (flag === 'version') return `${version}\n`;
  return `Quorum ${version}\n\nUsage: Quorum [options]\n\n  -v, --version  print the version and exit\n  -h, --help     print this help and exit\n`;
}

module.exports = { startupFlag, startupText };
