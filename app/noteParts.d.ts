export type NoteParts = { note: string; summary: string; split: boolean };
export function noteParts(body: string, hand: boolean): NoteParts;
export function joinParts(note: string, summary: string, was: { split: boolean }): string;
