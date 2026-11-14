// The member's connection report for workspace connectors (migration 0030 member_integrations): Connections tells the
// workspace which governed connectors this member has connected, so the admin page can count them. A list counts as
// sent only once the workspace accepted it ({ ok: true }); a failed send is tried again on the next flush (focus, the
// periodic refresh, or the next report), and reset() sends again after a workspace switch.
export type ReportSend = (ids: string[]) => Promise<{ ok?: boolean } | null | undefined>;

export function createReporter(send: ReportSend) {
  let sent: string | null = null;
  let wanted: string[] | null = null;
  let sending = false;
  const flush = (): void => {
    const list = wanted;
    if (!list || sending) return;
    const key = [...list].sort().join(',');
    if (sent === key) return;
    sending = true;
    send(list)
      .then((r) => { if (r?.ok === true) sent = key; })
      .catch(() => {})
      .finally(() => { sending = false; if (wanted !== list) flush(); });
  };
  return {
    report(ids: string[]) { wanted = ids; flush(); },
    flush,
    reset() { sent = null; flush(); },
  };
}
