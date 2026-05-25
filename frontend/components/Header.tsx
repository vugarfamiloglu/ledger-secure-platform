'use client';

import { useTheme } from './ThemeProvider';
import { usePathname } from 'next/navigation';

interface HeaderProps { title?: string; subtitle?: string; right?: React.ReactNode; }

const TITLES: Record<string, { title: string; subtitle?: string }> = {
  '/dashboard':       { title: 'Mission Control', subtitle: 'Live invariants, balances and platform KPIs' },
  '/accounts':        { title: 'Accounts',        subtitle: 'Typed account registry across merchants and currencies' },
  '/transactions':    { title: 'Journal',         subtitle: 'Append-only double-entry journal' },
  '/payments':        { title: 'Payments',        subtitle: 'Intent → authorize → settle lifecycle' },
  '/fx':              { title: 'FX Desk',         subtitle: 'Multi-currency quotes and executions' },
  '/reconciliation':  { title: 'Reconciliation',  subtitle: 'External statements vs internal ledger' },
  '/fraud':           { title: 'Fraud',           subtitle: 'Real-time scoring and case queue' },
  '/webhooks':        { title: 'Webhooks',        subtitle: 'HMAC-signed delivery and retry queue' },
  '/reports':         { title: 'Reports',         subtitle: 'Volume, balance and settlement reports' },
  '/audit':           { title: 'Audit Log',       subtitle: 'Operator and system event trail' },
  '/settings':        { title: 'Settings',        subtitle: 'Platform configuration' },
};

export function Header({ title: titleOverride, subtitle: subtitleOverride, right }: HeaderProps) {
  const { theme, toggle } = useTheme();
  const pathname = usePathname() ?? '/dashboard';
  const matched = Object.keys(TITLES).find((k) => pathname === k || pathname.startsWith(k + '/'));
  const computed = matched ? TITLES[matched] : { title: 'Ledger', subtitle: '' };
  const title    = titleOverride    ?? computed.title;
  const subtitle = subtitleOverride ?? computed.subtitle;

  return (
    <header
      style={{
        padding: '18px 28px 14px',
        borderBottom: '1px solid rgb(var(--line))',
        background: 'rgb(var(--bg))',
        display: 'flex', alignItems: 'flex-end', gap: 16,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="h-display" style={{ fontSize: 22, margin: 0 }}>{title}</h1>
        {subtitle ? <div style={{ fontSize: 12.5, color: 'rgb(var(--muted))', marginTop: 3 }}>{subtitle}</div> : null}
      </div>
      {right}
      <button
        className="btn-ghost"
        onClick={toggle}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title="Toggle theme"
      >
        {theme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        )}
      </button>
    </header>
  );
}
