// how the quorum command reaches the running app: a Unix socket in Quorum's own folder that only this user can open, no network port
import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';

export function startControl(sockPath, handle, log) {
  rmSync(sockPath, { force: true });
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      if (buf.length > 1 << 20) { conn.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req;
        try { req = JSON.parse(line); } catch { conn.write(`${JSON.stringify({ error: 'bad request' })}\n`); continue; }
        Promise.resolve()
          .then(() => handle(req))
          .then((result) => conn.write(`${JSON.stringify({ ok: true, result: result ?? null })}\n`))
          .catch((e) => conn.write(`${JSON.stringify({ error: String(e?.message ?? e) })}\n`));
      }
    });
    conn.on('error', () => {});
  });
  server.on('error', (e) => log('control socket', e.message));
  server.listen(sockPath, () => chmodSync(sockPath, 0o600));
  return () => { server.close(); rmSync(sockPath, { force: true }); };
}
