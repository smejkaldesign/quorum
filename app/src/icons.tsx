import { useEffect, useRef, type SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p,
});

export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" /></svg>
);
export const IconNotes = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
);
export const IconLogs = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 6h16M4 12h10M4 18h13" /></svg>
);
export const IconGear = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
);
export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconMic = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const IconArrowUp = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 12, height: 12, strokeWidth: 2, ...p })}><path d="m6 9 6 6 6-6" /></svg>
);
export const IconDoc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>
);
export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>
);
export const IconExternal = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
);
export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></svg>
);
export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>
);
export const IconPeople = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="9" cy="8" r="3" /><path d="M3 19c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 14c2 .6 3 2.3 3 5" /></svg>
);
export const IconFolder = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
);
// filled variants mark something connected or switched on
// the Quorum owl, filled
export const IconQuorum = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ viewBox: '0 0 318 377', ...p })} fill="currentColor" stroke="none">
    <path d="M90.9287 121.257C102.171 119.886 112.402 127.885 113.804 139.144C115.206 150.402 107.25 160.674 96.0157 162.111C84.7349 163.554 74.4294 155.545 73.0215 144.24C71.6139 132.935 79.6396 122.634 90.9287 121.257Z" />
    <path d="M221.514 121.265C232.725 119.862 242.962 127.792 244.432 139.015C245.899 150.237 238.046 160.542 226.851 162.081C215.562 163.633 205.166 155.682 203.687 144.362C202.206 133.043 210.204 122.679 221.514 121.265Z" />
    <path d="M158.605 0C162.104 0 170.686 0.432579 173.967 0.81543C196.585 3.15299 217.735 10.4358 236.32 21.5615C240.968 19.6092 246.591 17.8148 251.221 16.3691C273.414 9.43985 294.05 7.09151 317.106 6.71191C317.126 7.42717 317.144 8.15131 317.16 8.88281C317.296 19.0477 317.099 29.4575 317.162 39.6299C317.161 39.7162 317.16 39.8026 317.159 39.8887C315.794 39.8972 314.456 39.9167 313.141 39.9453C301.788 40.1234 290.468 41.295 279.31 43.4541C274.596 44.369 271.659 44.9878 267.229 45.9717C294.066 73.4594 310.605 111.048 310.605 152.5C310.605 196.766 291.742 236.625 261.618 264.483C261.613 264.489 261.609 264.495 261.605 264.5C245.105 281 247.714 323.391 247.605 377C247.605 377 218.696 377 158.608 377C98.8416 377 69.6045 377 69.6045 377C69.4948 323.391 72.1044 281 55.6045 264.5C55.5997 264.495 55.596 264.489 55.5909 264.483C25.4674 236.625 6.60453 196.766 6.60453 152.5C6.60453 111.048 23.1425 73.4594 49.9805 45.9717C45.5503 44.9878 42.6129 44.369 37.8995 43.4541C26.7408 41.295 15.4214 40.1234 4.0684 39.9453C2.75313 39.9167 1.41473 39.8972 0.0498411 39.8887C0.0488458 39.8026 0.0479058 39.7162 0.0469114 39.6299C0.110273 29.4575 -0.0869577 19.0477 0.0488646 8.88281C0.0651184 8.15131 0.082616 7.42717 0.102575 6.71191C23.1591 7.09151 43.795 9.43985 65.9883 16.3691C70.6181 17.8148 76.2413 19.6092 80.8887 21.5615C99.4739 10.4358 120.624 3.15299 143.242 0.81543C146.523 0.432579 155.105 0 158.605 0ZM232.54 63.7861C210.609 74.8125 188.698 94.8586 180.895 118.706C176.976 130.683 177.238 139.565 177.236 151.962L177.238 214.677L138.867 214.717L138.869 145.85C138.871 143.435 138.873 141.021 138.866 138.606C138.811 118.456 128.578 100.043 114.636 86.0908C107.138 78.7066 98.7542 72.283 89.6778 66.9658C88.6754 66.367 84.9529 64.1864 83.9297 63.8379C79.499 67.7793 75.8334 71.1069 71.8487 75.5605C54.313 95.1162 43.9487 120.072 42.4629 146.316C40.6204 177.29 51.2462 207.714 71.9639 230.78C92.5801 253.855 121.546 267.717 152.418 269.289C183.041 270.873 213.039 260.218 235.824 239.661C258.014 219.73 272.526 190.738 274.146 160.837C274.166 160.444 274.184 160.05 274.2 159.656C275.942 129.201 265.607 99.2894 245.444 76.4297C241.43 71.9302 237.12 67.7055 232.54 63.7861ZM201.608 45.0273C184.213 38.8779 171.663 36.2271 152.855 37.1943C143.742 37.667 134.722 39.256 126 41.9258C122.81 42.8943 119.657 44.1863 116.608 45.1104C131.737 55.9861 143.872 66.5071 154.397 82.1953C155.747 84.209 158.118 87.825 159.105 90C159.931 88.3738 160.717 87.0659 161.658 85.5127C169.463 73.2202 179.277 62.308 190.697 53.2256C194.359 50.272 198.078 47.8205 201.608 45.0273Z" />
  </svg>
);
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
);
export const IconUpload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
);
export const IconFolderFill = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="currentColor" fillOpacity={0.28} /></svg>
);
export const IconShield = (p: SVGProps<SVGSVGElement> & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return <svg {...base(rest)}><path d="M12 3 5 6v5.5c0 4.3 2.9 7.9 7 9.5 4.1-1.6 7-5.2 7-9.5V6Z" fill={filled ? 'currentColor' : 'none'} fillOpacity={0.28} /></svg>;
};
// a fork from the top splitting down to two dots
export const IconFork = (p: SVGProps<SVGSVGElement> & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return <svg {...base(rest)}><path d="M12 3v6M12 9c0 3.5-6 3.5-6 6.5M12 9c0 3.5 6 3.5 6 6.5" /><circle cx="6" cy="18.5" r="2" fill={filled ? 'currentColor' : 'none'} /><circle cx="18" cy="18.5" r="2" fill={filled ? 'currentColor' : 'none'} /></svg>;
};
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
export const IconPerson = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>
);
export const IconSlash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m14 8-4 8" /></svg>
);
export const IconHistory = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
);
export const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z" /></svg>
);
export const IconGraph = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="8" r="2.2" /><circle cx="9" cy="18" r="2.2" /><circle cx="17" cy="17" r="1.6" /><path d="M8 7l8 1M7 8l1.6 7.8M10.8 17.4l4.6-.3M17.8 10.2l-.5 5.2" /></svg>
);
export const IconNewNote = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 20h8" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const IconNewFolder = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 10v6M9 13h6" /></svg>
);
export const IconSort = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M7 4v16M4 7l3-3 3 3M13 8h7M13 12h5M13 16h3" /></svg>
);
export const IconCollapse = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m7 4 5 5 5-5M7 20l5-5 5 5" /></svg>
);
// side view: cerebrum, cerebellum and brainstem
export const IconBrain = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 1.5, ...p })}>
    <path d="M4.6 14.2C3 13.6 2.3 11.9 2.9 10.4C3.2 8.7 4.7 7.6 6.3 7.7C6.8 5.7 8.7 4.5 10.6 4.8C11.8 3.7 13.8 3.5 15.2 4.4C17 4.2 18.7 5.3 19.2 7C21 7.5 22.1 9.3 21.6 11.1C22.1 12.6 21.4 14.2 20 14.9C19.5 15.9 18.4 16.4 17.3 16.2" />
    <path d="M17.3 16.2C17.6 17.6 16.4 18.8 15 18.6C14.2 19.2 13 19 12.5 18.2M12.6 16.6V20.6" />
    <path d="M10.4 16.4C9 17.1 7.4 16.9 6.4 15.9C5.6 16.1 5 15.3 4.6 14.2M10.4 16.4C11.2 16.7 12 16.7 12.6 16.6C13.8 16.4 15.4 16.5 17.3 16.2" />
    <path d="M7 10.6C8.1 9.7 9.8 9.8 10.8 10.8M12.9 7.4C13.7 8.4 13.6 9.8 12.8 10.7M14.6 12.4C15.6 11.6 17.1 11.6 18.1 12.4M8.6 13.4C9.6 14 10.9 14 11.8 13.3M16.4 8.6C17.3 8.7 18 9.4 18.1 10.2" />
  </svg>
);
export const IconSliders = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
);
export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const IconGrid = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="7.5" cy="7.5" r="3" /><circle cx="16.5" cy="7.5" r="3" /><circle cx="7.5" cy="16.5" r="3" /><circle cx="16.5" cy="16.5" r="3" /></svg>
);
export const IconKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg>
);
export const IconBuilding = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M14 9h5a1 1 0 0 1 1 1v10M3 20h18M8 8h2M8 12h2M8 16h2" /></svg>
);
export const IconStack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M7 4h4l2 2" /></svg>
);
export const IconPower = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 3v8" /><path d="M6.4 6.6a8 8 0 1 0 11.2 0" /></svg>
);
export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="6.5" y="5.5" width="3.5" height="13" rx="1" /><rect x="14" y="5.5" width="3.5" height="13" rx="1" /></svg>
);
export const IconPlay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M8 5.5v13l10.5-6.5z" /></svg>
);
export const IconStop = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);

// while listening the bars follow the loudness of the call; the styles are set directly so the header doesn't re-render ~12 times a second
export function Wave({ live }: { live: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!live) return;
    const bars = [...(ref.current?.children ?? [])] as HTMLElement[];
    const off = window.quorum.onLevel((v) => {
      bars.forEach((b) => { b.style.transform = `scaleY(${(0.25 + 0.75 * v * (0.55 + Math.random() * 0.45)).toFixed(2)})`; });
    });
    return () => { off(); bars.forEach((b) => { b.style.transform = ''; }); };
  }, [live]);
  return (
    <span ref={ref} className={`wave ${live ? 'live' : ''}`} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} />)}
    </span>
  );
}

// Claude's spark on a warm dark disc, as Tana shows it
// official marks (Simple Icons paths); the Gemini gradient matches Google's
const CLAUDE_D = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';
const OPENAI_D = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
const GEMINI_D = 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81';

export function ClaudeLogo() {
  return <svg className="model-logo" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d={CLAUDE_D} fill="#d97757" /></svg>;
}
export const IconScale = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7M19 7l-3 7a3 3 0 0 0 6 0l-3-7" /></svg>
);
export const IconReset = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
);
export const IconMore = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></svg>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
);
// arrows out to two corners: leave a focused node for the whole graph
export const IconExpand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
);
export const IconSidebar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></svg>
);
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
);
export const IconInfo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);

// small monochrome provider marks for the model menu
export function ProviderMark({ provider }: { provider: 'anthropic' | 'openai' | 'google' | 'typesafe' }) {
  if (provider === 'anthropic') return <ClaudeLogo />;
  if (provider === 'typesafe') return <svg className="model-logo" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v3h-6.5v11h-3V8H4z" fill="currentColor" /></svg>;
  if (provider === 'openai') return <svg className="model-logo" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d={OPENAI_D} fill="currentColor" /></svg>;
  return (
    <svg className="model-logo" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <defs><linearGradient id="gemini-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#4796e3" /><stop offset="0.5" stopColor="#9168c0" /><stop offset="1" stopColor="#d96570" /></linearGradient></defs>
      <path d={GEMINI_D} fill="url(#gemini-g)" />
    </svg>
  );
}

export const IconListCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6.5h9M11 12.5h9M11 18.5h9" /></svg>
);
export const IconTarget = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></svg>
);

export const IconFolderOpen = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M3 18V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1.5" /><path d="M3 18 5.6 11.4A2 2 0 0 1 7.5 10H20a1 1 0 0 1 .95 1.3L19 17.6A2 2 0 0 1 17.1 19H4a1 1 0 0 1-1-1Z" /></svg>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
);

export const IconCode = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" /></svg>
);
