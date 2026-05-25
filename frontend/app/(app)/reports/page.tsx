import { tryFetch } from '@/lib/server';
import { fmtMinor, fmtNumber, fmtPercent, type Currency } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface PStats { total: number; by_status: Array<{ status: string; c: number }>; by_currency: Array<{ currency: Currency; c: number; gross: number }>; by_kind: Array<{ kind: string; c: number }>; last_24h: { c: number; gross: number }; }

export default async function ReportsPage() {
  const [stats] = await Promise.all([
    tryFetch<PStats>('payments', '/stats'),
  ]);

  const settled = stats?.by_status?.find((s) => s.status === 'settled')?.c ?? 0;
  const failed  = stats?.by_status?.find((s) => s.status === 'failed')?.c ?? 0;
  const refunded= stats?.by_status?.find((s) => s.status === 'refunded')?.c ?? 0;
  const success = (stats?.total ?? 0) > 0 ? settled / stats!.total : 0;
  const failRate= (stats?.total ?? 0) > 0 ? failed  / stats!.total : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div className="card" style={{ padding: 18 }}>
        <div className="h-display" style={{ fontSize: 14, marginBottom: 6 }}>Health summary</div>
        <div style={{ fontSize: 12.5, color: 'rgb(var(--ink-2))', lineHeight: 1.6 }}>
          Over a corpus of <strong>{fmtNumber(stats?.total ?? 0)}</strong> intents the platform achieved a{' '}
          <strong>{fmtPercent(success)}</strong> settle rate, with{' '}
          <strong>{fmtPercent(failRate)}</strong> failures and{' '}
          <strong>{fmtNumber(refunded)}</strong> refunds.  Last 24h volume was{' '}
          <strong>{fmtNumber(stats?.last_24h?.c ?? 0)}</strong> intents.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div className="card">
          <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}><div className="h-display" style={{ fontSize: 14 }}>By status</div></div>
          <table className="t-table">
            <thead><tr><th>Status</th><th style={{ textAlign: 'right' }}>Count</th><th style={{ textAlign: 'right' }}>Share</th></tr></thead>
            <tbody>
              {(stats?.by_status ?? []).map((s) => (
                <tr key={s.status}>
                  <td style={{ textTransform: 'capitalize' }}>{s.status}</td>
                  <td className="num">{fmtNumber(s.c)}</td>
                  <td className="num">{fmtPercent((stats?.total ?? 0) > 0 ? s.c / stats!.total : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}><div className="h-display" style={{ fontSize: 14 }}>By kind</div></div>
          <table className="t-table">
            <thead><tr><th>Kind</th><th style={{ textAlign: 'right' }}>Count</th></tr></thead>
            <tbody>
              {(stats?.by_kind ?? []).map((k) => (
                <tr key={k.kind}><td>{k.kind}</td><td className="num">{fmtNumber(k.c)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}><div className="h-display" style={{ fontSize: 14 }}>By currency</div></div>
          <table className="t-table">
            <thead><tr><th>Currency</th><th style={{ textAlign: 'right' }}>Payments</th><th style={{ textAlign: 'right' }}>Gross</th></tr></thead>
            <tbody>
              {(stats?.by_currency ?? []).map((c) => (
                <tr key={c.currency}>
                  <td className="mono" style={{ fontWeight: 600 }}>{c.currency}</td>
                  <td className="num">{fmtNumber(c.c)}</td>
                  <td className="amount">{fmtMinor(BigInt(c.gross ?? 0), c.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
