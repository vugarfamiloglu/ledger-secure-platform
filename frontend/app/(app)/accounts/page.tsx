import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtDate, shortId, type Currency } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface Account {
  id: string; public_id: string; merchant_id: string | null; type: string; currency: Currency; name: string;
  balance_available: string; balance_pending: string; balance_reserved: string;
  balance_available_oriented: string; balance_pending_oriented: string; balance_reserved_oriented: string;
  balance_total_oriented: string;
  normal_side: 'debit' | 'credit'; is_active: boolean; created_at: string;
}

export default async function AccountsPage() {
  const data = await tryFetch<{ accounts: Account[]; total: number }>('ledger', '/accounts');
  const accounts = data?.accounts ?? [];

  /* Group by account type so operators see "all merchants", "all
   * customers", "treasury accounts" as logical clusters. */
  const groups = new Map<string, Account[]>();
  for (const a of accounts) {
    const arr = groups.get(a.type) ?? [];
    arr.push(a); groups.set(a.type, arr);
  }
  const orderedTypes = ['merchant', 'customer', 'treasury', 'fee', 'reserve', 'settlement', 'fx_pool', 'escrow', 'dispute', 'external'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className="pill pill-muted">{accounts.length} accounts</span>
        <span className="pill pill-copper">{Array.from(new Set(accounts.map((a) => a.currency))).join(' · ') || '—'}</span>
      </div>

      {accounts.length === 0 ? (
        <div className="alert alert-info">No accounts yet — start the ledger and run <code className="kbd">npm run seed</code>.</div>
      ) : null}

      {orderedTypes.filter((t) => groups.has(t)).map((type) => (
        <div key={type} className="card">
          <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="h-display" style={{ fontSize: 14, textTransform: 'capitalize' }}>{type.replace('_', ' ')}</div>
              <div style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 2 }}>Normal side: {groups.get(type)?.[0]?.normal_side ?? '—'}</div>
            </div>
            <span className="pill pill-muted">{groups.get(type)?.length}</span>
          </div>
          <table className="t-table">
            <thead><tr>
              <th>ID</th><th>Name</th><th>Currency</th><th>Merchant</th>
              <th style={{ textAlign: 'right' }}>Available</th>
              <th style={{ textAlign: 'right' }}>Pending</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th>Created</th>
            </tr></thead>
            <tbody>
              {groups.get(type)!.map((a) => {
                const total = BigInt(a.balance_total_oriented);
                const totalClass = total > 0n ? 'amount amount-pos' : total < 0n ? 'amount amount-neg' : 'amount';
                return (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{a.public_id}</td>
                    <td>{a.name}</td>
                    <td><span className="pill pill-steel">{a.currency}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{shortId(a.merchant_id ?? '—', 10, 4)}</td>
                    <td className="amount">{fmtMinor(a.balance_available_oriented, a.currency)}</td>
                    <td className="amount" style={{ color: 'rgb(var(--amber))' }}>{fmtMinor(a.balance_pending_oriented, a.currency)}</td>
                    <td className={totalClass}>{fmtMinor(a.balance_total_oriented, a.currency)}</td>
                    <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtDate(a.created_at, { time: false })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
