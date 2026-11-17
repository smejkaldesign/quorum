// Every test's temp folders go to the system temp folder. Some shells set TMPDIR to the folder they run in, and when
// that is a git work tree the tests' mkdtemp folders landed in the repo. When TMPDIR sits inside a work tree (a folder
// above it holds .git), this points it at the user's macOS temp folder, or /tmp elsewhere. Child processes the tests
// start inherit it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function inWorkTree(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}
function systemTemp() {
  if (process.platform === 'darwin') {
    try { const d = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(); if (d && !inWorkTree(d)) return d; } catch {}
  }
  return '/tmp';
}

const cur = process.env.TMPDIR;
if (cur && inWorkTree(cur)) process.env.TMPDIR = systemTemp();
