// The adapter contract every meeting-notes source fits. Granola set it; each new source is a manifest in catalog.js
// plus a module here that exports these functions, and the Connectors UI needs no change per source.
//
//   verify(mcp)            optional. Right after sign-in: throws a plain-language Error when this identity has no
//                          account at the source, so the token is dropped and the user is told to pick another.
//   sync({ mcp, existing, since, write, progress })
//                          required. Lists every meeting since `since`, skips ids in `existing` (a Set of source_id
//                          values already in the vault: first save wins), fetches the rest and calls
//                          write(fileName, markdown, meeting) for each. The markdown carries `source: <id>` and
//                          `source_id: <meeting id>` in its frontmatter. Reports progress({ phase, message, done,
//                          total, phaseStartedAt }) and returns { listed, imported, skipped, failed: [{ id, title, error }] }.
//   transcript(mcp, id)    optional, behind the `transcripts` extra. The whole transcript for one meeting as
//                          { text, recorder } or { text: null, unavailable: 'pending' | 'final' }.
//
// Extras are what a source can provide beyond its notes; a manifest lists them in `extras` and each has a setting
// on the connector's Settings tab, off by default. transcripts.js runs the transcript extra for any adapter that
// implements it.
import * as granola from './granola.js';

export const ADAPTERS = { granola };

export const EXTRAS = {
  transcripts: { method: 'transcript', label: 'Also import transcripts' },
};

export function adapterFor(src) {
  const a = ADAPTERS[src.adapter];
  if (!a || typeof a.sync !== 'function') throw new Error(`No adapter for source ${src.id}`);
  for (const x of src.extras ?? []) {
    const needs = EXTRAS[x]?.method;
    if (!needs || typeof a[needs] !== 'function') throw new Error(`Source ${src.id} lists extra ${x} but its adapter has no ${needs ?? x}()`);
  }
  return a;
}
