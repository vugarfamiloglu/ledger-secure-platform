import { redirect } from 'next/navigation';

/* The platform has no marketing front — everything lives inside the
 * operator console.  Redirect / → /dashboard. */

export default function RootPage(): never {
  redirect('/dashboard');
}
