/* Vault-mark — three stacked horizontal bars (ledger lines) inside a
 * navy square with a copper key-slot.  Renders sharp at any size. */

interface LogoProps { size?: number; wordmark?: boolean; }

export function Logo({ size = 28, wordmark = true }: LogoProps) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 40 40" aria-label="Ledger mark">
        <rect x="2" y="2" width="36" height="36" rx="6" fill="rgb(var(--navy))" />
        <rect x="8"  y="11" width="20" height="2.4" rx="1.2" fill="rgb(var(--copper))" />
        <rect x="8"  y="18.5" width="24" height="2.4" rx="1.2" fill="rgb(var(--copper))" opacity="0.85" />
        <rect x="8"  y="26"   width="16" height="2.4" rx="1.2" fill="rgb(var(--copper))" opacity="0.65" />
        <circle cx="31" cy="27" r="2.4" fill="rgb(var(--copper))" />
      </svg>
      {wordmark ? (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span className="h-display" style={{ fontSize: 15, letterSpacing: -0.01 }}>Ledger</span>
          <span className="eyebrow" style={{ fontSize: 8.5, marginTop: 2 }}>Secure Platform</span>
        </div>
      ) : null}
    </div>
  );
}
