// Error boundaries. One wraps each view (the main area in App.tsx, each Settings page in SettingsView.tsx) and one wraps
// the whole window as a last resort (main.tsx). A view that fails while drawing shows the crash page in place of the
// view, with the header and the Settings list still working, so another page is one click away; moving to another
// page (resetKey) clears it. Reload view mounts the view again from scratch. A view that fails again within 5 seconds
// of that fails on every draw (crash.ts): the page says so and offers Reload Quorum, which reloads the window's page
// without quitting. Every crash is reported (errorReports.js in the main process, unless Settings turns reports off).
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { STALE_BUNDLE, crashKind, failsEveryTime, type CrashKind } from './crash';

export { STALE_BUNDLE };

type Props = { view: string; resetKey?: string; whole?: boolean; children: ReactNode };
type State = { error: Error | null; errorAt: number; reloadedAt: number | null; attempt: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorAt: 0, reloadedAt: null, attempt: 0 };
  static getDerivedStateFromError(error: Error) { return { error, errorAt: Date.now() }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('render crash:', this.props.view, error.message, error.stack);
    window.quorum?.reportError?.({ view: this.props.view, message: error.message, stack: error.stack ?? '', componentStack: info.componentStack ?? '', repeat: failsEveryTime(this.state.reloadedAt, this.state.errorAt) }).catch?.(() => {});
  }
  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, reloadedAt: null, attempt: this.state.attempt + 1 });
  }
  reloadView = () => {
    const stale = !!this.state.error && STALE_BUNDLE.test(this.state.error.message);
    if (this.props.whole || stale) { reloadWindow(); return; }
    this.setState({ error: null, reloadedAt: Date.now(), attempt: this.state.attempt + 1 });
  };
  render() {
    const { error, reloadedAt, errorAt, attempt } = this.state;
    if (!error) return <Fragment key={attempt}><CrashProbe view={this.props.view} />{this.props.children}</Fragment>;
    return <CrashPage error={error} kind={crashKind(error.message, reloadedAt, errorAt)} whole={!!this.props.whole} onReload={this.reloadView} />;
  }
}

// development copies only: sessionStorage 'quorum.crashTest' set to a view id (settings/connectors, main/home, root)
// makes that view throw while drawing, and 'quorum.crashTest.once' throws only on the first draw, so the crash page,
// Reload view and the repeat page can be checked by hand. Installed builds never throw here
function CrashProbe({ view }: { view: string }) {
  if (!window.quorum?.isDev) return null;
  let want: string | null = null;
  try { want = sessionStorage.getItem('quorum.crashTest'); } catch { /* no storage, no probe */ }
  if (want !== view) return null;
  try { if (sessionStorage.getItem('quorum.crashTest.once')) sessionStorage.removeItem('quorum.crashTest'); } catch { /* the probe keeps throwing */ }
  throw new Error(`Crash test in ${view}`);
}

// reloads the window's page in place; Quorum keeps running, and recording, sync and the tray are untouched
export function reloadWindow() {
  if (window.quorum?.reloadWindow) window.quorum.reloadWindow().catch(() => location.reload());
  else location.reload();
}

// a view that failed while drawing, as a page: what happened in plain words, what is safe, what to do
function CrashPage({ error, kind, whole, onReload }: { error: Error; kind: CrashKind; whole: boolean; onReload: () => void }) {
  const stale = kind === 'stale';
  const repeat = kind === 'repeat';
  return (
    <div className="panel"><div className="crash" role="alert">
      <CrashArt />
      <h1>{stale ? 'Quorum updated underneath this view' : repeat ? 'This view fails every time it opens' : "Quorum couldn't draw this view"}</h1>
      <p>{stale
        ? "The app's files changed while this window was open, so a part of the view could not load. Reloading picks up the new version."
        : repeat
          ? `It failed again right after reloading, so it needs a fix in Quorum. ${whole ? 'Reload Quorum to try once more.' : 'Go to another page, or reload Quorum to try once more.'}`
          : 'A part of the app failed while it was drawing. Reloading draws it again from the start.'}</p>
      <p>Your notes, transcripts and settings are not affected. Nothing was lost. Quorum sends a report of this error so it can be fixed, unless error reports are off in Settings, General.</p>
      <div className="crash-actions">
        {repeat
          ? <button className="pill primary crash-reload" onClick={reloadWindow}>Reload Quorum</button>
          : <button className="pill primary crash-reload" onClick={onReload}>{whole || stale ? 'Reload Quorum' : 'Reload view'}</button>}
      </div>
      <details className="crash-detail">
        <summary>Technical detail</summary>
        <code>{error.message}</code>
      </details>
    </div></div>
  );
}

// three note cards, the front one slipped off its stack
function CrashArt() {
  return (
    <svg className="crash-art" width="120" height="96" viewBox="0 0 120 96" fill="none" aria-hidden="true">
      <rect x="30" y="10" width="60" height="72" rx="8" fill="#2a2a2d" stroke="#3a3a3e" />
      <rect x="24" y="16" width="60" height="72" rx="8" fill="#303034" stroke="#444449" />
      <g transform="rotate(-9 50 60)">
        <rect x="20" y="24" width="60" height="72" rx="8" fill="#39393e" stroke="#55555b" />
        <rect x="30" y="38" width="30" height="4" rx="2" fill="#8a8a92" />
        <rect x="30" y="48" width="40" height="4" rx="2" fill="#5e5e66" />
        <rect x="30" y="58" width="36" height="4" rx="2" fill="#5e5e66" />
        <rect x="30" y="68" width="22" height="4" rx="2" fill="#5e5e66" />
      </g>
      <circle cx="96" cy="22" r="11" fill="#1f1f22" stroke="#7fdb83" />
      <path d="M96 16v7" stroke="#7fdb83" strokeWidth="2" strokeLinecap="round" />
      <circle cx="96" cy="27.5" r="1.3" fill="#7fdb83" />
    </svg>
  );
}
