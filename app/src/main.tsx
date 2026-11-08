import { createRoot } from 'react-dom/client';
import { App, ErrorBoundary } from './App';
import { Popup } from './Popup';
import './styles.css';
import { installTooltips } from './tooltips';

window.addEventListener('error', (e) => console.error('window error:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection:', String(e.reason)));

const isPopup = location.hash === '#popup';
if (isPopup) document.documentElement.classList.add('popup-root');
installTooltips();
createRoot(document.getElementById('root')!).render(<ErrorBoundary>{isPopup ? <Popup /> : <App />}</ErrorBoundary>);

// short loader, then dissolve the app in once it has painted
const boot = document.getElementById('boot');
if (boot && !isPopup) {
  // timers, not animation frames: Chromium pauses frames for a window that's behind others
  setTimeout(() => { boot.classList.add('done'); setTimeout(() => boot.remove(), 350); }, 450);
} else boot?.remove();
