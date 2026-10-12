'use client';

/** Small dependency-free SVG charts for the dashboard. Colours come from the theme tokens. */

export interface Series {
  label: string;
  color: string;
  values: number[];
}

const dayLabel = (iso: string) => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00`));

/** Stacked daily bars with a hover tooltip per day. */
export function BarChart({ days, series, height = 140 }: { days: string[]; series: Series[]; height?: number }) {
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const w = 100 / days.length;
  return (
    <div className="chart">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height }} role="img" aria-label={series.map((s) => `${s.label}: ${s.values.reduce((a, b) => a + b, 0)}`).join(', ')}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2="100" y1={height * f} y2={height * f} stroke="var(--line)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        ))}
        {days.map((d, i) => {
          let y = height;
          return (
            <g key={d}>
              <title>{`${dayLabel(d)} · ${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join(' · ')}`}</title>
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (!v) return null;
                const h = (v / max) * (height - 6);
                y -= h;
                return <rect key={s.label} x={i * w + w * 0.18} y={y} width={w * 0.64} height={h} rx="0.6" fill={s.color} />;
              })}
            </g>
          );
        })}
      </svg>
      <div className="chart-axis">
        <span>{dayLabel(days[0]!)}</span>
        <span>{dayLabel(days[Math.floor(days.length / 2)]!)}</span>
        <span>Bugün</span>
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} /> {s.label} <b>{s.values.reduce((a, b) => a + b, 0)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal proportion bar (status distribution) with a legend. */
export function SplitBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div>
      <div className="splitbar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {total ? parts.filter((p) => p.value).map((p) => <span key={p.label} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />) : <span style={{ width: '100%', background: 'var(--sunk)' }} />}
      </div>
      <div className="chart-legend">
        {parts.map((p) => (
          <span key={p.label}>
            <i style={{ background: p.color }} /> {p.label} <b>{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
