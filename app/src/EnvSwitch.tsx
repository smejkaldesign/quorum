import { useEffect, useState } from 'react';
import type { EnvStatus } from './quorum';
import { Row, Toggle } from './controls';
import { IconCode } from './icons';

// The developer switch (docs/self-hosting.md, Development). A development copy normally talks to the local Supabase
// stack or .env.development; this toggle makes it load the production .env instead, with a warning while it is on.
// Renders nothing in production builds and in the local edition, which has no cloud config.
export function EnvSwitch() {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.quorum.envStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  if (!status || status.env !== 'development' || status.config === 'none') return null;

  const set = async (on: boolean) => {
    setBusy(true);
    try { setStatus(await window.quorum.envSetProduction(on)); } catch {} finally { setBusy(false); }
  };
  const where = status.useProduction
    ? `Production project at ${status.host ?? 'an unconfigured URL'}`
    : status.config === 'local' ? `Local Supabase stack at ${status.host}`
    : status.config === 'shell' ? `Shell variables point at ${status.host}`
    : `.env.development points at ${status.host}`;

  return (
    <>
      <h3>Developer</h3>
      <div className="set-card">
        <Row icon={<IconCode width={18} height={18} />} title="Use production data" desc={where}>
          <Toggle on={status.useProduction} onChange={set} disabled={busy} />
        </Row>
        {status.useProduction && <p className="set-error" style={{ fontWeight: 600 }}>Connected to production</p>}
      </div>
    </>
  );
}
