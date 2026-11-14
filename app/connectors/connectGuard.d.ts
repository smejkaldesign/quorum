import type { ConnectorPolicy } from './approval';

export const CONNECT_CHANNELS: readonly string[];
export type ConnectGuard = { setPolicy(fn: () => Promise<ConnectorPolicy | null>): void; refusal(channel: string, id: unknown): Promise<string | null> };
export function createConnectGuard(): ConnectGuard;
export function guardIpc<T extends { handle: (channel: string, fn: (...args: never[]) => unknown) => unknown }>(ipcMain: T, guard: ConnectGuard): T;
