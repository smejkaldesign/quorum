export const ZOOM_MY_NOTES_STEPS: string[];
export const ZOOM_WEB_SETTINGS: string;
export const MANUAL_STEPS: string;
export const STOP_MY_NOTES: string;
export function joinAdvice(opts: { platform: string | null; zoom?: { connected: boolean; myNotes?: { seenAt: string | null; confirmedAt: string | null } } | null; blocked?: boolean; dismissed?: { zoom?: boolean; manual?: boolean }; now?: number }): { kind: 'zoom' | 'manual' | 'blocked'; message: string; detail: string; settingsUrl: string | null } | null;
