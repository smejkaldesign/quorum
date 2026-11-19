// The bulk banner's text once a batch ends (LinkHealth.tsx BatchBanner). Each item is fixed, failed on its own with a
// reason, or rolled back: fixed, then put back because a failure the batch could not keep to one item undid it.
// The counts say which happened, and a single failure is named.
export type BatchEnd = { title: string; status: string; error?: string | null; rolledBack?: boolean };

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

export function batchSummary(xs: BatchEnd[]): string {
  const ok = xs.filter((x) => x.status === 'success').length;
  const back = xs.filter((x) => x.status === 'error' && x.rolledBack).length;
  const failed = xs.filter((x) => x.status === 'error' && !x.rolledBack);
  const one = failed.length === 1 ? `: “${failed[0].title}”` : '';
  if (back) return `Fixed 0 of ${xs.length}. Quorum put back the ${items(back)} it had fixed${failed.length ? `, and ${failed.length} could not be fixed${one}` : ''}`;
  return `Fixed ${ok} of ${xs.length}${failed.length ? `. ${failed.length} could not be fixed${one}` : ''}`;
}
