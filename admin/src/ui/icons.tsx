import type { SVGProps } from 'react';

// the desktop app's line icons (app/src/icons.tsx), copied so the admin app has no import across packages
const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z" /></svg>
);
export const IconKey = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l2 2M13 10l2 2" /></svg>
);
export const IconBuilding = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 9h5a1 1 0 0 1 1 1v10M3 20h18M8 8h2M8 12h2M8 16h2" /></svg>
);
export const IconPeople = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3" /><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 14c2 .6 3 2.3 3 5" /></svg>
);
export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
);
export const IconPerson = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 12, height: 12, strokeWidth: 2, ...p })}><path d="m6 9 6 6 6-6" /></svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconMenu = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconSignOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M15 8l4 4-4 4M19 12H9" /></svg>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></svg>
);
export const IconFlag = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>
);
export const IconNote = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 3.5h8.5L18 7v13.5H6Z" /><path d="M9 11h6M9 14.5h6M9 18h3.5" /></svg>
);
export const IconMore = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" /></svg>
);
export const IconQuorum =(p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 3a7 7 0 0 0-7 7v7l3-2h4a7 7 0 0 0 0-12Z" /><circle cx="9.5" cy="10" r="1" fill="currentColor" /><circle cx="14.5" cy="10" r="1" fill="currentColor" /></svg>
);
