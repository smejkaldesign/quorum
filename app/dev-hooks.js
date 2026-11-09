// Development-only hooks. main.js imports this module only when app.isPackaged is false, so a release build never
// reads these variables and never runs code taken from the environment.
//   QUORUM_EVAL=<js>                    run a snippet in the panel after load, e.g. to open a view for a screenshot
//   QUORUM_DEMO_BLOCKED=1               show the off-for-this-call top bar without a real call
//   QUORUM_DEMO_END=<transcript.json>   run the real end-of-call path on a sample transcript, no Zoom needed
//   QUORUM_SHOT=a.png:4000,b.png:9000   screenshot only Quorum's own window (never the rest of the screen) after each delay in ms
//   QUORUM_SELFTEST=1                   press Start after load and log transcript DOM counts every 4s
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function install({ win, meeting, toUI, log, endMeeting, sessionsDir, userName }) {
  const env = process.env;
  const afterLoad = (ms, fn) => win.webContents.once('did-finish-load', () => setTimeout(fn, ms));
  if (env.QUORUM_EVAL) afterLoad(2500, () => win.webContents.executeJavaScript(env.QUORUM_EVAL));
  if (env.QUORUM_DEMO_BLOCKED) afterLoad(2000, () => toUI('state', { phase: 'blocked' }));
  if (env.QUORUM_DEMO_END) {
    afterLoad(2000, () => {
      Object.assign(meeting, {
        armed: true, capturing: false, id: `demo-${Date.now()}`, title: `${userName}'s Zoom Meeting`, participants: 3,
        startedAt: new Date(Date.now() - 23 * 60000), dir: path.join(sessionsDir, 'demo'),
        transcript: JSON.parse(readFileSync(env.QUORUM_DEMO_END, 'utf8')),
      });
      mkdirSync(meeting.dir, { recursive: true });
      endMeeting();
    });
  }
  if (env.QUORUM_SHOT) {
    for (const pair of env.QUORUM_SHOT.split(',')) {
      const [file, delay] = pair.split(':');
      setTimeout(() => win.webContents.capturePage().then((img) => writeFileSync(file, img.toPNG())), Number(delay) || 5000);
    }
  }
  if (env.QUORUM_SELFTEST) {
    afterLoad(1500, () => win.webContents.executeJavaScript(`document.querySelector('.start button').click()`));
    setInterval(() => win.webContents.executeJavaScript(`[document.querySelectorAll('.transcript p:not(.empty)').length, document.querySelector('.pill')?.textContent]`).then((r) => log('selftest dom', JSON.stringify(r))), 4000);
  }
}
