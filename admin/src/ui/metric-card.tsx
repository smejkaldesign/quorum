import { Skeleton } from './skeleton';

// Celune's MetricCard flattened to props: a label, a value, an optional line under it, a link to the page behind the
// number. `hot` paints the value in the brand color for a count that wants attention.
export function MetricCard({ label, value, sub, href, hot }: { label: string; value: number | string | undefined; sub?: string; href?: string; hot?: boolean }) {
  const body = (
    <>
      <span className="metric-label">{label}</span>
      {value === undefined ? <Skeleton width={56} height={30} /> : <strong className={`metric-value ${hot ? 'hot' : ''}`}>{value}</strong>}
      {sub && <em className="metric-sub">{sub}</em>}
    </>
  );
  return href ? <a className="metric" href={href}>{body}</a> : <div className="metric">{body}</div>;
}

export function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="metrics">{children}</div>;
}
