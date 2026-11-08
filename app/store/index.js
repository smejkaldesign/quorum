// the one storage interface the app calls (docs/backend-plan.md). Local files are always the store; the hosted
// edition layers pushes on top through sync.js once an account is signed in and sync is on in settings
import local from './local.js';

export const backend = 'local';

export default local;
