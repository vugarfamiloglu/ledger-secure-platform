/** Ledger Secure Platform — full TypeScript vocabulary. */

import type { Currency } from './money';
export type { Currency };

export type AccountType =
  | 'merchant'      // operating cash balance for a merchant
  | 'customer'      // end-user wallet
  | 'reserve'       // rolling reserve held back from settlement
  | 'treasury'      // platform's own treasury
  | 'fee'           // platform fee income
  | 'settlement'    // pending payouts in transit
  | 'fx_pool'       // FX liquidity pool (one per currency)
  | 'dispute'       // chargeback / dispute holds
  | 'escrow'        // marketplace escrow
  | 'external';     // counterparty representation (bank, processor)

export type UserRole = 'admin' | 'finance' | 'support' | 'readonly' | 'auditor';

export type PaymentStatus =
  | 'initiated' | 'authorized' | 'pending' | 'processing'
  | 'settled'   | 'failed'     | 'reversed' | 'refunded' | 'expired';

export type PaymentKind = 'pay_in' | 'pay_out' | 'transfer' | 'refund' | 'split' | 'fee';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ReconciliationState = 'matched' | 'partial' | 'unmatched' | 'duplicate' | 'suspicious';

/* ── Entities ─────────────────────────────────────────── */

export interface Account {
  id: string;
  public_id: string;            // ACC-…
  merchant_id: string | null;   // null for platform-owned accounts
  type: AccountType;
  currency: Currency;
  name: string;
  /** Stored as decimal-string minor units. */
  balance_available: string;
  balance_pending: string;
  balance_reserved: string;
  is_active: number;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  public_id: string;            // JE-…
  description: string;
  metadata_json: string;
  posted_at: string;
  reversal_of: string | null;
}

export interface Posting {
  id: string;
  journal_entry_id: string;
  account_id: string;
  amount_minor: string;         // signed: + = debit to account, - = credit
  currency: Currency;
  side: 'debit' | 'credit';
  position: number;             // ordering within the JE
}

export interface Merchant {
  id: string;
  public_id: string;            // MERCH-…
  name: string;
  slug: string;
  default_currency: Currency;
  webhook_secret: string;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: UserRole;
  merchant_id: string | null;
  created_at: string;
}

export interface Payment {
  id: string;
  public_id: string;            // PAY-…
  merchant_id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount_minor: string;
  currency: Currency;
  from_account_id: string | null;
  to_account_id: string | null;
  journal_entry_id: string | null;
  fx_quote_id: string | null;
  risk_score: number | null;
  risk_level: RiskLevel | null;
  description: string;
  metadata_json: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export interface FXQuote {
  id: string;
  public_id: string;            // FXQ-…
  base_currency: Currency;
  quote_currency: Currency;
  /** rate represented as bigint × 10^rate_scale. */
  rate_scaled: string;
  rate_scale: number;
  spread_bp: number;            // basis points (1/100 of a percent)
  amount_minor: string;         // amount being converted (in base)
  amount_quote_minor: string;   // pre-computed amount in quote currency
  status: 'open' | 'locked' | 'executed' | 'expired';
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  journal_entry_id: string | null;
}

export interface RiskCase {
  id: string;
  public_id: string;            // CASE-…
  payment_id: string | null;
  merchant_id: string;
  score: number;
  level: RiskLevel;
  signals_json: string;
  action: 'allow' | 'manual_review' | 'soft_block' | 'hard_freeze';
  status: 'open' | 'resolved' | 'escalated';
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface ExternalStatement {
  id: string;
  source: string;               // bank-acme / card-stripe / ach-sepa …
  external_ref: string;
  amount_minor: string;
  currency: Currency;
  posted_at: string;
  raw_json: string;
  state: ReconciliationState;
  matched_payment_id: string | null;
  matched_score: number | null;
  ingested_at: string;
}

export interface WebhookEndpoint {
  id: string;
  public_id: string;            // WHE-…
  merchant_id: string;
  url: string;
  secret: string;
  description: string;
  is_active: number;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_topic: string;
  payload_json: string;
  status: 'pending' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AuditEntry {
  id: string;
  ts: string;
  actor_kind: 'user' | 'system' | 'webhook';
  actor_id: string | null;
  action: string;
  entity_kind: string;
  entity_id: string | null;
  payload_json: string | null;
  ip: string | null;
}

export interface IdempotencyRecord {
  key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  status: 'in_flight' | 'completed';
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

/* ── Broker envelope ──────────────────────────────────── */

export type EventTopic =
  | 'ledger.posted' | 'ledger.reversed'
  | 'balance.updated'
  | 'payment.created' | 'payment.settled' | 'payment.failed' | 'payment.refunded'
  | 'fx.quoted' | 'fx.executed' | 'fx.expired'
  | 'fraud.scored' | 'fraud.escalated'
  | 'reconciliation.matched' | 'reconciliation.orphan'
  | 'webhook.delivered' | 'webhook.failed';

export interface BrokerEvent<T = any> {
  id: number;
  topic: EventTopic;
  payload: T;
  origin: string;
  ts: string;
}
