import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import argv from '../argv.cjs';

const { startupFlag, startupText } = argv;

describe('startupFlag', () => {
  it('finds --version and -v in a packaged launch and a development launch', () => {
    expect(startupFlag(['/Applications/Quorum.app/Contents/MacOS/Quorum', '--version'])).toBe('version');
    expect(startupFlag(['/Applications/Quorum.app/Contents/MacOS/Quorum', '-v'])).toBe('version');
    expect(startupFlag(['/tmp/Electron', '/tmp/quorum/app', '--version'])).toBe('version');
  });

  it('finds --help and -h', () => {
    expect(startupFlag(['/tmp/Quorum', '--help'])).toBe('help');
    expect(startupFlag(['/tmp/Quorum', '-h'])).toBe('help');
  });

  it('starts the app normally for anything else', () => {
    expect(startupFlag(['/tmp/Quorum'])).toBeNull();
    expect(startupFlag(['/tmp/Electron', '/tmp/quorum/app'])).toBeNull();
    expect(startupFlag(['/tmp/Quorum', '--inspect', 'constructor', 'toString'])).toBeNull();
    expect(startupFlag(['--version'])).toBeNull();
  });

  it('reads only whole arguments before --', () => {
    expect(startupFlag(['/tmp/Quorum', '--', '--version'])).toBeNull();
    expect(startupFlag(['/tmp/Quorum', '--version=1', '--versions', '-vv', 'x--help'])).toBeNull();
    expect(startupFlag(['/tmp/Quorum', '--inspect', '-v', '--', '--help'])).toBe('version');
  });
});

describe('startupText', () => {
  it('prints the bare version for --version', () => {
    expect(startupText('version', '0.3.1')).toBe('0.3.1\n');
  });

  it('names the version and both flags for --help', () => {
    const help = startupText('help', '0.3.1');
    expect(help).toContain('Quorum 0.3.1');
    expect(help).toContain('--version');
    expect(help).toContain('--help');
  });
});

describe('main.js', () => {
  it('imports startup-flags.js first, so --version exits before any other module runs', () => {
    const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
    const first = main.split('\n').find((line) => line.startsWith('import '));
    expect(first).toBe("import './startup-flags.js';");
  });
});
