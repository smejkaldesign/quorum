// a placeholder block while a value loads
export function Skeleton({ width, height = 16, className = '' }: { width?: number | string; height?: number | string; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width, height }} aria-hidden="true" />;
}

// a few skeleton rows standing in for a list
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return <div className="skeleton-rows">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={18} width={`${70 - i * 12}%`} />)}</div>;
}
