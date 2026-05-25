import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

/* Every page below the (app) route group renders inside the standard
 * operator shell — sidebar, header, footer. */

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
