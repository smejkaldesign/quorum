// first run on a fresh install: create an Agent OS folder when the user has none, report what the Mac has granted,
// and open the right System Settings pane. The wizard in the window drives these; settings.onboarded ends it
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PANES = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  audio: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
};

const STARTER = (name) => ({
  'README.md': `# ${name}\n\nThis folder is your Agent OS: plain markdown notes that Quorum and Claude Code read and write.\n\n- \`index.md\` lists every note with one line each. Quorum reads it first.\n- \`00-inbox/\` for quick captures, \`01-daily/\` for daily notes, \`08-meetings/quorum/\` for meeting notes Quorum saves.\n- \`CLAUDE.md\` tells Claude Code how to work in here.\n\nLink notes with [[wikilinks]]. Nothing here leaves your Mac unless you turn sync on in Quorum.\n`,
  'index.md': `# Index\n\nOne line per note. Quorum starts here when it looks for an answer.\n\n- [[README]] - what this folder is and how it is organized\n`,
  'CLAUDE.md': `# ${name}\n\nThis folder is an Agent OS managed with Quorum. Notes are plain markdown with [[wikilinks]] and YAML frontmatter.\n\n## Layout\n\n- \`00-inbox/\` quick captures to sort later\n- \`01-daily/\` one note per day, \`YYYY-MM-DD.md\`\n- \`08-meetings/quorum/\` meeting notes written by Quorum (\`source: quorum\` in frontmatter)\n- \`index.md\` the catalog: add one line for every new note\n\n## Rules\n\n- Keep notes short and literal. Link related notes in a \`## Related\` section.\n- Never write secrets here.\n- Frontmatter \`confidential: personal\` keeps a note out of anything shared.\n`,
  '00-inbox/README.md': '# Inbox\n\nQuick captures. Sort them into real notes later.\n',
  '01-daily/README.md': '# Daily\n\nOne note per day, named `YYYY-MM-DD.md`.\n',
  '08-meetings/README.md': '# Meetings\n\nMeeting notes by app. Quorum saves into `quorum/`.\n',
  '.obsidian/app.json': '{}\n',
});

export function createVault(dir, name = 'My Agent OS') {
  mkdirSync(path.join(dir, '08-meetings', 'quorum'), { recursive: true });
  for (const [rel, text] of Object.entries(STARTER(name))) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, text);
  }
  return dir;
}

export const defaultVaultDir = () => path.join(homedir(), 'Documents', 'Quorum');

export function registerOnboarding({ ipcMain, settings, saveSettings, inspectBrain, connect, systemPreferences, shell, helperAsk, claudeStatus, log, hadSettings = false }) {
  // an install that already has settings is not a first run; mark it so the flag stays stable
  if (hadSettings && !settings.onboarded) { settings.onboarded = 'existing'; saveSettings(); }
  const permissions = async () => ({
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    // system audio has no Electron query; the helper reports it when capture starts
    audio: 'unknown',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'not-determined',
    calendar: await helperAsk('calStatus').then((r) => r?.status ?? 'unknown').catch(() => 'unknown'),
  });
  ipcMain.handle('onboarding-status', async () => ({
    firstRun: !settings.onboarded,
    defaultVaultDir: defaultVaultDir(),
    permissions: await permissions(),
    claude: await claudeStatus().catch(() => ({ installed: false })),
  }));
  ipcMain.handle('onboarding-create-vault', (_e, dir, name) => {
    const target = String(dir || defaultVaultDir());
    createVault(target, String(name || 'My Agent OS'));
    log('created Agent OS', target);
    return connect(inspectBrain(target));
  });
  ipcMain.handle('onboarding-open-permission', (_e, which) => { if (PANES[which]) shell.openExternal(PANES[which]); });
  ipcMain.handle('onboarding-request-microphone', () => systemPreferences.askForMediaAccess('microphone'));
  ipcMain.handle('onboarding-done', () => { settings.onboarded = new Date().toISOString(); saveSettings(); return true; });
}
