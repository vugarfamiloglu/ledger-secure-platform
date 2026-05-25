import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtDate, fmtRelative, fmtNumber, type Currency } from '@/lib/format';
import { ReconActions } from './ReconActions';

export const dynamic = 'force-dynamic';

interface Statement {
  id: string; source: string; external_ref: string; amount_minor: string; currency: Currency;
  posted_at: string; state: string; matched_payment_id: string | null; matched_score: number | null;
  notes: string | null; ingested_at: string;
}
interface ReconStats { total: number; by_state: Array<{ state: string; c: number }>; by_source: Array<{ source: string; c: number }>; heal_pending: number; }

export default async function ReconciliationPage() {
  const [stats, statements] = await Promise.all([
    tryFetch<ReconStats>('reconciliation', '/stats'),
    tryFetch<{ statements: Statement[]; total: number }>('reconciliation', '/statements?limit=200'),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {(stats?.by_state ?? []).map((s) => (
          <div key={s.state} className="kpi">
            <div className="eyebrow">{s.state}</div>
            <div className="kpi-value">{fmtNumber(s.c)}</div>
          </div>
        ))}
        <div className="kpi">
          <div className="eyebrow">Heal queue</div>
          <div className="kpi-value" style={{ color: 'rgb(var(--copper))' }}>{fmtNumber(stats?.heal_pending ?? 0)}</div>
        </div>
      </div>

      <ReconActions hasPending={(stats?.heal_pending ?? 0) > 0 || (statements?.statements ?? []).some((s) => ['unmatched', 'partial', 'suspicious'].includes(s.state))} />

      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Statements</div>
        </div>
        <table className="t-table">
          <thead><tr><th>Source</th><th>External ref</th><th style={{ textAlign: 'right' }}>Amount</th><th>State</th><th>Match</th><th>Notes</th><th>Posted</th></tr></thead>
          <tbody>
            {(statements?.statements ?? []).map((s) => (
              <tr key={s.id}>
                <td className="mono" style={{ fontSize: 11 }}>{s.source}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{s.external_ref}</td>
                <td className="amount">{fmtMinor(s.amount_minor, s.currency)}</td>
                <td><StatusPill value={s.state} /></td>
                <td className="num" style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{s.matched_score != null ? s.matched_score.toFixed(3) : '—'}</td>
                <td style={{ fontSize: 11.5, color: 'rgb(var(--muted))', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.notes || '—'}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(s.posted_at)}</td>
              </tr>
            ))}
            {(!statements?.statements || statements.statements.length === 0) ? (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No statements ingested yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
