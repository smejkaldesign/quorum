export type EditParts = { head: string; body: string; tail: string; fm: string; eol: '\n' | '\r\n'; mixed: boolean };
export function editParts(raw: string): EditParts;
export function withBody(raw: string, body: string): string;
