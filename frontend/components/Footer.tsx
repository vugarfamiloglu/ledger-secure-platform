export function Footer() {
  return (
    <footer
      style={{
        padding: '12px 28px',
        borderTop: '1px solid rgb(var(--line))',
        background: 'rgb(var(--bg))',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 11, color: 'rgb(var(--muted))',
      }}
    >
      <div className="mono">Ledger Secure Platform · ACID double-entry · multi-currency · HMAC-signed</div>
      <div className="mono">Vault build · {new Date().getFullYear()}</div>
    </footer>
  );
}
