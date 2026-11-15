// An empty day (Today, or Next N days with no calls): a small drawing of a sun setting over still water, and a note to
// take the day
export function DayOff({ title }: { title: string }) {
  return (
    <div className="day-off">
      <svg className="day-off-art" viewBox="0 0 120 72" aria-hidden="true">
        <defs><clipPath id="day-off-sky"><rect x="0" y="0" width="120" height="46" /></clipPath></defs>
        <circle cx="60" cy="44" r="18" className="day-off-sun" clipPath="url(#day-off-sky)" />
        <path d="M14 46h92" className="day-off-line" />
        <path d="M30 54h60M44 61h32" className="day-off-water" />
        <path d="M60 12v6M38 22l4 4M82 22l-4 4" className="day-off-ray" />
      </svg>
      <div className="day-off-text">
        <p className="day-off-title">{title}</p>
        <p className="hist-empty">No meetings or notes yet. Take the day off and enjoy it.</p>
      </div>
    </div>
  );
}

