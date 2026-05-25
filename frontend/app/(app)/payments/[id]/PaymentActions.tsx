'use client';

/* Client-side action buttons for capture / settle / refund / cancel.
 * Lives in its own file because the SSR page can't carry event
 * handlers across the server boundary. */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PromptModal } from '@/components/PromptModal';

type Action = 'capture' | 'settle' | 'cancel' | 'refund';

export function PaymentActions({ payment }: { payment: { id: string; public_id: string; status: string } }) {
  const router = useRouter();
  const notify = useNotify();
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirmAction, setConfirmAction] = useState<Action | null>(null);
  const [promptRefund, setPromptRefund] = useState(false);
  const [promptCancel, setPromptCancel] = useState(false);

  const run = async (action: Action, body?: any) => {
    setBusy(action);
    try {
      await api('payments', `/payments/${payment.public_id}/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      notify.success(`${action.charAt(0).toUpperCase() + action.slice(1)} succeeded`);
      router.refresh();
    } catch (e: any) {
      notify.error(`${action} failed`, { detail: e?.message });
    } finally {
      setBusy(null);
      setConfirmAction(null);
      setPromptRefund(false);
      setPromptCancel(false);
    }
  };

  const can = (a: Action) => {
    if (a === 'capture') return payment.status === 'authorized';
    if (a === 'settle')  return payment.status === 'pending' || payment.status === 'processing';
    if (a === 'cancel')  return payment.status === 'authorized' || payment.status === 'pending';
    if (a === 'refund')  return payment.status === 'settled';
    return false;
  };

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button className="btn-secondary btn-xs" disabled={!can('capture') || busy != null} onClick={() => setConfirmAction('capture')}>Capture</button>
      <button className="btn-secondary btn-xs" disabled={!can('settle')  || busy != null} onClick={() => setConfirmAction('settle')}>Settle</button>
      <button className="btn-secondary btn-xs" disabled={!can('cancel')  || busy != null} onClick={() => setPromptCancel(true)}>Cancel</button>
      <button className="btn-danger btn-xs"    disabled={!can('refund')  || busy != null} onClick={() => setPromptRefund(true)}>Refund</button>

      <ConfirmModal
        open={confirmAction !== null && confirmAction !== 'cancel' && confirmAction !== 'refund'}
        title={`${confirmAction ?? ''}?`}
        message={`Post the ${confirmAction} journal entry for ${payment.public_id}? This action is recorded on the immutable ledger.`}
        confirmLabel={`Yes, ${confirmAction}`}
        busy={busy === confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction && run(confirmAction)}
      />

      <PromptModal
        open={promptCancel}
        title="Cancel payment"
        message={`Cancellation reverses any captured ledger entries for ${payment.public_id}.`}
        placeholder="Reason (e.g. duplicate intent, customer abandoned)"
        confirmLabel="Cancel payment"
        busy={busy === 'cancel'}
        onClose={() => setPromptCancel(false)}
        onConfirm={(reason) => run('cancel', { reason: reason || 'operator_cancelled' })}
      />

      <PromptModal
        open={promptRefund}
        title="Refund payment"
        message={`This posts a full reversal for ${payment.public_id}.  Funds will flow back to the customer account on the ledger.`}
        placeholder="Reason (e.g. customer_request, fraud)"
        confirmLabel="Issue refund"
        busy={busy === 'refund'}
        onClose={() => setPromptRefund(false)}
        onConfirm={(reason) => run('refund', { reason: reason || 'customer_request' })}
      />
    </div>
  );
}
