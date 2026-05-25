'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useNotify } from '@/components/NotifyProvider';
import { PromptModal } from '@/components/PromptModal';

export function FraudCaseActions({ caseId }: { caseId: string }) {
  const router = useRouter();
  const notify = useNotify();
  const [busy, setBusy] = useState<string | null>(null);
  const [promptDecision, setPromptDecision] = useState<'approved' | 'rejected' | null>(null);

  const resolve = async (decision: 'approved' | 'rejected', note: string) => {
    setBusy(decision);
    try {
      await api('fraud', `/cases/${caseId}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision, decided_by: 'operator', note }),
      });
      notify.success(`Case ${caseId} ${decision}`);
      router.refresh();
    } catch (e: any) {
      notify.error('Resolve failed', { detail: e?.message });
    } finally { setBusy(null); setPromptDecision(null); }
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-secondary btn-xs" disabled={busy != null} onClick={() => setPromptDecision('approved')}>Approve</button>
        <button className="btn-danger btn-xs"    disabled={busy != null} onClick={() => setPromptDecision('rejected')}>Reject</button>
      </div>
      <PromptModal
        open={promptDecision != null}
        title={`${promptDecision === 'approved' ? 'Approve' : 'Reject'} case ${caseId}`}
        placeholder="Reviewer note (optional)"
        multiline
        confirmLabel="Confirm"
        busy={busy != null}
        onClose={() => setPromptDecision(null)}
        onConfirm={(note) => promptDecision && resolve(promptDecision, note)}
      />
    </>
  );
}
