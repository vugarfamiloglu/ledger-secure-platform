'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from './Logo';

interface NavItem { href: string; label: string; icon: React.ReactNode; section?: string; }

const Icon = ({ d }: { d: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const NAV: NavItem[] = [
  { section: 'Overview', href: '/dashboard',      label: 'Mission Control', icon: <Icon d="M3 12l9-9 9 9M5 10v10h14V10" /> },
  { section: 'Overview', href: '/reports',        label: 'Reports',         icon: <Icon d="M3 3v18h18M7 14l3-3 4 4 5-6" /> },

  { section: 'Money',    href: '/accounts',       label: 'Accounts',        icon: <Icon d="M2 7h20M2 12h20M2 17h20" /> },
  { section: 'Money',    href: '/transactions',   label: 'Journal',         icon: <Icon d="M4 4h16v16H4zM4 9h16M9 4v16" /> },
  { section: 'Money',    href: '/payments',       label: 'Payments',        icon: <Icon d="M3 10h18M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" /> },
  { section: 'Money',    href: '/fx',             label: 'FX Desk',         icon: <Icon d="M7 16l-3-3 3-3M17 8l3 3-3 3M4 13h16M4 11h16" /> },

  { section: 'Controls', href: '/reconciliation', label: 'Reconciliation',  icon: <Icon d="M3 6h18M3 12h12M3 18h6M21 14l-4 4-2-2" /> },
  { section: 'Controls', href: '/fraud',          label: 'Fraud',           icon: <Icon d="M12 2L3 6v6c0 5 3.5 9 9 10 5.5-1 9-5 9-10V6l-9-4z" /> },
  { section: 'Controls', href: '/webhooks',       label: 'Webhooks',        icon: <Icon d="M18 8a3 3 0 1 0-3-3M6 16a3 3 0 1 0 3 3M14 5L7 16M19 11a3 3 0 1 1-3 3M9 11l5 8" /> },

  { section: 'System',   href: '/audit',          label: 'Audit Log',       icon: <Icon d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /> },
  { section: 'System',   href: '/settings',       label: 'Settings',        icon: <Icon d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const sections = Array.from(new Set(NAV.map((n) => n.section ?? 'Other')));

  return (
    <aside
      style={{
        width: 220, flexShrink: 0,
        height: '100vh', position: 'sticky', top: 0,
        background: 'rgb(var(--bg-soft))',
        borderRight: '1px solid rgb(var(--line))',
        display: 'flex', flexDirection: 'column',
        padding: '18px 12px 14px',
      }}
    >
      <Link href="/dashboard" style={{ textDecoration: 'none', color: 'inherit', padding: '0 6px 14px' }}>
        <Logo />
      </Link>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', flex: 1 }}>
        {sections.map((sec) => (
          <div key={sec} style={{ marginBottom: 6 }}>
            <div className="eyebrow" style={{ padding: '10px 12px 4px', fontSize: 9.5 }}>{sec}</div>
            {NAV.filter((n) => (n.section ?? 'Other') === sec).map((n) => {
              const active = pathname === n.href || pathname?.startsWith(n.href + '/');
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`nav-link ${active ? 'active' : ''}`}
                >
                  <span style={{ display: 'grid', placeItems: 'center', width: 18 }}>{n.icon}</span>
                  {n.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div style={{ padding: '10px 12px', borderTop: '1px solid rgb(var(--line-soft))', fontSize: 10.5, color: 'rgb(var(--muted))' }}>
        <div className="mono">v0.1 · {new Date().getFullYear()}</div>
      </div>
    </aside>
  );
}
