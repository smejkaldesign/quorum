// The providers the sync worker can read. Each one is { id, where, sourceOf(file), unchanged(note, file),
// list({ token, attachment, cursor, fetchImpl, sleep }) -> { files, complete, cursor } | { unchanged: true, cursor },
// read({ token, attachment, file, fetchImpl, sleep }) -> text }. A new provider (Notion pages, for one) adds a module
// here and its grant refresh in ../tokens.js, and the 0032 provider checks allow its id.
import { github } from './github.js';
import { googleDrive } from './googleDrive.js';

export const PROVIDERS = { [googleDrive.id]: googleDrive, [github.id]: github };
