import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { Popup } from './Popup';
import { ReportIssueHost } from './ReportIssue';
import './styles.css';
import { installTooltips } from './tooltips';

window.addEventListener('error', (e) => console.error('window error:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('unhandled rejection:', String(e.reason)));

const isPopup = location.hash === '#popup';
if (isPopup) document.documentElement.classList.add('popup-root');
installTooltips();
// the Report issue sheet sits beside the root boundary, so the whole window's crash page can open it too
createRoot(document.getElementById('root')!).render(<><ErrorBoundary view={isPopup ? 'popup' : 'root'} whole>{isPopup ? <Popup /> : <App />}</ErrorBoundary>{!isPopup && <ReportIssueHost />}</>);

// short loader, then dissolve the app in once it has painted
const boot = document.getElementById('boot');
if (boot && !isPopup) {
  // timers, not animation frames: Chromium pauses frames for a window that's behind others
  setTimeout(() => { boot.classList.add('done'); setTimeout(() => boot.remove(), 350); }, 450);
} else boot?.remove();

// a file or link dropped anywhere but a drop zone does nothing; main also refuses navigation away from the app
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
