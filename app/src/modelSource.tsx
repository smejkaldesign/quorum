import { useState } from 'react';
import type { ModelSource } from './quorum';

// shared by Settings › AI and the onboarding model step
export type KeyProvider = 'anthropic' | 'openai' | 'google';
export const KEY_PROVIDERS: KeyProvider[] = ['anthropic', 'openai', 'google'];
export const KEY_NAMES: Record<KeyProvider, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
// which provider a pasted key belongs to, from its prefix; null when the user has to say
export function detectProvider(key: string): KeyProvider | null {
  const k = key.trim();
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^sk-/.test(k)) return 'openai';
  if (/^AIza/.test(k)) return 'google';
  return null;
}
export const SOURCE_NAMES: Record<ModelSource, string> = { none: 'None', 'claude-code': 'Claude Code on this Mac', 'anthropic-api': 'Your own API key', local: 'Local model' };

// the key is checked with one tiny request, then saved to the Keychain; it never comes back to this window
export function ModelKey({ onDone }: { onDone: (ok: boolean) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    const r = await window.quorum.modelKeySet(key);
    setBusy(false);
    if (r.error) setError(r.error); else onDone(true);
  };
  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(false); } }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="mk-title">
        <h2 id="mk-title">Add your Anthropic API key</h2>
        <p>Paste a key from console.anthropic.com. Quorum keeps it in your Mac's Keychain and sends it only to Anthropic.</p>
        <label className="set-field wide"><input type="password" autoFocus aria-label="Anthropic API key" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) save(); }} /></label>
        {error && <p className="set-error">{error}</p>}
        <div className="modal-actions">
          <span />
          <span className="modal-actions-end">
            <button className="pill" onClick={() => onDone(false)}>Cancel</button>
            <button className="pill primary" disabled={!key.trim() || busy} onClick={save}>{busy ? 'Checking…' : 'Save key'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
