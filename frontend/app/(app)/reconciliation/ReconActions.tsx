'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';

export function ReconActions({ hasPending }: { hasPending: boolean }) {
  const router = useRouter();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<any>('reconciliation', '/run', { method: 'POST', body: '{}' });
      notify.success(`Recon swept ${r.processed} statement(s)`, { detail: `matched ${r.matched}, partial ${r.partial}, unmatched ${r.still_unmatched}` });
      router.refresh();
    } catch (e: any) {
      notify.error('Recon run failed', { detail: e?.message });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <button className="btn-primary" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run matcher'}</button>
      {hasPending ? <span style={{ fontSize: 12, color: 'rgb(var(--muted))' }}>Pending statements available — run to attempt matches.</span> : null}
    </div>
  );
}
