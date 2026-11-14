// The KB sync worker on its own (a second Railway service with start command `node relay/kbSyncWorker.js`), for when
// syncing should not share CPU with live transcription. It needs only SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY and the OAuth client pairs; run it with KB_SYNC_WORKER off on the main relay so one
// process schedules the loop (two would still be safe: claims are leased).
import { makeClients } from './lib/auth.js';
import { config } from './lib/config.js';
import { log } from './lib/log.js';
import { createKbSyncWorker } from './kbSync/worker.js';

const missing = ['supabaseUrl', 'supabaseAnonKey', 'supabaseServiceRoleKey'].filter((k) => !config[k]);
if (missing.length) throw new Error(`kb sync worker: missing ${missing.map((k) => k.replace(/([A-Z])/g, '_$1').toUpperCase()).join(', ')}`);
const worker = createKbSyncWorker({ db: makeClients().db, config, log });
worker.start();
const stop = async () => { log('stopping'); await worker.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
