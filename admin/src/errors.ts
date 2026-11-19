// The Errors page's data and the two hand-offs it builds from a group: a prompt to paste into a coding agent and a
// prefilled GitHub issue link. Pure functions, so the tests read them without a project.
export type ErrorStatus = 'new' | 'fixing' | 'fixed' | 'ignored';
export const ERROR_STATUSES: readonly ErrorStatus[] = ['new', 'fixing', 'fixed', 'ignored'];
export const ERROR_STATUS_LABEL: Record<ErrorStatus, string> = { new: 'New', fixing: 'Fixing', fixed: 'Fixed', ignored: 'Ignored' };
export type ErrorSort = 'last_seen' | 'installs';
export type ErrorCounts = Record<ErrorStatus, number>;

export type ErrorGroup = {
  fingerprint: string; message: string; view: string; firstSeen: string; lastSeen: string; events: number; installs: number; repeats: number;
  versions: string[]; editions: string[]; latestStack: string; latestComponentStack: string; status: ErrorStatus; fixedIn: string | null; note: string | null; updatedAt: string;
  // the 90-day purge cleared the message and stacks of this stale fixed or ignored group
  purged: boolean;
};
export type ErrorEvent = { id: number; workspaceId: string | null; edition: string; version: string; os: string; view: string; kind: string; repeat: boolean; message: string; at: string; receivedAt: string };
export type ErrorDetail = { group: ErrorGroup; oses: string[]; events: ErrorEvent[] };

export const REPO = 'smejkaldesign/quorum';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown) => Number(v) || 0;
const status = (v: unknown): ErrorStatus => (ERROR_STATUSES.includes(v as ErrorStatus) ? (v as ErrorStatus) : 'new');

export const shapeErrorGroup = (g: Record<string, unknown>): ErrorGroup => ({
  fingerprint: str(g.fingerprint), message: str(g.message), view: str(g.view), firstSeen: str(g.first_seen), lastSeen: str(g.last_seen),
  events: num(g.events), installs: num(g.installs), repeats: num(g.repeats), versions: strs(g.versions), editions: strs(g.editions),
  latestStack: str(g.latest_stack), latestComponentStack: str(g.latest_component_stack), status: status(g.status),
  fixedIn: str(g.fixed_in) || null, note: str(g.note) || null, updatedAt: str(g.updated_at),
  purged: g.message === null && g.latest_stack === null,
});
export const shapeErrorEvent = (e: Record<string, unknown>): ErrorEvent => ({
  id: num(e.id), workspaceId: str(e.workspace_id) || null, edition: str(e.edition), version: str(e.version), os: str(e.os), view: str(e.view),
  kind: str(e.kind), repeat: e.repeat === true, message: str(e.message), at: str(e.at), receivedAt: str(e.received_at),
});
export function shapeErrorDetail(d: unknown): ErrorDetail {
  const o = (d ?? {}) as Record<string, unknown>;
  return { group: shapeErrorGroup((o.group ?? {}) as Record<string, unknown>), oses: strs(o.oses), events: (Array.isArray(o.events) ? o.events : []).map((e) => shapeErrorEvent(e as Record<string, unknown>)) };
}
export const shapeErrorCounts = (d: unknown): ErrorCounts => { const o = (d ?? {}) as Record<string, unknown>; return { new: num(o.new), fixing: num(o.fixing), fixed: num(o.fixed), ignored: num(o.ignored) }; };

// a group that fails again right after Reload view is broken for the person, so the list says so first
export const brokenOnReload = (g: Pick<ErrorGroup, 'repeats'>) => g.repeats > 0;
// a new group that still carries a fixed version came back after that fix shipped
export const regressed = (g: Pick<ErrorGroup, 'status' | 'fixedIn'>) => g.status === 'new' && !!g.fixedIn;
export const statusLine = (g: Pick<ErrorGroup, 'status' | 'fixedIn'>) => (g.status === 'fixed' && g.fixedIn ? `Fixed in ${g.fixedIn}` : ERROR_STATUS_LABEL[g.status]);

// the form's version for Fixed, the way the database accepts it
export const FIXED_IN = /^v?\d{1,9}(\.\d{1,9}){0,2}([-+][0-9A-Za-z.-]{1,30})?$/;
export const NOTE_MAX = 2000;
export function validateStatusForm(input: { status: ErrorStatus; fixedIn: string; note: string }): { draft: { status: ErrorStatus; fixedIn: string | null; note: string | null } } | { error: string } {
  const fixedIn = input.fixedIn.trim();
  const note = input.note.trim();
  if (input.status === 'fixed' && !FIXED_IN.test(fixedIn)) return { error: 'Fixed needs the version the fix ships in, like 0.4.3.' };
  if (note.length > NOTE_MAX) return { error: `The note is at most ${NOTE_MAX} characters.` };
  return { draft: { status: input.status, fixedIn: input.status === 'fixed' ? fixedIn : null, note: note || null } };
}

const firstLine = (s: string) => s.split('\n')[0].trim();
export const issueTitle = (g: Pick<ErrorGroup, 'message' | 'view'>) => {
  const msg = firstLine(g.message) || 'Page crash';
  return `Crash in ${g.view || 'an unknown view'}: ${msg.length > 120 ? `${msg.slice(0, 117)}...` : msg}`;
};
const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''") || '(none)'}\n\`\`\``;

// the facts both hand-offs share: what broke, where, how often, on which builds, and the stacks
function facts(d: ErrorDetail, { stackMax }: { stackMax: number }): string[] {
  const g = d.group;
  const clip = (s: string) => (s.length > stackMax ? `${s.slice(0, stackMax)}\n... (cut)` : s);
  return [
    `Error: ${g.message || '(no message)'}`,
    `View: ${g.view || '(unknown)'}`,
    `Seen: ${g.events} ${g.events === 1 ? 'time' : 'times'} on ${g.installs} ${g.installs === 1 ? 'install' : 'installs'}, first ${g.firstSeen}, last ${g.lastSeen}`,
    `Versions: ${g.versions.join(', ') || '(unknown)'}`,
    `Editions: ${g.editions.join(', ') || '(unknown)'}`,
    `OS: ${d.oses.join('; ') || '(unknown)'}`,
    ...(brokenOnReload(g) ? [`Broken on reload: the view failed again within 5 seconds of Reload view ${g.repeats} ${g.repeats === 1 ? 'time' : 'times'}.`] : []),
    ...(regressed(g) ? [`Regression: this was marked fixed in ${g.fixedIn} and came back on that version or a newer one.`] : []),
    `Fingerprint: ${g.fingerprint}`,
    '',
    'Stack (latest event):',
    fence(clip(g.latestStack)),
    '',
    'React component stack (latest event):',
    fence(clip(g.latestComponentStack)),
  ];
}

// a prompt a coding agent can act on with nothing else: the facts, how to reach the view, and what to hand back
export function agentPrompt(d: ErrorDetail): string {
  const g = d.group;
  return [
    `A page in the Quorum desktop app crashes while rendering. Fix it in the ${REPO} repository.`,
    '',
    ...facts(d, { stackMax: 8000 }),
    '',
    'How to reproduce:',
    `1. Run the desktop app from app/ (both editions use the same pages) and open the "${g.view || 'root'}" view. The view id names the page: the part before the slash is the window or section, the part after it is the page.`,
    `2. Read the stack: the top frames name the source file and line that threw. Work out which state reaches that line with the value the message describes (an empty list, a missing field, a setting from an older version).`,
    '3. Put the app in that state and confirm the page crashes before you change anything.',
    '',
    'What to do:',
    '- Find the cause and fix it where the bad value starts. Another error boundary around the page does not count as a fix.',
    '- Add a test that fails without the fix and passes with it, in the style of the tests next to the file you change.',
    "- Run the app's typecheck and tests.",
    `- Open a draft pull request in ${REPO} that names this fingerprint and explains the cause in one or two sentences.`,
  ].join('\n');
}

export function issueBody(d: ErrorDetail): string {
  return ['Reported automatically by the Quorum app and grouped on the admin Errors page.', '', ...facts(d, { stackMax: 3000 }), '', `Steps: open the "${d.group.view || 'root'}" view in the desktop app; the stack names the file and line that threw.`].join('\n');
}

// a prefilled new-issue link; the body is cut so the URL stays under the length GitHub accepts
export const ISSUE_URL_MAX = 7500;
export function githubIssueUrl(d: ErrorDetail): string {
  const base = `https://github.com/${REPO}/issues/new`;
  const build = (body: string) => `${base}?${new URLSearchParams({ title: issueTitle(d.group), body, labels: 'bug' }).toString()}`;
  let body = issueBody(d);
  let url = build(body);
  while (url.length > ISSUE_URL_MAX && body.length > 200) {
    body = `${body.slice(0, Math.floor(body.length * 0.8))}\n... (cut; the full stack is on the admin Errors page)`;
    url = build(body);
  }
  return url;
}

// the audit log's lines for this page. The rows name a group by fingerprint only, so no report text outlives the
// 90-day purge; the line shows the first 8 characters
export function errorAuditLine(action: string, d: Record<string, unknown>): string | null {
  const what = typeof d.fingerprint === 'string' && d.fingerprint ? `error group ${d.fingerprint.slice(0, 8)}` : 'an error group';
  if (action === 'error_status') return d.status === 'fixed' ? `Marked ${what} fixed in ${String(d.fixed_in ?? '?')}` : `Marked ${what} ${ERROR_STATUS_LABEL[status(d.status)].toLowerCase()}`;
  if (action === 'error_reopened') return `${what[0].toUpperCase()}${what.slice(1)} came back in ${String(d.version || 'a new version')} after the fix in ${String(d.fixed_in ?? '?')}`;
  return null;
}
