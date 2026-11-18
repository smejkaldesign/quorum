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

export const connectorLink = (id, scheme = current) => `${scheme}://connectors/${encodeURIComponent(id)}`;

// the connector a link names, or null for another route, another scheme or an id the library does not know
export function parseConnectorLink(url, scheme = current) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/connectors\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(String(url ?? ''));
  if (!m || m[1].toLowerCase() !== scheme) return null;
  let id;
  try { id = decodeURIComponent(m[2]); } catch { return null; }
  return Object.hasOwn(CONNECTOR_BY_ID, id) ? id : null;
}
