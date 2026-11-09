// Which edition this process runs. 'local' is the open-source default; 'cloud' adds the account, sync and members
// code under ee/. The value comes from QUORUM_EDITION in the environment (dev and CI), then from the quorumEdition
// field electron-builder writes into the packaged package.json (package:cloud), then falls back to 'local'.
// electron-builder packs ee/ into both editions (package.json build.files); in the local edition nothing imports it, so
// the files sit unused inside the asar.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function packagedEdition() {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).quorumEdition; } catch { return undefined; }
}

const raw = process.env.QUORUM_EDITION || packagedEdition();
export const EDITION = raw === 'cloud' ? 'cloud' : 'local';
export const isCloud = EDITION === 'cloud';

// Which environment this process runs (docs/open-source-strategy.md, "Environments and administration").
// 'development' is a copy started from a checkout (npm start): it keeps its own data folder and talks to the local
// Supabase stack or .env.development. 'production' is the installed build, which uses .env. QUORUM_ENV overrides
// either way. Outside Electron (scripts, the quorum CLI) nothing is packaged, so a missing QUORUM_ENV reads as
// production: those processes read the installed app's files.
const electronApp = process.versions.electron && process.type === 'browser' ? (await import('electron')).app : null;
const packaged = electronApp ? electronApp.isPackaged : true;
export const ENV = process.env.QUORUM_ENV === 'production' ? 'production' : process.env.QUORUM_ENV === 'development' ? 'development' : packaged ? 'production' : 'development';
export const isDevelopment = ENV === 'development';

// The folder for settings.json, auth.json, sync-ids.json, sessions, chats, attachments and the control socket.
// One per environment, so the development copy never reads or writes the installed app's data. main.js also points
// Electron's own userData here.
const appData = electronApp ? electronApp.getPath('appData') : path.join(homedir(), 'Library/Application Support');
export const DATA_DIR = path.join(appData, isDevelopment ? 'Quorum Dev' : 'Quorum');

// The only path into ee/ from the rest of the main process. The local edition resolves to null and never evaluates
// the module, so the files under ee/ can be absent or inert. scripts/check-edition-boundary.mjs rejects any other
// import of ee/ outside this file.
export function loadEE(file) {
  if (!isCloud) return Promise.resolve(null);
  return import(`./ee/${file}`);
}
