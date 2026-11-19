export type EditParts = { head: string; body: string; tail: string; fm: string; eol: '\n' | '\r\n'; mixed: boolean };
export function editParts(raw: string): EditParts;
export function withBody(raw: string, body: string): string;
export function withFrontmatter(raw: string, fm: string): string;
export function planSave(raw: string, p: { hash: string; body?: string; frontmatter?: string; withheld: boolean }): { conflict: true } | { error: string } | { text: string; propsError?: string };
