/* Settings — exposes runtime configuration (read-only for the demo).
 * Edits to these would normally cycle pods; the dashboard's purpose
 * here is to show operators what each service is currently using. */

export const dynamic = 'force-dynamic';

const PORTS = [
  ['Frontend',       process.env.LEDGER_FRONTEND_PORT       ?? '5110'],
  ['Ledger',         process.env.LEDGER_LEDGER_PORT         ?? '5111'],
  ['Payments',       process.env.LEDGER_PAYMENTS_PORT       ?? '5112'],
  ['FX',             process.env.LEDGER_FX_PORT             ?? '5113'],
  ['Reconciliation', process.env.LEDGER_RECONCILIATION_PORT ?? '5114'],
  ['Fraud',          process.env.LEDGER_FRAUD_PORT          ?? '5115'],
  ['Webhook',        process.env.LEDGER_WEBHOOK_PORT        ?? '5116'],
];

const POLICIES = [
  ['Idempotency TTL',         '24 hours'],
  ['Webhook max attempts',    process.env.LEDGER_WEBHOOK_MAX_ATTEMPTS ?? '8'],
  ['Webhook backoff base',    '30 s · doubles · capped at 1h'],
  ['Webhook signature window','±300 s'],
  ['Payment auto-expire',     '30 min for initiated/authorized'],
  ['FX quote TTL',            '90 s default (30–600s allowed)'],
  ['FX spread default',       '25 bp'],
  ['Recon auto-run',          'every 5 min'],
  ['Invariant scan',          'every 30 s'],
  ['Fraud baseline',          'Welford online (mean + variance)'],
];

export default function SettingsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Service ports</div>
          <div style={{ fontSize: 11, color: 'rgb(var(--muted))', marginTop: 2 }}>Set via <code className="kbd">.env.local</code>.</div>
        </div>
        <table className="t-table">
          <thead><tr><th>Service</th><th style={{ textAlign: 'right' }}>Port</th><th>Health</th></tr></thead>
          <tbody>
            {PORTS.map(([n, p]) => (
              <tr key={n}>
                <td>{n}</td>
                <td className="mono num">{p}</td>
                <td><code className="kbd">http://localhost:{p}/health</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{ padding: '12px 18px', borderBottom: '1px solid rgb(var(--line-soft))' }}>
          <div className="h-display" style={{ fontSize: 14 }}>Operational policies</div>
        </div>
        <table className="t-table">
          <thead><tr><th>Policy</th><th>Value</th></tr></thead>
          <tbody>
            {POLICIES.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="mono" style={{ fontSize: 11.5 }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="alert alert-info">
        Tip: every state-mutating endpoint accepts <code className="kbd">Idempotency-Key</code>. Use it on every retry to avoid duplicate side-effects.
      </div>
    </div>
  );
}
