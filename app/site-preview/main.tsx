// Entry for the app preview on quorum.watch: the same App the desktop window renders, fed by the sample bridge in
// mock.ts. Built by `npm run build:site-preview` into site/app-preview/, which the home page shows in a frame.
import './mock';
import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from '../src/App';
import '../src/styles.css';
import './preview.css';
import { installTooltips } from '../src/tooltips';

// The page around the frame keeps the scroll wheel and the keyboard: the graph would zoom on the wheel and the app
// binds Cmd+O, Cmd+P and Cmd+Shift+F, so neither event reaches the app's own listeners.
for (const type of ['wheel', 'keydown'] as const) window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);

installTooltips();
// ?crash=1 shows the crash page itself (a thrown render), for a look at it outside the desktop app
const Crash = () => { throw new Error(new URLSearchParams(location.search).get('crash') === 'stale' ? 'Failed to fetch dynamically imported module: file:///…/dist/assets/Account-Bakdb2me.js' : 'Cannot read properties of undefined (reading map)'); };
createRoot(document.getElementById('root')!).render(<ErrorBoundary>{new URLSearchParams(location.search).has('crash') ? <Crash /> : <App />}</ErrorBoundary>);
