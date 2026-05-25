import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtMinor, fmtDate, fmtRelative, shortId, type Currency } from '@/lib/format';
import { PaymentActions } from './PaymentActions';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface Payment {
  id: string; public_id: string; merchant_id: string; kind: string; status: string;
  amount_minor: string; currency: Currency; fee_amount_minor: string;
  from_account_id: string | null; to_account_id: string | null; fee_account_id: string | null;
  capture_je_id: string | null; settle_je_id: string | null; refund_je_id: string | null;
  risk_score: number | null; risk_level: string | null; risk_signals_json: string | null;
  description: string; metadata_json: string; failure_reason: string | null;
  created_at: string; updated_at: string; captured_at: string | null; settled_at: string | null; refunded_at: string | null;
}
interface Event { id: number; event: string; from_status: string | null; to_status: string | null; detail_json: string; actor: string; occurred_at: string; }

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await tryFetch<{ payment: Payment; events: Event[] }>('payments', `/payments/${id}`);
  if (!data) notFound();
  const { payment, events } = data;
  const signals: string[] = payment.risk_signals_json ? JSON.parse(payment.risk_signals_json) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/payments" className="link" style={{ fontSize: 12 }}>← Back to payments</Link>
        <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{payment.public_id}</span>
        <StatusPill value={payment.status} />
        {payment.risk_level ? <StatusPill value={payment.risk_level} label={`risk ${payment.risk_level}`} /> : null}
        <span style={{ flex: 1 }} />
        <PaymentActions payment={payment} />
      </div>

      {/* ── Summary grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow">Gross</div>
          <div className="kpi-value">{fmtMinor(payment.amount_minor, payment.currency)}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow">Fee</div>
          <div className="kpi-value" style={{ color: 'rgb(var(--muted))' }}>{fmtMinor(payment.fee_amount_minor || '0', payment.currency)}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow">Net to merchant</div>
          <div className="kpi-value" style={{ color: 'rgb(var(--moss))' }}>{fmtMinor(BigInt(payment.amount_minor) - BigInt(payment.fee_amount_minor || '0'), payment.currency)}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="eyebrow">Risk score</div>
          <div className="kpi-value" style={{ color: payment.risk_level === 'critical' || payment.risk_level === 'high' ? 'rgb(var(--ember))' : 'rgb(var(--ink))' }}>
            {payment.risk_score != null ? payment.risk_score.toFixed(2) : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        {/* ── Lifecycle timeline ── */}
        <div className="card">
          <div style={{ padding: '14px 18px 8px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
            <div className="h-display" style={{ fontSize: 14 }}>Lifecycle</div>
          </div>
          <div style={{ padding: 18 }}>
            <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {events.map((e) => {
                const detail = e.detail_json ? (() => { try { return JSON.parse(e.detail_json); } catch { return {}; } })() : {};
                return (
                  <li key={e.id} style={{ display: 'flex', gap: 12 }}>
                    <div style={{
                      width: 9, height: 9, borderRadius: '50%',
                      background: e.to_status === 'failed' ? 'rgb(var(--ember))' : e.to_status === 'settled' ? 'rgb(var(--moss))' : 'rgb(var(--copper))',
                      flexShrink: 0, marginTop: 6,
                    }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 12.5 }}>{e.event}</strong>
                        {e.from_status && e.to_status ? (
                          <span className="mono" style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{e.from_status} → {e.to_status}</span>
                        ) : e.to_status ? (
                          <span className="mono" style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>→ {e.to_status}</span>
                        ) : null}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtDate(e.occurred_at)}</span>
                      </div>
                      {Object.keys(detail).length ? (
                        <div className="mono" style={{ fontSize: 10.5, color: 'rgb(var(--muted))', marginTop: 3, wordBreak: 'break-all' }}>
                          {Object.entries(detail).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' · ')}
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* ── Properties panel ── */}
        <div className="card">
          <div style={{ padding: '14px 18px 8px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
            <div className="h-display" style={{ fontSize: 14 }}>Properties</div>
          </div>
          <dl style={{ padding: 16, margin: 0, display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 7, columnGap: 12, fontSize: 12 }}>
            <dt style={{ color: 'rgb(var(--muted))' }}>Merchant</dt><dd className="mono" style={{ margin: 0 }}>{payment.merchant_id}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>Kind</dt><dd style={{ margin: 0 }}>{payment.kind}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>From acct</dt><dd className="mono" style={{ margin: 0 }}>{shortId(payment.from_account_id)}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>To acct</dt><dd className="mono" style={{ margin: 0 }}>{shortId(payment.to_account_id)}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>Fee acct</dt><dd className="mono" style={{ margin: 0 }}>{shortId(payment.fee_account_id)}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>Capture JE</dt><dd className="mono" style={{ margin: 0 }}>{shortId(payment.capture_je_id)}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>Settle JE</dt><dd className="mono" style={{ margin: 0 }}>{shortId(payment.settle_je_id)}</dd>
            <dt style={{ color: 'rgb(var(--muted))' }}>Risk signals</dt><dd style={{ margin: 0 }}>{signals.length ? signals.map((s) => <span key={s} className="pill pill-amber" style={{ marginRight: 4, marginBottom: 4 }}>{s}</span>) : '—'}</dd>
            {payment.failure_reason ? <><dt style={{ color: 'rgb(var(--muted))' }}>Failure</dt><dd style={{ margin: 0, color: 'rgb(var(--ember))' }}>{payment.failure_reason}</dd></> : null}
            <dt style={{ color: 'rgb(var(--muted))' }}>Created</dt><dd style={{ margin: 0 }}>{fmtRelative(payment.created_at)} · <span className="mono" style={{ fontSize: 10.5 }}>{fmtDate(payment.created_at)}</span></dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
