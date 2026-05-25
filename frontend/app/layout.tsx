import './globals.css';
import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/ThemeProvider';
import { NotifyProvider } from '@/components/NotifyProvider';

export const metadata: Metadata = {
  title: { default: 'Ledger Secure Platform', template: '%s · Ledger' },
  description:
    'Bank-grade double-entry payment infrastructure. Multi-currency ledger, payment orchestration, FX, reconciliation, fraud scoring and HMAC-signed webhooks behind a single back-office console.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /* suppressHydrationWarning is required because the inline
     * anti-flash script below mutates <html class="…"> before React
     * hydrates.  The flag only suppresses the warning for <html>'s
     * own attributes — child mismatches still warn as normal. */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Avoid theme flash. */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){try{var t=localStorage.getItem('ledger-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(t==='dark')document.documentElement.classList.add('dark');}catch(_){}})();
        `}} />
      </head>
      <body>
        <ThemeProvider>
          <NotifyProvider>{children}</NotifyProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
