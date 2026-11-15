import { IconBack } from './icons';

// Back on every page: an outlined pill with the arrow, the same size and colors as the page's other actions
export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return <button className="act-pill back-btn" onClick={onClick}><IconBack width={16} height={16} /> {label}</button>;
}
