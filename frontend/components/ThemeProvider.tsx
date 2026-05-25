'use client';

/* Theme provider — persists the user choice to localStorage under
 * `ledger-theme`.  Initial value is read by an inline <script> in
 * layout.tsx so the page never flashes the wrong colours. */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
interface ThemeCtx { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void; }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    /* Recover whatever the no-flash script chose. */
    const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('ledger-theme')) as Theme | null;
    const initial: Theme = stored ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setThemeState(initial);
    document.documentElement.classList.toggle('dark', initial === 'dark');
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.classList.toggle('dark', t === 'dark');
    try { localStorage.setItem('ledger-theme', t); } catch { /* private mode etc. */ }
  }, []);

  const toggle = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  return <Ctx.Provider value={{ theme, toggle, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
