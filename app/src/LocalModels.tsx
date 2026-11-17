import { useEffect, useState } from 'react';
import type { ModelsStatus } from './quorum';
import { Row } from './controls';
import { IconDownload } from './icons';

// Settings > Memory: the state of the decision layer's model download, in the words main sends (decide/download.js)
export function LocalModelsCard() {
  const [s, setS] = useState<ModelsStatus | null>(null);
  useEffect(() => {
    window.quorum.modelsStatus().then(setS).catch(() => setS(null));
    return window.quorum.onModelsStatus(setS);
  }, []);
  if (!s || s.state === 'off') return null;
  return (
    <>
      <h3>Local models</h3>
      <div className="set-card">
        <Row icon={<IconDownload width={18} height={18} />} title={s.label}
          desc="Two small models that check pairs of notes on this Mac before Quorum asks Claude. Until they are ready, every check goes to Claude." />
      </div>
    </>
  );
}
