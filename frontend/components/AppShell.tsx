import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { Footer } from './Footer';

/* Two-column shell: sticky sidebar on the left, header + scrollable
 * content + footer on the right.  Per-page Header overrides supported
 * via the `<Header>` component imported standalone if needed. */

export function AppShell({ children, header }: { children: ReactNode; header?: ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'rgb(var(--bg))' }}>
      <Sidebar />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {header ?? <Header />}
        <div style={{ padding: '20px 28px 28px', flex: 1, minWidth: 0 }}>{children}</div>
        <Footer />
      </main>
    </div>
  );
}
