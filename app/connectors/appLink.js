// Links that bring this copy of Quorum forward on a connector's page, e.g. from the browser tab a sign-in ends on.
// The installed app owns quorum:// (package.json build.protocols); a development copy answers on quorum-dev://
// (dev-app.cjs declares it), so a link from a dev sign-in returns to the dev copy and never opens the installed app.
// Pure, shared by the main process and the loopback page in sources/oauth.js.
import { CONNECTOR_BY_ID } from './library.js';

export const appScheme = (packaged) => (packaged ? 'quorum' : 'quorum-dev');

// the scheme the loopback page links back to; main.js sets it once at start-up
let current = 'quorum';
export const setLinkScheme = (scheme) => { current = scheme; };
export const linkScheme = () => current;

// a connector's page, or with no id the Connectors list
export const connectorLink = (id, scheme = current) => (id ? `${scheme}://connectors/${encodeURIComponent(id)}` : `${scheme}://connectors`);

// what a connectors link opens: { id } for a connector's page, { id: null } for the list, or null for another route,
// another scheme or an id the library does not know
export function connectorRoute(url, scheme = current) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/connectors(?:\/([^/?#]*))?\/?(?:[?#].*)?$/i.exec(String(url ?? ''));
  if (!m || m[1].toLowerCase() !== scheme) return null;
  if (!m[2]) return { id: null };
  let id;
  try { id = decodeURIComponent(m[2]); } catch { return null; }
  return Object.hasOwn(CONNECTOR_BY_ID, id) ? { id } : null;
}
export const parseConnectorLink = (url, scheme = current) => connectorRoute(url, scheme)?.id ?? null;
