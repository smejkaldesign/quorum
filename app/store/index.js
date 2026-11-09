// the one storage interface the app calls (docs/backend-plan.md). Local files are always the store; the cloud
// edition layers pushes on top through ee/sync.js once an account is signed in and sync is on in settings
import local from './local.js';
import { loadEE } from '../edition.js';

export const backend = 'local';

// the hosted store module (ee/store/remote.js), loaded through edition.js so the local edition never evaluates it;
// resolves to null in the local edition
export const remote = () => loadEE('store/remote.js');

export default local;
