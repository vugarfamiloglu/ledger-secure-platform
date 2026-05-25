import { tryFetch } from '@/lib/server';
import { fmtDate, fmtRelative, shortId } from '@/lib/format';
import { StatusPill } from '@/components/StatusPill';

export const dynamic = 'force-dynamic';

interface JE {
  id: string; public_id: string; description: string; metadata_json: string; posted_at: string; reversal_of: string | null;
}

export default async function JournalPage() {
  const data = await tryFetch<{ entries: JE[]; total: number }>('ledger', '/entries?limit=200');
  const entries = data?.entries ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="pill pill-muted">{data?.total ?? 0} entries</span>
        <span className="pill pill-copper">Append-only · SQLite triggers enforce immutability</span>
      </div>

      <div className="card">
        <table className="t-table">
          <thead><tr><th>Entry</th><th>Description</th><th>Type</th><th>Posted</th><th style={{ textAlign: 'right' }}>Age</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ fontSize: 11.5 }}>{e.public_id}</td>
                <td>{e.description}</td>
                <td>{e.reversal_of ? <StatusPill value="reversed" label="REVERSAL" /> : <span className="pill pill-muted">POST</span>}</td>
                <td style={{ fontSize: 11.5, color: 'rgb(var(--muted))' }}>{fmtDate(e.posted_at)}</td>
                <td className="num" style={{ fontSize: 11, color: 'rgb(var(--muted))' }}>{fmtRelative(e.posted_at)}</td>
              </tr>
            ))}
            {entries.length === 0 ? <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'rgb(var(--muted))' }}>No journal entries yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
