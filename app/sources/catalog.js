// Meeting sources: the tools that already record someone's meetings. One manifest per source; the Sources page lists
// them all and each note a source writes carries `source: <id>` and `source_id: <the meeting's id there>`, which is
// what every method dedupes on (first save wins). docs/specs/meeting-sources.md.
export const SOURCES = [
  {
    id: 'granola',
    name: 'Granola',
    kind: 'mcp',
    url: 'https://mcp.granola.ai/mcp',
    folder: 'granola',
    description: 'Notes and summaries from your Granola meetings, kept in sync while Quorum runs.',
    methods: ['connect', 'folder'],
    extras: ['transcripts'],
    recommended: 'connect',
    why: 'Keeps syncing and uses no model tokens.',
    adapter: 'granola',
  },
];

export const BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
// what the renderer gets: everything but the adapter name
export const publicManifest = ({ adapter, ...rest }) => rest;
