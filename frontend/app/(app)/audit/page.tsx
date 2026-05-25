/* Audit log — surfaces the most recent events flowing through the
 * broker.  In a production deployment this would tail an immutable
 * audit_log table; the broker stream is a usable proxy for the demo. */

import { tryFetch } from '@/lib/server';
import { fmtDate, fmtRelative } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Webhook { id: string; endpoint_id: string; event_topic: string; status: string; attempts: number; created_at: string; last_attempt_at: string | null; payload_json: string; }

/* The webhook service holds a record of every event it ever saw (one
 * row per delivery attempt), so it's the easiest source of a chrono-
 * logical feed for the audit page. */

export default async function AuditPage() {
  const data = await tryFetch<{ deliveries: Webhook[]; total: number }>('webhook', '/deliveries?limit=200');
  const items = data?.deliveries ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="alert alert-info">
        Event audit derives from the webhook fanout queue — every event that touched the broker, with its delivery outcome.
      </div>

      <div className="card">
        <table className="t-table">
          <thead><tr>
            <th>When</th><th>Topic</th><th>Outcome</th><th>Attempts</th><th>Payload (first 60 chars)</th>
          </tr></thead>
          <tbody>
            {items.map((e) => {
              const blob = (e.payload_json || '').replace(/\s+/g, ' ').slice(0, 60);
              return (
                <tr key={e.id}>
                  <td style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>
                    <div>{fmtDate(e.created_at)}</div>
                    <div style={{ fontSize: 10 }}>{fmtRelative(e.created_at)}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{e.event_topic}</td>
                  <td><span className={`pill ${e.status === 'succeeded' ? 'pill-moss' : e.status === 'dead' ? 'pill-ember' : e.status === 'failed' ? 'pill-amber' : 'pill-muted'}`}>{e.status.toUpperCase()}</span></td>
                  <td className="num">{e.attempts}</td>
                  <td className="mono" style={{ fontSize: 10.5, color: 'rgb(var(--muted))' }}>{blob}…</td>
                </tr>
              );
            })}
            {items.length === 0 ? <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No audit entries yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
