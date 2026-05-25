/**
 * Smoke test — drives every service end-to-end and asserts on the
 * answers.  Run after `npm run dev` is up.
 *
 *   npm run smoke
 *
 * Exits 0 on success, 1 on failure.  Use as a CI gate.
 */

import { call } from '../lib/http';

let passed = 0;
let failed = 0;

function ok(label: string): void { passed++; console.log(`  ✓ ${label}`); }
function fail(label: string, e?: any): void { failed++; console.log(`  ✗ ${label}${e ? ` — ${e?.message ?? e}` : ''}`); }

async function expect<T>(label: string, fn: () => Promise<T>, predicate?: (v: T) => boolean): Promise<T | null> {
  try {
    const v = await fn();
    if (predicate && !predicate(v)) { fail(label, new Error('predicate returned false')); return null; }
    ok(label); return v;
  } catch (e: any) { fail(label, e); return null; }
}

async function main(): Promise<void> {
  console.log('\nLedger Secure Platform — smoke test');
  console.log('───────────────────────────────────\n');

  console.log('[health]');
  for (const s of ['ledger', 'payments', 'fx', 'reconciliation', 'fraud', 'webhook'] as const) {
    await expect(`${s} responds to /health`, () => call<any>(s, '/health'), (v) => v?.ok === true);
  }

  console.log('\n[ledger]');
  const custR = await expect('create customer account', () => call<any>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ type: 'customer', currency: 'USD', name: 'smoke customer' }) }), (v) => !!v?.account?.id);
  const merR  = await expect('create merchant account', () => call<any>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ merchant_id: 'MERCH-SMOKE', type: 'merchant', currency: 'USD', name: 'smoke merchant' }) }), (v) => !!v?.account?.id);
  const feeR  = await expect('create fee account',      () => call<any>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ type: 'fee', currency: 'USD', name: 'smoke fee' }) }), (v) => !!v?.account?.id);
  if (!custR || !merR || !feeR) { summary(); return; }

  const cust = custR.account.id, mer = merR.account.id, fee = feeR.account.id;

  const jeKey = `smoke-je-${Date.now()}`;
  const je = await expect('post balanced 3-leg JE', () => call<any>('ledger', '/entries', {
    method: 'POST', headers: { 'Idempotency-Key': jeKey },
    body: JSON.stringify({
      description: 'smoke', postings: [
        { account_id: cust, side: 'debit',  amount_minor: '10000' },
        { account_id: mer,  side: 'credit', amount_minor: '9700' },
        { account_id: fee,  side: 'credit', amount_minor: '300' },
      ],
    }),
  }), (v) => !!v?.journal_entry?.id);
  await expect('idempotency replay returns same JE', () => call<any>('ledger', '/entries', {
    method: 'POST', headers: { 'Idempotency-Key': jeKey },
    body: JSON.stringify({
      description: 'smoke', postings: [
        { account_id: cust, side: 'debit',  amount_minor: '10000' },
        { account_id: mer,  side: 'credit', amount_minor: '9700' },
        { account_id: fee,  side: 'credit', amount_minor: '300' },
      ],
    }),
  }), (v) => v?.journal_entry?.id === je?.journal_entry?.id);

  let unbalancedRejected = false;
  try {
    await call<any>('ledger', '/entries', { method: 'POST', headers: { 'Idempotency-Key': `smoke-unb-${Date.now()}` }, body: JSON.stringify({ description: 'bad', postings: [
      { account_id: cust, side: 'debit', amount_minor: '500' }, { account_id: mer, side: 'credit', amount_minor: '400' },
    ] }) });
  } catch (e: any) { unbalancedRejected = String(e.message).toLowerCase().includes('unbalanced'); }
  unbalancedRejected ? ok('unbalanced JE rejected with 422') : fail('unbalanced JE NOT rejected');

  await expect('invariant scan passes', () => call<any>('ledger', '/invariant'), (v) => v?.ok === true);

  console.log('\n[payments]');
  const payR = await expect('create + auto-authorize payment', () => call<any>('payments', '/payments', {
    method: 'POST', headers: { 'Idempotency-Key': `smoke-pay-${Date.now()}` },
    body: JSON.stringify({ merchant_id: 'MERCH-SMOKE', kind: 'pay_in', amount_minor: '25000', currency: 'USD', from_account_id: cust, to_account_id: mer, fee_account_id: fee, fee_amount_minor: '700', description: 'smoke payment' }),
  }), (v) => v?.payment?.status === 'authorized');
  if (!payR) { summary(); return; }
  const pid = payR.payment.public_id;

  await expect('capture moves to pending',  () => call<any>('payments', `/payments/${pid}/capture`, { method: 'POST' }), (v) => v?.payment?.status === 'pending');
  await expect('settle moves to settled',   () => call<any>('payments', `/payments/${pid}/settle`,  { method: 'POST' }), (v) => v?.payment?.status === 'settled');
  await expect('refund moves to refunded',  () => call<any>('payments', `/payments/${pid}/refund`,  { method: 'POST', body: JSON.stringify({ reason: 'smoke' }) }), (v) => v?.payment?.status === 'refunded');
  await expect('ledger invariant still holds after refund', () => call<any>('ledger', '/invariant'), (v) => v?.ok === true);

  console.log('\n[fx]');
  const quote = await expect('FX quote USD→EUR', () => call<any>('fx', '/quote', {
    method: 'POST', headers: { 'Idempotency-Key': `smoke-fx-${Date.now()}` },
    body: JSON.stringify({ base_currency: 'USD', quote_currency: 'EUR', amount_minor: '10000', spread_bp: 25 }),
  }), (v) => v?.quote?.status === 'open');
  if (quote) {
    const usdTr = await call<any>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ type: 'treasury', currency: 'USD', name: 'smoke USD treasury' }) });
    const eurTr = await call<any>('ledger', '/accounts', { method: 'POST', body: JSON.stringify({ type: 'treasury', currency: 'EUR', name: 'smoke EUR treasury' }) });
    await expect('FX execute posts cross-currency JE', () => call<any>('fx', `/quote/${quote.quote.public_id}/execute`, {
      method: 'POST', body: JSON.stringify({ from_account_id: usdTr.account.id, to_account_id: eurTr.account.id }),
    }), (v) => v?.quote?.status === 'executed');
  }

  console.log('\n[fraud]');
  await expect('low-risk score',  () => call<any>('fraud', '/score', { method: 'POST', body: JSON.stringify({ merchant_id: 'MERCH-SMOKE', amount_minor: '1000', currency: 'USD' }) }), (v) => v?.level === 'low');
  await expect('high-risk score', () => call<any>('fraud', '/score', { method: 'POST', body: JSON.stringify({ merchant_id: 'MERCH-SMOKE', amount_minor: '50000000', currency: 'USD', metadata: { suspicious: true } }) }), (v) => v?.level === 'critical' || v?.level === 'high');

  console.log('\n[reconciliation]');
  await expect('ingest 1 matching statement', () => call<any>('reconciliation', '/statements', {
    method: 'POST',
    body: JSON.stringify({ statements: [{ source: 'bank-smoke', external_ref: `BNK-${pid}`, amount_minor: '24300', currency: 'USD', posted_at: new Date().toISOString() }] }),
  }), (v) => v?.inserted === 1);
  await expect('run matcher', () => call<any>('reconciliation', '/run', { method: 'POST', body: '{}' }), (v) => v?.processed >= 1);

  console.log('\n[webhook]');
  await expect('register endpoint', () => call<any>('webhook', '/endpoints', {
    method: 'POST',
    body: JSON.stringify({ merchant_id: 'MERCH-SMOKE', url: 'https://httpbin.org/status/200', description: 'smoke endpoint' }),
  }), (v) => !!v?.endpoint?.id);

  summary();
}

function summary(): void {
  console.log(`\n───────────────────────────────────`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed === 0) {
    console.log('\n\x1b[32m✓ All smoke checks green.\x1b[0m\n');
    process.exit(0);
  } else {
    console.log('\n\x1b[31m✗ Smoke FAILED.\x1b[0m\n');
    process.exit(1);
  }
}

main().catch((e) => { console.error('Smoke crashed:', e); process.exit(1); });
