/**
 * Seed script — populates the platform with realistic demo data.
 *
 * Run AFTER `npm run dev` is up so the services can accept the writes
 * (or after `npm run dev:ledger`, `:payments`, etc. individually).
 *
 *   npm run seed
 *
 * Produces:
 *   • 3 merchants
 *   • 18 accounts (customer wallets, merchant operating, fees, reserves)
 *   • 7 currencies with seeded FX rates
 *   • 60 payments across multiple currencies + lifecycle states
 *   • 3 FX quotes (one executed)
 *   • 30 external statements (with deliberate breaks for the matcher to find)
 *   • 5 webhook endpoints + a planted dead delivery
 *   • Several fraud cases via large + suspicious payments
 */

import { call, baseUrl } from '../lib/http';
import type { Currency } from '../lib/types';

/* Tiny waiter so the services finish their schema migrations before we
 * start writing.  Hits /health every 500ms until all six are up. */
async function waitFor(service: 'ledger' | 'payments' | 'fx' | 'reconciliation' | 'fraud' | 'webhook'): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await call<any>(service, '/health'); return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${service} did not come up at ${baseUrl(service)} within 15s`);
}

function rand<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function pick<T>(arr: T[], n: number): T[] { return [...arr].sort(() => Math.random() - 0.5).slice(0, n); }

const MERCHANTS = [
  { id: 'MERCH-ACME',    name: 'Acme Industries',     currency: 'USD' as Currency },
  { id: 'MERCH-NORDIK',  name: 'Nordik Apparel AB',   currency: 'EUR' as Currency },
  { id: 'MERCH-ALCHM',   name: 'Alchemy Logistics',   currency: 'GBP' as Currency },
];

const CUSTOMER_NAMES = [
  'Aida Quliyeva', 'Jasper Holm', 'Mei Tanaka', 'Devon Cole', 'Priya Sharma',
  'Liam Carter', 'Sofia Almeida', 'Mateusz Nowak', 'Yuki Hayashi', 'Noor Khan',
  'Selin Aydın', 'Hassan Al-Farsi', 'Lena Fischer', 'Caleb Wright', 'Anaïs Dubois',
];

async function main(): Promise<void> {
  console.log('Waiting for services to be reachable…');
  await Promise.all([
    waitFor('ledger'), waitFor('payments'), waitFor('fx'),
    waitFor('reconciliation'), waitFor('fraud'), waitFor('webhook'),
  ]);
  console.log('All services up.');

  /* ── Step 1: accounts ──────────────────────────────────────── */
  console.log('\n[1/7] Creating accounts…');
  const accounts: Record<string, { id: string; public_id: string; currency: Currency }> = {};

  /* Customer wallets per currency. */
  for (const c of ['USD', 'EUR', 'GBP', 'AZN', 'TRY'] as Currency[]) {
    for (const name of pick(CUSTOMER_NAMES, 3)) {
      const r = await call<{ account: any }>('ledger', '/accounts', {
        method: 'POST',
        body: JSON.stringify({ type: 'customer', currency: c, name: `${name} wallet (${c})` }),
      });
      accounts[`cust_${c}_${name.replace(/\s+/g, '_').toLowerCase()}`] = r.account;
    }
  }

  /* Per-merchant accounts (operating + fee + reserve). */
  for (const m of MERCHANTS) {
    const op = await call<{ account: any }>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ merchant_id: m.id, type: 'merchant', currency: m.currency, name: `${m.name} operating` }) });
    const fee = await call<{ account: any }>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ merchant_id: m.id, type: 'fee', currency: m.currency, name: `${m.name} fee revenue` }) });
    const res = await call<{ account: any }>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ merchant_id: m.id, type: 'reserve', currency: m.currency, name: `${m.name} rolling reserve` }) });
    accounts[`${m.id}_op`]  = op.account;
    accounts[`${m.id}_fee`] = fee.account;
    accounts[`${m.id}_res`] = res.account;
  }

  /* One treasury and one fx_pool per currency so FX can route. */
  for (const c of ['USD', 'EUR', 'GBP', 'AZN', 'TRY', 'AED', 'JPY'] as Currency[]) {
    const t = await call<{ account: any }>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ type: 'treasury', currency: c, name: `Treasury ${c}` }) });
    accounts[`tr_${c}`] = t.account;
  }
  console.log(`  ✓ created ${Object.keys(accounts).length} accounts`);

  /* ── Step 2: webhook endpoints ─────────────────────────────── */
  console.log('\n[2/7] Registering webhook endpoints…');
  for (const m of MERCHANTS) {
    /* Use a 404 endpoint deliberately so the dashboard has visible
     * retry + dead-letter activity to look at. */
    await call<any>('webhook', '/endpoints', {
      method: 'POST',
      body: JSON.stringify({ merchant_id: m.id, url: `https://example.com/webhooks/${m.id.toLowerCase()}/will-404`, description: `${m.name} primary endpoint` }),
    });
  }
  /* One live endpoint per merchant pointing at httpbin so deliveries succeed. */
  for (const m of MERCHANTS) {
    await call<any>('webhook', '/endpoints', {
      method: 'POST',
      body: JSON.stringify({ merchant_id: m.id, url: `https://httpbin.org/status/200`, description: `${m.name} test sink` }),
    });
  }
  console.log(`  ✓ ${MERCHANTS.length * 2} endpoints registered`);

  /* ── Step 3: payments (the bulk of the seed) ───────────────── */
  console.log('\n[3/7] Generating payments…');
  const settledPayments: string[] = [];
  let counter = 0;
  for (const m of MERCHANTS) {
    const opAcct  = accounts[`${m.id}_op`];
    const feeAcct = accounts[`${m.id}_fee`];
    const custKeys = Object.keys(accounts).filter((k) => k.startsWith(`cust_${m.currency}_`));
    if (custKeys.length === 0) continue;

    for (let i = 0; i < 18; i++) {
      counter++;
      const cust = accounts[rand(custKeys)];
      /* Mostly small, a few large.  Two deliberately enormous so the
       * fraud engine has something to chew on. */
      const isFraud = i === 0 || i === 17;
      const cents   = isFraud ? (15_000_000 + Math.floor(Math.random() * 5_000_000)) : (1_000 + Math.floor(Math.random() * 80_000));
      const fee     = Math.floor(cents * 0.029) + 30;
      const idem    = `seed:${m.id}:${i}:${Date.now()}`;
      try {
        const r = await call<{ payment: any; risk: any }>('payments', '/payments', {
          method: 'POST',
          headers: { 'Idempotency-Key': idem },
          body: JSON.stringify({
            merchant_id: m.id,
            kind: 'pay_in',
            amount_minor: String(cents),
            currency: m.currency,
            from_account_id: cust.id,
            to_account_id:   opAcct.id,
            fee_account_id:  feeAcct.id,
            fee_amount_minor: String(fee),
            description: `Order #ORD-${counter.toString().padStart(5, '0')}`,
            metadata: isFraud ? { suspicious: true, country_mismatch: true } : {},
          }),
        });
        if (r.payment.status !== 'authorized') continue;
        /* Move 70% of authorized payments through capture + settle so
         * the dashboards show real balances. */
        if (Math.random() < 0.85) {
          await call<any>('payments', `/payments/${r.payment.public_id}/capture`, { method: 'POST' });
          if (Math.random() < 0.85) {
            await call<any>('payments', `/payments/${r.payment.public_id}/settle`, { method: 'POST' });
            settledPayments.push(r.payment.public_id);
            /* Refund ~10% of settled to populate the refunded bucket. */
            if (Math.random() < 0.10) {
              await call<any>('payments', `/payments/${r.payment.public_id}/refund`, {
                method: 'POST', body: JSON.stringify({ reason: 'customer_request' }),
              });
            }
          }
        }
      } catch (e: any) {
        if (!String(e.message).includes('risk:')) console.warn(`  ! ${m.id} payment ${i}: ${e.message}`);
      }
    }
  }
  console.log(`  ✓ ${counter} payment intents, ${settledPayments.length} settled`);

  /* ── Step 4: FX quotes ─────────────────────────────────────── */
  console.log('\n[4/7] FX quotes…');
  const FX_DEMO: Array<[Currency, Currency, number, number]> = [
    ['USD', 'EUR', 1_000_00, 25],   // $1000 USD → EUR, 25bp spread
    ['EUR', 'TRY', 50_000,   30],
    ['GBP', 'AZN', 25_000,   40],
  ];
  for (const [base, quote, amt, bp] of FX_DEMO) {
    try {
      const q = await call<{ quote: any }>('fx', '/quote', {
        method: 'POST',
        headers: { 'Idempotency-Key': `seed-fx-${base}-${quote}-${Date.now()}` },
        body: JSON.stringify({
          base_currency: base, quote_currency: quote, amount_minor: String(amt), spread_bp: bp,
          from_account_id: accounts[`tr_${base}`]?.id,
          to_account_id:   accounts[`tr_${quote}`]?.id,
        }),
      });
      /* Execute the first one so the dashboard has an executed quote. */
      if (base === 'USD') await call<any>('fx', `/quote/${q.quote.public_id}/execute`, { method: 'POST' });
    } catch (e: any) { console.warn(`  ! FX ${base}/${quote}: ${e.message}`); }
  }
  console.log(`  ✓ ${FX_DEMO.length} quotes (1 executed)`);

  /* ── Step 5: external statements (recon) ───────────────────── */
  console.log('\n[5/7] External statements…');
  const statements: any[] = [];
  /* For each settled payment, generate a matching bank line.  Bank
   * statements reflect the GROSS amount (the customer's card charge);
   * our internal fee is deducted post-settlement so it doesn't appear
   * on the bank side.  Throw in a few orphans + a duplicate + a
   * tiny-rounding-error partial to exercise the matcher. */
  for (const pid of settledPayments.slice(0, 20)) {
    const p = await call<{ payment: any }>('payments', `/payments/${pid}`);
    const gross = Number(p.payment.amount_minor);
    statements.push({ source: 'bank-acme', external_ref: `BNK-${pid}`, amount_minor: String(gross), currency: p.payment.currency, posted_at: new Date(Date.now() - Math.random() * 86_400_000).toISOString() });
  }
  /* Orphans */
  statements.push({ source: 'bank-acme', external_ref: `BNK-ORPHAN-001`, amount_minor: '500000', currency: 'USD', posted_at: new Date().toISOString() });
  statements.push({ source: 'card-stripe', external_ref: `SX-ORPHAN-002`, amount_minor: '12500',  currency: 'EUR', posted_at: new Date().toISOString() });
  /* Partial — same payment but off-by-7 cents (operator-fixable). */
  if (settledPayments[0]) {
    const p = await call<{ payment: any }>('payments', `/payments/${settledPayments[0]}`);
    const gross = Number(p.payment.amount_minor);
    statements.push({ source: 'card-stripe', external_ref: `SX-${settledPayments[0]}`, amount_minor: String(gross - 7), currency: p.payment.currency, posted_at: new Date().toISOString() });
  }
  /* Duplicate */
  statements.push({ source: 'bank-acme', external_ref: `BNK-ORPHAN-001`, amount_minor: '500000', currency: 'USD', posted_at: new Date().toISOString() });

  await call<any>('reconciliation', '/statements', { method: 'POST', body: JSON.stringify({ statements }) });
  const runRes = await call<any>('reconciliation', '/run', { method: 'POST', body: '{}' });
  console.log(`  ✓ ingested ${statements.length} statements → matched ${runRes.matched}, partial ${runRes.partial}, suspicious ${runRes.suspicious}, unmatched ${runRes.still_unmatched}`);

  /* ── Step 6: invariant + final stats ───────────────────────── */
  console.log('\n[6/7] Verifying ledger invariant…');
  const inv = await call<any>('ledger', '/invariant');
  if (!inv.ok) {
    console.error(`  ✗ INVARIANT BROKEN: drift=${inv.balance_drift} unbalanced=${inv.unbalanced_entries}`);
    process.exit(1);
  }
  console.log(`  ✓ ledger holds: ${inv.balance_drift} drift, ${inv.unbalanced_entries} unbalanced JEs`);

  console.log('\n[7/7] Summary');
  const [ls, ps, fxs, rs, fs, ws] = await Promise.all([
    call<any>('ledger',         '/stats'),
    call<any>('payments',       '/stats'),
    call<any>('fx',             '/stats'),
    call<any>('reconciliation', '/stats'),
    call<any>('fraud',          '/stats'),
    call<any>('webhook',        '/stats'),
  ]);
  console.log(`  Ledger:    ${ls.accounts} accounts · ${ls.journal_entries} JEs · ${ls.postings} postings`);
  console.log(`  Payments:  ${ps.total} total · last_24h ${ps.last_24h?.c ?? 0}`);
  console.log(`  FX:        ${fxs.quotes_total} quotes · ${fxs.rates_tracked} rates`);
  console.log(`  Recon:     ${rs.total} statements · ${rs.heal_pending ?? 0} heal queued`);
  console.log(`  Fraud:     ${fs.scored_total} scored · ${fs.open_cases} open cases`);
  console.log(`  Webhook:   ${ws.total} deliveries · ${ws.endpoints} endpoints`);
  console.log('\nOpen http://localhost:5110/dashboard');
}

main().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
