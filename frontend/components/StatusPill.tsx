/* Project-wide pill renderer.  Knows how to colour every payment
 * status, risk level, reconciliation state and webhook delivery
 * status the platform produces.  Falls back to a neutral pill for
 * anything unknown. */

type Variant = 'copper' | 'moss' | 'ember' | 'amber' | 'steel' | 'muted';

const MAP: Record<string, Variant> = {
  /* Payment statuses */
  initiated:  'steel',
  authorized: 'copper',
  pending:    'amber',
  processing: 'amber',
  settled:    'moss',
  failed:     'ember',
  reversed:   'ember',
  refunded:   'muted',
  expired:    'muted',
  /* Risk levels */
  low:        'moss',
  medium:     'amber',
  high:       'ember',
  critical:   'ember',
  /* Reconciliation states */
  matched:    'moss',
  partial:    'amber',
  unmatched:  'ember',
  duplicate:  'muted',
  suspicious: 'ember',
  /* Webhook deliveries */
  succeeded:  'moss',
  dead:       'ember',
  /* FX */
  open:       'copper',
  locked:     'copper',
  executed:   'moss',
  /* Misc */
  active:     'moss',
  inactive:   'muted',
  ok:         'moss',
  warning:    'amber',
  error:      'ember',
};

export function StatusPill({ value, label }: { value: string; label?: string }) {
  const v = (value ?? '').toString().toLowerCase();
  const variant = MAP[v] ?? 'muted';
  return <span className={`pill pill-${variant}`}>{(label ?? value ?? '—').toString().toUpperCase()}</span>;
}
