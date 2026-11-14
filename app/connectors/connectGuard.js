// The main process's check before any connect (migration 0030, "approved connectors only"). Every channel that starts a
// connection goes through it: oauth-connect (personal OAuth, Google Calendar included), source-connect (meeting-notes
// sources over MCP, which Onboarding also calls) and platform-connect (a meeting app's cloud import). The renderer hides
// what the workspace did not approve; this refuses it again here, so no screen can start a connect the policy forbids.
//
// The policy comes from the hosted edition (ee/integrations.js sets it). The local edition never sets one, so nothing is
// refused there.
import { connectorsFor } from './library.js';
import { ORG_SENTENCE, approvalOf, BLOCKED_SENTENCE } from './approval.js';

const LIST = connectorsFor({ meetingCapture: false });
// each connect channel's first argument names a source, a platform or a library connector; this finds the connector
const CHANNELS = {
  'oauth-connect': (id) => LIST.find((x) => x.id === id) ?? null,
  'source-connect': (id) => LIST.find((x) => x.kind === 'mcp-source' && x.source === id) ?? null,
  'platform-connect': (id) => LIST.find((x) => x.kind === 'meeting-app' && x.app === id) ?? null,
};
export const CONNECT_CHANNELS = Object.keys(CHANNELS);

export function createConnectGuard() {
  let policy = async () => null;
  return {
    // fn returns the current ConnectorPolicy (connectors/approval.js) or null
    setPolicy(fn) { policy = typeof fn === 'function' ? fn : async () => null; },
    // null when the connect may go ahead, else the sentence to show
    async refusal(channel, id) {
      const find = CHANNELS[channel];
      if (!find) return null;
      const x = find(String(id ?? ''));
      if (!x) return null;
      // a policy that cannot be read leaves the connect alone; ee/integrations.js answers with the last known one first
      const p = await Promise.resolve().then(policy).catch(() => null);
      // connected is false here: a connect starts a new connection, which an unapproved connector may not have
      const a = approvalOf(x, p, false);
      if (a === 'blocked') return BLOCKED_SENTENCE;
      if (a === 'org') return ORG_SENTENCE(x.name);
      return null;
    },
  };
}

// ipcMain as the connect handlers see it: handle() on a connect channel runs the guard first and answers { error } on a
// refusal; every other channel passes through unchanged
export function guardIpc(ipcMain, guard) {
  return new Proxy(ipcMain, {
    get(target, prop) {
      if (prop !== 'handle') return Reflect.get(target, prop);
      return (channel, fn) => {
        if (!CHANNELS[channel]) return target.handle(channel, fn);
        return target.handle(channel, async (e, ...args) => {
          const no = await guard.refusal(channel, args[0]);
          if (no) return { error: no };
          return fn(e, ...args);
        });
      };
    },
  });
}
