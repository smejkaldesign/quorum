import type { KbSyncAttachment, KbSyncGrant } from '../../src/quorum';
import { parseGithubUrl } from '../githubUrl';

// What the synced-folders panel says about each attachment (ee/kbSync.js, migration 0032). Pure, so the sentences are
// tested without a renderer.

export type SyncTone = 'ok' | 'busy' | 'paused' | 'warn';

export const providerName = (p: string): string => (p === 'github' ? 'GitHub' : p === 'google-drive' ? 'Google Drive' : p);

// one status per row, as the connector rows have: what the worker last reported, in words
export function syncStatus(a: Pick<KbSyncAttachment, 'status' | 'connected' | 'last_synced_at' | 'paused_by'>): { label: string; tone: SyncTone } {
  if (a.status === 'paused') return { label: a.paused_by === 'plan' ? 'Paused, plan ended' : 'Paused', tone: 'paused' };
  if (a.status === 'needs_auth' || !a.connected) return { label: 'Needs attention', tone: 'warn' };
  if (a.status === 'error') return { label: 'Needs attention', tone: 'warn' };
  if (a.status === 'pending') return { label: a.last_synced_at ? 'Sync queued' : 'Waiting for the first sync', tone: 'busy' };
  return { label: 'In sync', tone: 'ok' };
}

// "just now", "5 minutes ago", "3 hours ago", "2 days ago", else the date
export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const lastSynced = (a: Pick<KbSyncAttachment, 'last_synced_at'>, now?: number): string => (a.last_synced_at ? `Last synced ${ago(a.last_synced_at, now)}` : 'Not synced yet');

// where the content comes from: "Folder in Google Drive", "File in Google Drive", "owner/repo on main, docs folder"
export function remoteLine(a: Pick<KbSyncAttachment, 'provider' | 'remote_kind' | 'remote_id' | 'options' | 'account'>): string {
  if (a.provider === 'github') {
    const branch = a.options?.branch ? ` on ${a.options.branch}` : ' on the default branch';
    const folder = a.options?.path ? `, ${a.options.path} folder` : '';
    return `${a.remote_id}${branch}${folder}`;
  }
  const kind = a.remote_kind === 'folder' ? 'Folder' : 'File';
  return `${kind} in ${providerName(a.provider)}${a.account ? `, ${a.account}` : ''}`;
}

export const noteCount = (n: number): string => (n === 1 ? '1 note' : `${n} notes`);

// which actions a row offers: Sync now while it runs or failed, Resume while an admin paused it, Pause otherwise;
// Remove always. A pause because the workspace's plan ended lifts itself when the plan is active again
export function syncActions(a: Pick<KbSyncAttachment, 'status' | 'connected' | 'paused_by'>): { syncNow: boolean; pause: boolean; resume: boolean } {
  const paused = a.status === 'paused';
  return { syncNow: !paused && a.connected && a.status !== 'needs_auth', pause: !paused, resume: paused && a.paused_by !== 'plan' };
}

// a GitHub address the relay can sync, read by the parser the main process uses (ee/githubUrl.js)
export function checkRepoUrl(url: string): string | null {
  const r = parseGithubUrl(url);
  return r.error ?? null;
}

// a relay grant on Settings, Connections: its name, and one line on its account and the synced folders using it
export const grantLabel = (g: Pick<KbSyncGrant, 'provider'>): string => `${providerName(g.provider)} (synced folders)`;
export function grantLine(g: Pick<KbSyncGrant, 'account' | 'attachments'>): string {
  const n = g.attachments.length;
  const used = n === 0 ? 'No synced folder uses it' : n === 1 ? `Used by ${g.attachments[0].name}` : `Used by ${n} synced folders`;
  return g.account ? `${g.account} · ${used}` : used;
}
