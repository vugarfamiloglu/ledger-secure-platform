import { tryFetch } from '@/lib/server';
import { StatusPill } from '@/components/StatusPill';
import { fmtRelative, fmtNumber, shortId } from '@/lib/format';
import { WebhookActions } from './WebhookActions';

export const dynamic = 'force-dynamic';

interface Endpoint { id: string; public_id: string; merchant_id: string; url: string; description: string; is_active: number; created_at: string; }
interface Delivery { id: string; endpoint_id: string; event_topic: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; next_attempt_at: string | null; created_at: string; }
interface WStats { total: number; endpoints: number; by_status: Array<{ status: string; c: number }>; by_topic: Array<{ event_topic: string; c: number }>; }

export default async function WebhooksPage() {
  const [stats, endpoints, deliveries] = await Promise.all([
    tryFetch<WStats>('webhook', '/stats'),
    tryFetch<{ endpoints: Endpoint[] }>('webhook', '/endpoints'),
    tryFetch<{ deliveries: Delivery[]; total: number }>('webhook', '/deliveries?limit=100'),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <div className="kpi"><div className="eyebrow">Endpoints</div><div className="kpi-value">{fmtNumber(stats?.endpoints ?? 0)}</div></div>
        <div className="kpi"><div className="eyebrow">Deliveries</div><div className="kpi-value">{fmtNumber(stats?.total ?? 0)}</div></div>
        {(stats?.by_status ?? []).map((s) => (
          <div key={s.status} className="kpi">
            <div className="eyebrow">{s.status}</div>
            <div className="kpi-value" style={{ color: s.status === 'dead' ? 'rgb(var(--ember))' : s.status === 'succeeded' ? 'rgb(var(--moss))' : 'rgb(var(--ink))' }}>
              {fmtNumber(s.c)}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Endpoints</div>
        </div>
        <table className="t-table">
          <thead><tr><th>ID</th><th>Merchant</th><th>URL</th><th>Description</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {(endpoints?.endpoints ?? []).map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ fontSize: 11.5 }}>{e.public_id}</td>
                <td className="mono" style={{ fontSize: 11.5, color: 'rgb(var(--muted))' }}>{e.merchant_id}</td>
                <td className="mono" style={{ fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.url}</td>
                <td style={{ fontSize: 12 }}>{e.description || '—'}</td>
                <td>{e.is_active ? <StatusPill value="active" /> : <StatusPill value="inactive" />}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(e.created_at)}</td>
              </tr>
            ))}
            {(!endpoints?.endpoints || endpoints.endpoints.length === 0) ? (
              <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No endpoints registered.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Recent deliveries</div>
        </div>
        <table className="t-table">
          <thead><tr><th>ID</th><th>Topic</th><th>Status</th><th>Code</th><th>Attempts</th><th>Last error</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {(deliveries?.deliveries ?? []).map((d) => (
              <tr key={d.id}>
                <td className="mono" style={{ fontSize: 11 }}>{shortId(d.id, 8, 4)}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{d.event_topic}</td>
                <td><StatusPill value={d.status} /></td>
                <td className="num">{d.last_status_code ?? '—'}</td>
                <td className="num">{d.attempts}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--ember))', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.last_error ?? '—'}</td>
                <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(d.created_at)}</td>
                <td>{d.status === 'dead' || d.status === 'failed' ? <WebhookActions deliveryId={d.id} /> : null}</td>
              </tr>
            ))}
            {(!deliveries?.deliveries || deliveries.deliveries.length === 0) ? (
              <tr><td colSpan={8} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No deliveries yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
