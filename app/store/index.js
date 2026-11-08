// the one storage interface the app calls (docs/backend-plan.md). Local files unless sync is on in settings and the
// Supabase env is set; remote.js is only loaded on that path, so the default run never touches it
import local from './local.js';

const { QUORUM_SUPABASE_URL: url, QUORUM_SUPABASE_ANON_KEY: key } = process.env;
const remote = url && key && local.settings.get().sync === true;
const store = remote ? (await import('./remote.js')).createRemote({ url, key }) : local;
export const backend = remote ? 'remote' : 'local';

export default store;
