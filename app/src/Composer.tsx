import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Settings } from './quorum';
import { ClaudeLogo, IconArrowUp, IconChevron, IconClose, IconCode, IconDoc, IconMic, IconPlus, ProviderMark } from './icons';
import { modelName, providerFor } from '../connectors/catalog';
import { useFlag } from './flags';

// the Claude picks: the composer's quick switch when Claude Code or the Anthropic API answers, and the same choice on
// those rows in Settings › Connectors; other providers run the model named there (connectors/catalog.js)
type ModelOption = { id: Settings['model']; label: string; note?: string };
export const MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus 5.5', note: 'Smartest' },
  { id: 'sonnet', label: 'Sonnet 5.5', note: 'Balanced' },
  { id: 'haiku', label: 'Haiku 5.5', note: 'Fastest' },
];

// the one composer used on Home, in chat and on note pages
type Attachment = { key: string; name: string; thumb: string | null; staged: string | null; error?: string };

export function Composer({ value, onChange, onSubmit, placeholder, disabled, busy, inputRef, className = '' }: {
  value: string; onChange: (v: string) => void; onSubmit: (text: string, files: string[]) => void; placeholder: string;
  disabled?: boolean; busy?: boolean; inputRef?: RefObject<HTMLTextAreaElement | null>; className?: string;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? own;
  const form = useRef<HTMLFormElement>(null);
  const [tall, setTall] = useState(false);
  const compactWidth = useRef(0);
  const lastRects = useRef<{ form: DOMRect; input: DOMRect; tools: DOMRect; attach: DOMRect } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [menu, setMenu] = useState(false);
  const [menuUp, setMenuUp] = useState(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const staging = files.some((f) => !f.staged && !f.error);
  const [dictating, setDictating] = useState(false);
  // dictation belongs to manual listening (the manual-listen flag)
  const canDictate = useFlag('manual-listen');
  // only the composer that started dictation takes the words
  const dict = useRef<{ base: string; finals: string } | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;
  const dictRef = useRef<{ heard: string; write: string }[]>([]);
  dictRef.current = settings?.voice?.dictionary ?? [];
  const soundsRef = useRef(false);
  soundsRef.current = settings?.voice?.sounds ?? false;

  useEffect(() => {
    window.quorum.getSettings().then(setSettings);
    const offs = [
      window.quorum.onSettings(setSettings),
      window.quorum.onHelperEvent((e) => {
        if (e.event === 'dictation') {
          if (e.state === 'off') { if (dict.current && soundsRef.current) chime(false); setDictating(false); dict.current = null; }
          else if (dict.current) { if (soundsRef.current) chime(true); setDictating(true); }
          return;
        }
        if (e.event === 'transcript' && e.channel === 'dictation' && dict.current) {
          const d = dict.current;
          if (e.isFinal) d.finals = `${d.finals} ${e.text}`.trim();
          latest.current(fixWords([d.base, d.finals, e.isFinal ? '' : e.text].filter(Boolean).join(' '), dictRef.current));
        }
      }),
    ];
    return () => { offs.forEach((off) => off()); if (dict.current) window.quorum.dictate(false); };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  // one row until the text wraps, then the input moves above the buttons and grows with the text
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    if (!tall) {
      compactWidth.current = el.clientWidth;
      el.style.height = 'auto';
      if (el.scrollHeight > el.clientHeight + 1) setTall(true);
      else el.style.height = '';
      return;
    }
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = getComputedStyle(el).font;
    if (!value.includes('\n') && ctx.measureText(value).width < compactWidth.current - 4) { el.style.height = ''; setTall(false); return; }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value, tall, input]);

  // animates the switch between one row and two so the box eases to its new height
  useLayoutEffect(() => {
    const f = form.current, prev = lastRects.current;
    if (!f || !prev || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const opts = { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
    const now = f.getBoundingClientRect();
    f.style.overflow = 'hidden';
    f.animate([{ height: `${prev.form.height}px` }, { height: `${now.height}px` }], opts).onfinish = () => { f.style.overflow = ''; };
    const glide = (el: Element | null, from: DOMRect) => {
      if (!el) return;
      const to = el.getBoundingClientRect();
      el.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], opts);
    };
    glide(f.querySelector('.c-input'), prev.input);
    glide(f.querySelector('.c-tools'), prev.tools);
    glide(f.querySelector('.c-attach'), prev.attach);
  }, [tall]);

  useLayoutEffect(() => {
    const f = form.current;
    if (!f) return;
    const r = (sel: string) => f.querySelector(sel)!.getBoundingClientRect();
    lastRects.current = { form: f.getBoundingClientRect(), input: r('.c-input'), tools: r('.c-tools'), attach: r('.c-attach') };
  });

  const submit = () => {
    const q = value.trim();
    if (!q || disabled || busy || staging) return;
    if (dict.current) window.quorum.dictate(false);
    onSubmit(q, files.flatMap((f) => (f.staged ? [f.staged] : [])));
    setFiles([]);
  };
  const attach = async () => {
    const picked = await window.quorum.pickFiles();
    for (const p of picked) {
      const key = `${p.path}-${Date.now()}`;
      setFiles((fs) => [...fs, { key, name: p.name, thumb: null, staged: null }]);
      window.quorum.stageFile(p.path)
        .then((r) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...r } : f))))
        .catch((err) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: String(err).replace(/^.*Error:\s*/, '') } : f))));
    }
    input.current?.focus();
  };
  const toggleDictation = () => {
    if (dictating) { window.quorum.dictate(false); return; }
    dict.current = { base: value.trim(), finals: '' };
    window.quorum.dictate(true);
    input.current?.focus();
  };
  const model = MODELS.find((m) => m.id === settings?.model) ?? MODELS[1];
  // which provider answers questions; Claude providers get the quick switch, the others show the model set in Settings › Connectors
  const agent = settings ? providerFor('agent', settings.providers, settings.modelSource) : null;
  const claude = agent === 'claude-code' || agent === 'anthropic';
  const modelText = modelName(agent, settings?.model ?? 'sonnet', settings?.localModel, settings?.connectors) ?? '';

  // nothing to type into until a provider is added; the button opens Settings › Connectors
  if (settings && !agent) {
    return (
      <div className={`composer composer-choose ${className}`}>
        <span>Add an AI provider to start</span>
        <button type="button" className="pill primary" onClick={() => window.dispatchEvent(new CustomEvent('quorum-open-settings', { detail: 'connectors' }))}>Open Settings</button>
      </div>
    );
  }

  return (
    <form ref={form} className={`composer ${tall ? 'tall' : ''} ${files.length ? 'has-files' : ''} ${className}`} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {files.length > 0 && (
        <div className="c-files">
          {files.map((f) => (
            <span key={f.key} className={`c-file ${f.error ? 'failed' : ''}`} data-tip={f.error} data-tip-pos="top">
              {f.thumb ? <img src={f.thumb} alt="" /> : <IconDoc width={16} height={16} />}
              <span className="c-file-name">{f.name}</span>
              {!f.staged && !f.error ? <span className="c-file-spin" aria-label="Adding" />
                : <button type="button" className="c-file-x" aria-label={`Remove ${f.name}`} onClick={() => { if (f.staged) window.quorum.unstageFile(f.staged); setFiles((fs) => fs.filter((x) => x.key !== f.key)); }}><IconClose width={12} height={12} /></button>}
            </span>
          ))}
        </div>
      )}
      <button type="button" className="icon-btn c-attach" aria-label="Add files" data-tip="Add files" data-tip-pos="top" disabled={disabled} onClick={attach}><IconPlus /></button>
      <textarea ref={input} className="c-input" value={value} rows={1} placeholder={placeholder} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'd' && !disabled && (canDictate || dictating)) { e.preventDefault(); toggleDictation(); }
        }} />
      <div className="c-tools">
        {(canDictate || dictating) && (
        <button type="button" className={`icon-btn mic ${dictating ? 'on' : ''}`} disabled={disabled} onClick={toggleDictation}
          aria-label={dictating ? 'Stop dictation' : 'Dictate'} aria-pressed={dictating} data-tip={dictating ? 'Stop dictation · ⌘⇧D' : 'Dictate · ⌘⇧D'} data-tip-pos="top">
          <IconMic />
        </button>
        )}
        {claude ? (
          <div className="menu-wrap model-wrap">
            <button type="button" className="model" onClick={(e) => { e.stopPropagation(); setMenuUp(e.currentTarget.getBoundingClientRect().bottom + 330 > window.innerHeight); setMenu((o) => !o); }} aria-haspopup="menu" aria-expanded={menu}
              aria-label={`Model: ${model.label}`} data-tip="Choose model" data-tip-pos="top">
              <ClaudeLogo /><span>{model.label}</span><IconChevron />
            </button>
            {menu && (
              <div className={`menu model-menu ${menuUp ? 'up end' : ''}`} role="menu">
                <p className="menu-label">Models</p>
                {MODELS.map((m) => (
                  <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === model.id} className={m.id === model.id ? 'checked' : ''}
                    onClick={async () => { setMenu(false); setSettings(await window.quorum.setSettings({ model: m.id })); }}>
                    <ProviderMark provider="anthropic" /><span>{m.label}</span>{m.note && <em>{m.note}</em>}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="model plain" aria-label={`Model: ${modelText}`} data-tip="Model, set in Settings › Connectors" data-tip-pos="top">
            {agent === 'openai' || agent === 'google' ? <ProviderMark provider={agent} /> : <IconCode width={16} height={16} />}<span>{modelText}</span>
          </span>
        )}
        <button type="submit" className="send" aria-label="Send" disabled={!value.trim() || disabled || busy || staging}><IconArrowUp /></button>
      </div>
    </form>
  );
}

// your dictionary: whole-word, case-insensitive swaps for names the recogniser gets wrong
function fixWords(text: string, dictionary: { heard: string; write: string }[]) {
  return dictionary.reduce((t, d) => t.replace(new RegExp(`\\b${d.heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), d.write), text);
}

// a soft rising tone when dictation starts, falling when it stops
function chime(on: boolean) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(on ? 660 : 880, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(on ? 880 : 660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {}
}
