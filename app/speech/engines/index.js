import * as assemblyai from './assemblyai.js';
import * as deepgram from './deepgram.js';

export const ENGINES = { assemblyai, deepgram };
export const engineFor = (name) => ENGINES[name] ?? null;
