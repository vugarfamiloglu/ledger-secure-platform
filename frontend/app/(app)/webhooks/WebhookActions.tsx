'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';

export function WebhookActions({ deliveryId }: { deliveryId: string }) {
  const router = useRouter();
  const notify = useNotify();
  const [busy, setBusy] = useState(false);

  const replay = async () => {
    setBusy(true);
    try {
      await api('webhook', `/deliveries/${deliveryId}/replay`, { method: 'POST' });
      notify.success('Replay queued');
      router.refresh();
    } catch (e: any) {
      notify.error('Replay failed', { detail: e?.message });
    } finally { setBusy(false); }
  };

  return (
    <button className="btn-secondary btn-xs" onClick={replay} disabled={busy}>
      {busy ? '…' : 'Replay'}
    </button>
  );
}
