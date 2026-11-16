#!/usr/bin/env node
// Check everything now on an existing install: asks the running app (Quorum or Quorum Dev) over its local socket to
// estimate, start, show or cancel a catch-up pass (memoryCatchup.js). The pass writes nothing to the vault; what it
// finds waits in Needs review. Starting it turns on Let the agent draft fixes when it is off.
//
//   node scripts/memory-catchup.mjs [estimate|start|status|cancel] [--dev]
//
// --dev talks to Quorum Dev (the app node dev-app.cjs runs); without it, the installed Quorum.
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const dev = args.includes('--dev') || process.env.QUORUM_ENV === 'development';
const action = args.find((a) => !a.startsWith('--')) ?? 'status';
if (!['estimate', 'start', 'status', 'cancel'].includes(action)) { console.error('usage: node scripts/memory-catchup.mjs [estimate|start|status|cancel] [--dev]'); process.exit(2); }
const home = path.join(homedir(), 'Library/Application Support', dev ? 'Quorum Dev' : 'Quorum');

const sock = net.connect(path.join(home, 'quorum.sock'));
let buf = '';
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(`${JSON.stringify({ cmd: 'memory-catchup', args: { action } })}\n`));
sock.on('data', (d) => {
  buf += d;
  const i = buf.indexOf('\n');
  if (i < 0) return;
  sock.end();
  const r = JSON.parse(buf.slice(0, i));
  if (r.error) { console.error(r.error); process.exit(1); }
  const v = r.result;
  if (action === 'estimate' && v) console.log(`${v.notes} notes; ${v.read} to read in ${v.claimCalls} claim calls, plus ${v.draftCalls} draft calls: about ${v.calls} calls`);
  else if (v?.running) console.log(`Checking all ${v.notes} notes: ${v.done} of ${v.total} calls${v.turnedOn ? '. Let the agent draft fixes is now on' : ''}`);
  else console.log(JSON.stringify(v));
});
sock.on('error', () => { console.error(`${dev ? 'Quorum Dev' : 'Quorum'} isn't open. Open the app, then try again.`); process.exit(1); });
