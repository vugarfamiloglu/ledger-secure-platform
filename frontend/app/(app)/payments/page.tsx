import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtRelative, type Currency } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface Payment {
  id: string; public_id: string; merchant_id: string; kind: string; status: string;
  amount_minor: string; currency: Currency; fee_amount_minor: string;
  risk_score: number | null; risk_level: string | null;
  description: string; created_at: string;
}

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const k of ['status', 'kind', 'currency', 'risk_level', 'merchant_id', 'search'] as const) {
    if (sp[k]) qs.set(k, sp[k]);
  }
  qs.set('limit', '200');
  const data = await tryFetch<{ payments: Payment[]; total: number }>('payments', `/payments?${qs.toString()}`);
  const payments = data?.payments ?? [];

  const FILTERS: Array<{ key: keyof Payment | 'all'; label: string }> = [
    { key: 'all',       label: 'All' },
    { key: 'status',    label: '' },
  ];
  void FILTERS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Link href="/payments" className={!sp.status ? 'pill pill-copper' : 'pill pill-muted'}>All</Link>
        {['authorized', 'pending', 'settled', 'failed', 'refunded'].map((s) => (
          <Link key={s} href={`/payments?status=${s}`} className={sp.status === s ? 'pill pill-copper' : 'pill pill-muted'}>{s}</Link>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'rgb(var(--muted))' }}>{data?.total ?? 0} matches</span>
      </div>

      <div className="card">
        <table className="t-table">
          <thead><tr>
            <th>Payment</th><th>Merchant</th><th>Kind</th><th>Status</th>
            <th>Risk</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th style={{ textAlign: 'right' }}>Fee</th>
            <th>Description</th>
            <th>When</th>
          </tr></thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  <Link href={`/payments/${p.public_id}`} className="link">{p.public_id}</Link>
                </td>
                <td className="mono" style={{ fontSize: 11.5, color: 'rgb(var(--muted))' }}>{p.merchant_id}</td>
                <td><span className="pill pill-steel">{p.kind}</span></td>
                <td><StatusPill value={p.status} /></td>
                <td>{p.risk_level ? <StatusPill value={p.risk_level} /> : <span className="pill pill-muted">—</span>}</td>
                <td className="amount">{fmtMinor(p.amount_minor, p.currency)}</td>
                <td className="amount" style={{ color: 'rgb(var(--muted))' }}>{fmtMinor(p.fee_amount_minor || '0', p.currency)}</td>
                <td style={{ fontSize: 12 }}>{p.description || '—'}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(p.created_at)}</td>
              </tr>
            ))}
            {payments.length === 0 ? <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No payments match the filter.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
