export type NoteJunk = { reason: string };
export function junkOf(note: { title?: string; body?: string; hasRecording?: boolean; hasTranscript?: boolean }): NoteJunk | null;
export function plainText(text: string): string;
export function wordOf(token: string): 'real' | 'junk' | 'unsure' | 'url' | null;
