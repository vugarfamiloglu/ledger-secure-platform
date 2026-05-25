import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtRelative, fmtNumber, shortId } from '@/lib/format';
import { FraudCaseActions } from './FraudCaseActions';

export const dynamic = 'force-dynamic';

interface Case { id: string; public_id: string; payment_id: string | null; merchant_id: string; score: number; level: string; signals_json: string; action: string; status: string; created_at: string; }
interface Stats { scored_total: number; by_level: Array<{ level: string; c: number }>; open_cases: number; cases_by_level: Array<{ level: string; c: number }>; }

export default async function FraudPage() {
  const [stats, cases] = await Promise.all([
    tryFetch<Stats>('fraud', '/stats'),
    tryFetch<{ cases: Case[]; total: number }>('fraud', '/cases?limit=200'),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <div className="kpi"><div className="eyebrow">Scored</div><div className="kpi-value">{fmtNumber(stats?.scored_total ?? 0)}</div></div>
        <div className="kpi"><div className="eyebrow">Open cases</div><div className="kpi-value" style={{ color: 'rgb(var(--ember))' }}>{fmtNumber(stats?.open_cases ?? 0)}</div></div>
        {(stats?.by_level ?? []).map((l) => (
          <div key={l.level} className="kpi"><div className="eyebrow">{l.level}</div><div className="kpi-value">{fmtNumber(l.c)}</div></div>
        ))}
      </div>

      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Case queue</div>
          <div style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 2 }}>Anything scoring ≥ 0.60 opens here automatically.</div>
        </div>
        <table className="t-table">
          <thead><tr>
            <th>Case</th><th>Merchant</th><th>Payment</th><th>Score</th><th>Level</th>
            <th>Action</th><th>Signals</th><th>Status</th><th>When</th><th></th>
          </tr></thead>
          <tbody>
            {(cases?.cases ?? []).map((c) => {
              const signals: string[] = c.signals_json ? JSON.parse(c.signals_json) : [];
              return (
                <tr key={c.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{c.public_id}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'rgb(var(--muted))' }}>{shortId(c.merchant_id, 10, 4)}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{shortId(c.payment_id, 8, 4)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{c.score.toFixed(2)}</td>
                  <td><StatusPill value={c.level} /></td>
                  <td><span className="pill pill-amber">{c.action.replace('_', ' ')}</span></td>
                  <td style={{ maxWidth: 240 }}>
                    {signals.slice(0, 3).map((s) => <span key={s} className="pill pill-muted" style={{ marginRight: 4, marginBottom: 3, fontSize: 9.5 }}>{s}</span>)}
                    {signals.length > 3 ? <span style={{ fontSize: 10, color: 'rgb(var(--muted))' }}>+{signals.length - 3}</span> : null}
                  </td>
                  <td><StatusPill value={c.status} /></td>
                  <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(c.created_at)}</td>
                  <td>{c.status === 'open' ? <FraudCaseActions caseId={c.public_id} /> : null}</td>
                </tr>
              );
            })}
            {(!cases?.cases || cases.cases.length === 0) ? <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>Case queue is clear.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
