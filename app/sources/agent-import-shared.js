// The parts of agent-import.js the renderer needs. No Node imports here: the Connectors page loads this file, and
// scripts/check-edition-boundary.mjs fails the build if anything the renderer reaches imports a Node built-in.
export const SCHEDULES = ['off', 'hourly', 'daily'];

// what the person gives up compared with a direct connection; the Connectors page lists these next to the button
export const TRADEOFFS = (runner, source) => [
  `Spends your ${runner} model tokens: the agent reads every meeting it imports.`,
  `Each note passes through a model, so wording can change and details can be dropped. A direct connection copies ${source}'s notes as they are.`,
  'Runs once when you ask, or on the schedule you pick, only while Quorum is open.',
  `Depends on ${runner} staying signed in to ${source}. If its sign-in expires, the import stops until you sign in there again.`,
];
