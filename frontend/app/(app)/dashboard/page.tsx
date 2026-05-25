/* Mission Control — the operator's single-pane-of-glass.  Pulls
 * stats from every service, surfaces invariant health, recent
 * activity and the open-cases backlog. */

import { tryFetch } from '@/lib/server';
import { KpiCard } from '@/components/KpiCard';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtNumber, fmtRelative, fmtPercent, type Currency } from '@/lib/format';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface InvariantResult { ok: boolean; balance_drift: number; unbalanced_entries: number; checked_at: string; }
interface LedgerStats { accounts: number; journal_entries: number; postings: number; reversals: number; }
interface PaymentsStats { total: number; by_status: Array<{ status: string; c: number }>; by_currency: Array<{ currency: Currency; c: number; gross: number }>; last_24h: { c: number; gross: number }; }
interface FxStats { quotes_total: number; by_status: Array<{ status: string; c: number }>; rates_tracked: number; }
interface ReconStats { total: number; by_state: Array<{ state: string; c: number }>; matched_amount: { v: number }; heal_pending: number; }
interface FraudStats { scored_total: number; by_level: Array<{ level: string; c: number }>; open_cases: number; }
interface WebhookStats { total: number; endpoints: number; by_status: Array<{ status: string; c: number }>; recent_failures: any[]; }

export default async function DashboardPage() {
  const [invariant, ledger, payments, fx, recon, fraud, webhook] = await Promise.all([
    tryFetch<InvariantResult>('ledger',         '/invariant'),
    tryFetch<LedgerStats>     ('ledger',        '/stats'),
    tryFetch<PaymentsStats>   ('payments',      '/stats'),
    tryFetch<FxStats>         ('fx',            '/stats'),
    tryFetch<ReconStats>      ('reconciliation','/stats'),
    tryFetch<FraudStats>      ('fraud',         '/stats'),
    tryFetch<WebhookStats>    ('webhook',       '/stats'),
  ]);

  const settledPct = (() => {
    if (!payments?.by_status?.length) return 0;
    const settled = payments.by_status.find((s) => s.status === 'settled')?.c ?? 0;
    return payments.total > 0 ? settled / payments.total : 0;
  })();
  const matchedPct = (() => {
    if (!recon?.by_state?.length) return 0;
    const matched = recon.by_state.find((s) => s.state === 'matched')?.c ?? 0;
    return recon.total > 0 ? matched / recon.total : 0;
  })();
  const webhookSuccess = (() => {
    if (!webhook?.by_status?.length) return 0;
    const ok = webhook.by_status.find((s) => s.status === 'succeeded')?.c ?? 0;
    return webhook.total > 0 ? ok / webhook.total : 0;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Invariant banner ── */}
      <div className={invariant?.ok ? 'alert alert-success' : 'alert alert-error'}>
        <div style={{ flex: 1 }}>
          <strong>{invariant?.ok ? 'Ledger invariant holds' : 'Invariant breach detected'}</strong>
          {invariant ? (
            <span style={{ marginLeft: 12, fontSize: 11.5, color: 'rgb(var(--muted))' }}>
              Last check {fmtRelative(invariant.checked_at)} · {invariant.balance_drift} drift · {invariant.unbalanced_entries} unbalanced
            </span>
          ) : (
            <span style={{ marginLeft: 12, fontSize: 11.5, color: 'rgb(var(--muted))' }}>
              Ledger service offline — start it with <code className="kbd">npm run dev:ledger</code>
            </span>
          )}
        </div>
        <Link href="/transactions" className="btn-ghost" style={{ fontSize: 11 }}>Open journal →</Link>
      </div>

      {/* ── KPI row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KpiCard label="Accounts"        value={fmtNumber(ledger?.accounts ?? 0)} hint={`${ledger?.journal_entries ?? 0} JEs · ${ledger?.postings ?? 0} postings`} />
        <KpiCard label="Payments total"  value={fmtNumber(payments?.total ?? 0)}  hint={`${payments?.last_24h?.c ?? 0} in last 24h`} tone="copper" />
        <KpiCard label="Settled %"       value={fmtPercent(settledPct)}            tone={settledPct > 0.8 ? 'moss' : 'amber'} />
        <KpiCard label="FX quotes"       value={fmtNumber(fx?.quotes_total ?? 0)} hint={`${fx?.rates_tracked ?? 0} rates tracked`} />
        <KpiCard label="Recon matched"   value={fmtPercent(matchedPct)} hint={`${recon?.heal_pending ?? 0} heal queued`} tone={matchedPct > 0.9 ? 'moss' : 'amber'} />
        <KpiCard label="Open fraud cases"value={fmtNumber(fraud?.open_cases ?? 0)} hint={`${fraud?.scored_total ?? 0} scored`} tone={(fraud?.open_cases ?? 0) > 5 ? 'ember' : 'moss'} />
        <KpiCard label="Webhook success" value={fmtPercent(webhookSuccess)} hint={`${webhook?.endpoints ?? 0} endpoints`} tone={webhookSuccess > 0.95 ? 'moss' : 'amber'} />
        <KpiCard label="Reversals"       value={fmtNumber(ledger?.reversals ?? 0)} tone="muted" />
      </div>

      {/* ── Two-column status row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div className="card">
          <div style={{ padding: '14px 18px 8px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
            <div className="h-display" style={{ fontSize: 14 }}>Payments by status</div>
          </div>
          <div style={{ padding: 14 }}>
            {payments?.by_status?.length ? (
              <table className="t-table" style={{ width: '100%' }}>
                <thead><tr><th>Status</th><th style={{ textAlign: 'right' }}>Count</th></tr></thead>
                <tbody>
                  {payments.by_status.map((s) => (
                    <tr key={s.status}>
                      <td><StatusPill value={s.status} /></td>
                      <td className="num">{fmtNumber(s.c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ fontSize: 12, color: 'rgb(var(--muted))', padding: '8px 4px' }}>No payments yet — run the seed.</div>}
          </div>
        </div>

        <div className="card">
          <div style={{ padding: '14px 18px 8px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
            <div className="h-display" style={{ fontSize: 14 }}>Recent webhook failures</div>
          </div>
          <div style={{ padding: 14 }}>
            {webhook?.recent_failures?.length ? (
              <table className="t-table">
                <thead><tr><th>Topic</th><th>Attempts</th><th>Last</th></tr></thead>
                <tbody>
                  {webhook.recent_failures.slice(0, 5).map((d: any) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{d.event_topic}</td>
                      <td className="num">{d.attempts}</td>
                      <td><StatusPill value={d.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div style={{ fontSize: 12, color: 'rgb(var(--muted))', padding: '8px 4px' }}>No failures in the last window.</div>}
          </div>
        </div>
      </div>

      {/* ── Currency breakdown ── */}
      {payments?.by_currency?.length ? (
        <div className="card">
          <div style={{ padding: '14px 18px 8px', borderBottom: '1px solid rgb(var(--line-soft))', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="h-display" style={{ fontSize: 14 }}>Gross volume by currency</div>
            <Link href="/reports" className="link" style={{ fontSize: 11 }}>Full reports →</Link>
          </div>
          <div style={{ padding: 14 }}>
            <table className="t-table">
              <thead><tr><th>Currency</th><th style={{ textAlign: 'right' }}>Payments</th><th style={{ textAlign: 'right' }}>Gross volume</th></tr></thead>
              <tbody>
                {payments.by_currency.map((c) => (
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
      ) : null}
    </div>
  );
}
