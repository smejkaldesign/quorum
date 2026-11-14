// imported first by main.js, so it runs before any other module does its start-up work. The write is synchronous
// because stdout to a pipe is asynchronous on macOS and process.exit would drop the line
import { app } from 'electron';
import { writeSync } from 'node:fs';
import argv from './argv.cjs';

const flag = argv.startupFlag(process.argv);
if (flag) {
  writeSync(1, argv.startupText(flag, app.getVersion()));
  process.exit(0);
}
