'use client';

/* Project-wide replacement for window.confirm().  Always use this for
 * destructive actions (refund, cancel, delete endpoint, etc.). */

import { Modal } from './Modal';

interface ConfirmProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmModal({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  destructive, busy, onConfirm, onClose,
}: ConfirmProps) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      width={440}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button
            className={destructive ? 'btn-danger' : 'btn-primary'}
            onClick={() => onConfirm()}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {message ? <p style={{ margin: 0, fontSize: 13, color: 'rgb(var(--ink-2))', lineHeight: 1.55 }}>{message}</p> : null}
    </Modal>
  );
}
