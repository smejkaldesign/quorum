import { describe, expect, it } from 'vitest';
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
