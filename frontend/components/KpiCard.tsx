/* KPI tile — eyebrow, big number, optional delta + footnote. */

interface KpiProps {
  label: string;
  value: string | number;
  hint?: string;
  delta?: { value: string | number; trend: 'up' | 'down' | 'flat' };
  tone?: 'default' | 'copper' | 'moss' | 'ember' | 'amber';
}

export function KpiCard({ label, value, hint, delta, tone = 'default' }: KpiProps) {
  const valueColor =
    tone === 'copper' ? 'rgb(var(--copper))' :
    tone === 'moss'   ? 'rgb(var(--moss))'   :
    tone === 'ember'  ? 'rgb(var(--ember))'  :
    tone === 'amber'  ? 'rgb(var(--amber))'  :
    'rgb(var(--ink))';
  const trendColor =
    delta?.trend === 'up'   ? 'rgb(var(--moss))'  :
    delta?.trend === 'down' ? 'rgb(var(--ember))' :
    'rgb(var(--muted))';
  const trendChar = delta?.trend === 'up' ? '▲' : delta?.trend === 'down' ? '▼' : '·';

  return (
    <div className="kpi">
      <div className="eyebrow">{label}</div>
      <div className="kpi-value" style={{ color: valueColor }}>{value}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 6 }}>
        {delta ? (
          <span className="mono" style={{ fontSize: 11.5, color: trendColor }}>
            {trendChar} {delta.value}
          </span>
        ) : <span />}
        {hint ? <span style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{hint}</span> : null}
      </div>
    </div>
  );
}
