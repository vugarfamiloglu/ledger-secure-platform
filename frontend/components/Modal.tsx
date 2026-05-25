'use client';

/* React-portal modal so it always escapes scroll containers and z-stacks. */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  width?: number;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  hideClose?: boolean;
}

export function Modal({ open, onClose, title, subtitle, width = 520, children, footer, hideClose }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open || !mounted) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(10, 22, 40, 0.55)',
        display: 'grid', placeItems: 'center', padding: 24,
        animation: 'toast-in .15s ease',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: width,
          background: 'rgb(var(--card))', borderRadius: 8,
          border: '1px solid rgb(var(--line))',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex', flexDirection: 'column',
          maxHeight: 'calc(100vh - 48px)',
        }}
      >
        {(title || subtitle || !hideClose) && (
          <div style={{ padding: '18px 22px 0', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title ? <div className="h-display" style={{ fontSize: 17 }}>{title}</div> : null}
              {subtitle ? <div style={{ fontSize: 12, color: 'rgb(var(--muted))', marginTop: 4 }}>{subtitle}</div> : null}
            </div>
            {!hideClose && (
              <button
                onClick={onClose}
                className="btn-ghost"
                aria-label="Close"
                style={{ fontSize: 18, lineHeight: 1, padding: '2px 8px' }}
              >×</button>
            )}
          </div>
        )}
        <div style={{ padding: '14px 22px', overflowY: 'auto' }}>{children}</div>
        {footer ? (
          <div style={{ padding: '12px 22px 18px', borderTop: '1px solid rgb(var(--line-soft))', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
