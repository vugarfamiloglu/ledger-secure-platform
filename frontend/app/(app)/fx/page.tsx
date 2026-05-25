import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtRelative, type Currency } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Rate { base_currency: Currency; quote_currency: Currency; rate_scaled: string; rate_scale: number; source: string; updated_at: string; rate_human: number; }
interface Quote { id: string; public_id: string; base_currency: Currency; quote_currency: Currency; amount_minor: string; amount_quote_minor: string; spread_minor: string; spread_bp: number; status: string; created_at: string; expires_at: string; executed_at: string | null; }

export default async function FxPage() {
  const [rates, quotes] = await Promise.all([
    tryFetch<{ rates: Rate[]; total: number }>('fx', '/rates'),
    tryFetch<{ quotes: Quote[]; total: number }>('fx', '/quotes?limit=100'),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div className="card">
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="h-display" style={{ fontSize: 14 }}>Live rates</div>
            <div style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 3 }}>Market simulator drifts ±25bp every 60s.</div>
          </div>
          <span className="pill pill-copper">{rates?.total ?? 0} pairs</span>
        </div>
        <table className="t-table">
          <thead><tr><th>Pair</th><th>Source</th><th style={{ textAlign: 'right' }}>Rate</th><th>Updated</th></tr></thead>
          <tbody>
            {(rates?.rates ?? []).map((r) => (
              <tr key={`${r.base_currency}-${r.quote_currency}`}>
                <td className="mono" style={{ fontWeight: 600 }}>{r.base_currency} / {r.quote_currency}</td>
                <td><span className="pill pill-muted">{r.source}</span></td>
                <td className="num">{r.rate_human.toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Recent quotes</div>
          <span className="pill pill-muted">{quotes?.total ?? 0} total</span>
        </div>
        <table className="t-table">
          <thead><tr>
            <th>Quote</th><th>Pair</th><th>Status</th>
            <th style={{ textAlign: 'right' }}>Base amount</th>
            <th style={{ textAlign: 'right' }}>Quote amount</th>
            <th style={{ textAlign: 'right' }}>Spread</th>
            <th style={{ textAlign: 'right' }}>BP</th>
            <th>Expires</th>
          </tr></thead>
          <tbody>
            {(quotes?.quotes ?? []).map((q) => (
              <tr key={q.id}>
                <td className="mono" style={{ fontSize: 11.5 }}>{q.public_id}</td>
                <td className="mono">{q.base_currency} → {q.quote_currency}</td>
                <td><StatusPill value={q.status} /></td>
                <td className="amount">{fmtMinor(q.amount_minor, q.base_currency)}</td>
                <td className="amount" style={{ color: 'rgb(var(--moss))' }}>{fmtMinor(q.amount_quote_minor, q.quote_currency)}</td>
                <td className="amount" style={{ color: 'rgb(var(--copper))' }}>{fmtMinor(q.spread_minor, q.quote_currency)}</td>
                <td className="num">{q.spread_bp}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(q.expires_at)}</td>
              </tr>
            ))}
            {(!quotes?.quotes || quotes.quotes.length === 0) ? <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No FX quotes yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
