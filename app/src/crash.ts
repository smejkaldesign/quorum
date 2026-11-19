// a view that fails again within REPEAT_MS of Reload view fails on every draw, so the crash page stops advising a reload
export const REPEAT_MS = 5000;
export const failsEveryTime = (reloadedAt: number | null, errorAt: number) => reloadedAt != null && errorAt >= reloadedAt && errorAt - reloadedAt < REPEAT_MS;
