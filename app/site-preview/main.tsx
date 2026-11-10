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
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
