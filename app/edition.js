// Which edition this process runs. 'local' is the open-source default; 'cloud' adds the account, sync and members
// code under ee/. The value comes from QUORUM_EDITION in the environment (dev and CI), then from the quorumEdition
// field electron-builder writes into the packaged package.json (package:cloud), then falls back to 'local'.
// electron-builder packs ee/ into both editions (package.json build.files); in the local edition nothing imports it, so
// the files sit unused inside the asar.
import { readFileSync } from 'node:fs';

function packagedEdition() {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).quorumEdition; } catch { return undefined; }
}

const raw = process.env.QUORUM_EDITION || packagedEdition();
export const EDITION = raw === 'cloud' ? 'cloud' : 'local';
export const isCloud = EDITION === 'cloud';

// The only path into ee/ from the rest of the main process. The local edition resolves to null and never evaluates
// the module, so the files under ee/ can be absent or inert. scripts/check-edition-boundary.mjs rejects any other
// import of ee/ outside this file.
export function loadEE(file) {
  if (!isCloud) return Promise.resolve(null);
  return import(`./ee/${file}`);
}
