// first run on a fresh install: create an Agent OS folder when the user has none, report what the Mac has granted,
// and open the right System Settings pane. The wizard in the window drives these; settings.onboarded ends it
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SUGGEST_SYSTEM, parseSuggestion, plan, readSetup, rerunSetup, suggestPrompt, writeStarter } from './starter.js';

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

export function registerOnboarding({ ipcMain, settings, saveSettings, inspectBrain, connect, systemPreferences, shell, helperAsk, axTrusted, pickDir, claudeStatus, modelStatus, log, hadSettings = false, runText = null, hasModel = () => false, owner = () => '', about = () => '' }) {
  // an install that already has settings is not a first run; mark it so the flag stays stable
  if (hadSettings && !settings.onboarded) { settings.onboarded = 'existing'; saveSettings(); }
  const within = (ms, p, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  // each permission answers on its own clock, so one slow check cannot turn the others into "unknown"
  const permissions = async () => {
    const [accessibility, calendar] = await Promise.all([
      // the helper is the process that reads the meeting chat, so its trust is the one that counts; Electron's own answer is the fallback
      within(3000, axTrusted(), null).then((t) => (t == null ? systemPreferences.isTrustedAccessibilityClient(false) : t) ? 'granted' : 'not-determined'),
      within(3000, helperAsk('calStatus').then((r) => r?.status ?? 'unknown'), 'unknown').catch(() => 'unknown'),
    ]);
    // system audio has no Electron query; the helper reports it when capture starts
    return { microphone: systemPreferences.getMediaAccessStatus('microphone'), audio: 'unknown', accessibility, calendar };
  };
  // status answers at once so the window knows whether to show the wizard; the slow checks come separately
  ipcMain.handle('onboarding-status', () => ({ firstRun: !settings.onboarded, defaultVaultDir: defaultVaultDir() }));
  // the permissions alone, for the wizard's poll after Allow; no Claude Code run and no model probe each time
  ipcMain.handle('onboarding-permissions', async () => ({ permissions: await permissions() }));
  ipcMain.handle('onboarding-checks', async () => ({
    permissions: await permissions(),
    claude: await within(15000, claudeStatus().catch(() => ({ installed: false })), { installed: false, pending: true }),
    model: await within(4000, modelStatus().catch(() => null), null),
  }));
  // with interview answers the folder is shaped around the person (starter.js); without them it is the plain starter
  ipcMain.handle('onboarding-create-vault', (_e, dir, name, answers = null) => {
    const target = String(dir || defaultVaultDir());
    const title = String(name || 'My Agent OS');
    if (answers && typeof answers === 'object') {
      const p = plan({ name: title, answers });
      writeStarter(target, p);
      log('created Agent OS', target, 'template', p.answers.template);
    } else {
      createVault(target, title);
      log('created Agent OS', target);
    }
    const b = connect(inspectBrain(target));
    settings.brainMade = 'quorum';
    saveSettings();
    return { ...b, made: 'quorum' };
  });
  // prefill for the interview from the person's own model source; nothing when none is chosen, and a slow or odd
  // answer is just no prefill
  // one model call per app run: concurrent askers share it and later askers get the same answer
  let suggesting = null;
  ipcMain.handle('onboarding-setup-suggest', () => {
    if (!runText || !hasModel()) return { available: false };
    suggesting ??= (async () => {
      try {
        const out = await within(40000, runText(suggestPrompt({ owner: owner(), about: about() }), SUGGEST_SYSTEM), null);
        return { available: true, suggestion: out == null ? null : parseSuggestion(out) };
      } catch (e) {
        log('setup suggestion failed', e?.message || e);
        return { available: true, suggestion: null };
      }
    })();
    return suggesting;
  });
  // the saved answers of a Quorum-built folder, and the interview again on the connected folder
  ipcMain.handle('setup-read', () => (settings.brainRoot ? readSetup(settings.brainRoot) : null));
  ipcMain.handle('setup-rerun', (_e, answers) => {
    if (!settings.brainRoot || !existsSync(settings.brainRoot)) throw new Error('No Agent OS folder is connected');
    const prev = readSetup(settings.brainRoot);
    const name = prev?.name || inspectBrain(settings.brainRoot).name || 'My Agent OS';
    const r = rerunSetup(settings.brainRoot, { name, answers: answers ?? {} });
    log('setup re-run', settings.brainRoot, r.written.length, 'new files');
    return { ...inspectBrain(settings.vaultPath || settings.brainRoot), made: settings.brainMade ?? null, written: r.written };
  });
  ipcMain.handle('onboarding-open-permission', (_e, which) => { if (PANES[which]) shell.openExternal(PANES[which]); });
  // where a new Agent OS goes: a folder the user picks or creates in the dialog; null when they cancel
  ipcMain.handle('onboarding-pick-dir', () => pickDir());
  ipcMain.handle('onboarding-request-microphone', () => systemPreferences.askForMediaAccess('microphone'));
  ipcMain.handle('onboarding-done', () => { settings.onboarded = new Date().toISOString(); saveSettings(); return true; });
}
