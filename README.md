# Ledger Secure Platform

Bank-grade double-entry payment infrastructure — the kind that sits behind a Stripe Treasury or Modern Treasury and never loses a cent. Six microservices, an event bus, multi-currency money math, real HMAC-signed webhooks and an operator console that surfaces every invariant the platform enforces.

The goal isn't a sandbox demo. The goal is a system where, at any moment, you can prove `SUM(debits) == SUM(credits)` from first principles and watch the invariant scanner do exactly that.

---

## What lives inside

```
┌─────────────────────────────────────────────────────────────────┐
│                    Operator console (Next.js 15)                │
│         Mission Control · Journal · Payments · FX · Fraud …    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │  /api/<service>/...  (Next gateway)
                              ▼
┌──────────┬──────────┬──────────┬──────────────┬─────────┬──────────┐
│  Ledger  │ Payments │    FX    │ Reconciliation│  Fraud  │ Webhook  │
│   5111   │   5112   │   5113   │     5114      │  5115   │   5116   │
└──────────┴──────────┴──────────┴──────────────┴─────────┴──────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │  Event bus (broker.db)   │   topic-keyed, at-least-once
                │  ledger.posted           │
                │  payment.{created,…}     │
                │  fx.{quoted,executed}    │
                │  fraud.{scored,escalated}│
                │  reconciliation.{matched}│
                │  webhook.{delivered,…}   │
                └──────────────────────────┘
```

Each service owns its own SQLite database; nothing shares a schema. Inter-service traffic goes through HTTP with an `Idempotency-Key` header and through a typed event bus that any of them can subscribe to.

---

## Service map

| Service        | Port | Owns                                                                                  |
|----------------|------|---------------------------------------------------------------------------------------|
| Ledger         | 5111 | Accounts, journal entries, postings, balance computation, invariant scanner, reversals|
| Payments       | 5112 | Payment intents, state machine (initiated→authorized→pending→settled), capture/refund |
| FX             | 5113 | Multi-currency rates, locked quotes, cross-currency execution                         |
| Reconciliation | 5114 | External statement ingest, exact + fuzzy matching, auto-heal queue                    |
| Fraud          | 5115 | Real-time scoring (rules + Welford anomaly baseline), case queue                      |
| Webhook        | 5116 | HMAC-signed delivery, exponential backoff, dead-letter, replay                        |
| Frontend       | 5110 | SSR operator console + `/api/*` gateway                                               |

---

## Quickstart

```bash
# 1. Install
npm install
cp .env.example .env.local
# (rotate the JWT + internal secrets)

# 2. Run all six services + the frontend in one terminal
npm run dev

# 3. (Optional) populate realistic demo data
npm run seed

# 4. (Optional) verify everything end-to-end
npm run smoke

# 5. Open the console
#    http://localhost:5110/dashboard
```

Or run services individually:

```bash
npm run dev:ledger          # 5111
npm run dev:payments        # 5112
npm run dev:fx              # 5113
npm run dev:reconciliation  # 5114
npm run dev:fraud           # 5115
npm run dev:webhook         # 5116
npm run dev:frontend        # 5110
```

---

## Money never lies

Every amount in the platform is a `(BigInt, Currency)` pair stored in the smallest unit the currency natively uses — cents for USD/EUR/GBP/AZN/TRY/AED, yen for JPY. Floating point never touches a balance.

Banker's rounding (round-half-to-even) is the default for FX conversion. Currency-specific decimals come from `lib/money.ts`'s `CURRENCIES` table, derived from ISO 4217.

The ledger invariant is therefore provable end-to-end:

```sql
SELECT journal_entry_id, currency, SUM(CAST(amount_minor AS INTEGER)) AS net
FROM postings
GROUP BY journal_entry_id, currency
HAVING net != 0;
-- expected: 0 rows
```

The Ledger service runs this query (and a per-account cache drift check) every 30 seconds via the invariant scanner. If anything is off, it logs a screaming warning. In production that would page on-call.

---

## API highlights

### Ledger

```
POST   /accounts                            create account
GET    /accounts                            list, filter by merchant/type/currency
GET    /accounts/:id                        balance breakdown (available/pending/reserved)
GET    /accounts/:id/postings               history of postings touching this account
POST   /entries          (Idempotency-Key)  post a balanced multi-leg JE
GET    /entries                             list journal entries
POST   /reversals        (Idempotency-Key)  reverse an existing JE (new JE, mirror signs)
GET    /invariant                           run the cross-check and report drift
GET    /stats                               counts by type, currency, etc.
```

### Payments

```
POST   /payments                  (Idempotency-Key)  create + auto-authorize (calls /fraud/score)
POST   /payments/:id/capture                          authorized → pending (posts capture JE)
POST   /payments/:id/settle                           pending → settled (clears pending bucket)
POST   /payments/:id/refund                           settled → refunded (mirror reversal)
POST   /payments/:id/cancel                           authorized/pending → failed (reverses)
GET    /payments?status=&kind=&currency=&search=     filtered list
GET    /payments/:id                                  full record + lifecycle timeline
GET    /stats                                         by_status, by_currency, by_kind, last_24h
```

### FX

```
POST   /quote     (Idempotency-Key)   lock a rate for ttl_seconds
POST   /quote/:id/execute             post the cross-currency JE at the locked rate
GET    /rates                         current rate book (auto-walks ±25bp every 60s)
POST   /rates                         operator update
GET    /quotes                        list with filters
```

### Reconciliation

```
POST   /statements             ingest a batch from a bank/processor feed
POST   /run                    run the exact + fuzzy matcher across pending statements
GET    /statements?state=…     filtered list
GET    /unmatched              orphans + partials + suspicious — operator queue
POST   /heal/:id               apply a queued auto-heal action (small rounding gap)
GET    /stats                  by_state, by_source, heal_pending
```

### Fraud

```
POST   /score                  rule + Welford-anomaly score for one intent
GET    /cases?status=&level=   case queue (anything ≥ 0.60 lands here automatically)
POST   /cases/:id/resolve      operator decision (approved | rejected | escalated)
GET    /baselines              per-merchant running mean + variance
GET    /stats                  scored_total, open_cases, by_level
```

### Webhook

```
POST   /endpoints                                   register a delivery URL + secret
GET    /endpoints                                   list (filter by merchant_id)
DELETE /endpoints/:id                               deactivate
GET    /deliveries?status=&event_topic=             query the delivery log
POST   /deliveries/:id/replay                       manual retry of any delivery
GET    /stats                                       counts + recent failures
```

---

## Operational guarantees

**Idempotency.** Every state-mutating endpoint accepts an `Idempotency-Key` header. Internally `lib/idempotency.ts` uses a `UNIQUE` constraint to win the race + spin-wait for in-flight collisions. A second call with the same key and same payload returns the cached response; a second call with the same key and a *different* payload returns 409.

**ACID writes.** Each service runs SQLite with `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. The ledger wraps every multi-leg journal entry inside `db.transaction()` so the balance equation holds at commit time or the whole entry rolls back.

**Append-only journal.** SQLite triggers on `journal_entries` and `postings` raise `ABORT` on UPDATE and DELETE. Reversals are new entries that mirror the original with flipped signs and a `reversal_of` link.

**HMAC webhooks.** Every delivery carries `X-Ledger-Signature: t=<unix>,v1=<hex>` where the body signed is `<unix>.<raw json body>`. Receivers verify with `lib/hmac.ts`'s `verifySignature` — `timingSafeEqual` comparison and a ±300s replay window.

**Exponential backoff with full jitter.** Failed deliveries wait `30s · 2^(n-1) ± 50%`, capped at one hour. After `LEDGER_WEBHOOK_MAX_ATTEMPTS` (default 8) they drop into the dead-letter table where an operator can replay them.

**Fraud lives outside the hot path.** The payments service calls `/fraud/score` if it's up and falls through to a built-in local rule layer if it isn't, so a fraud outage never blocks revenue.

**Cross-service coordination via events.** The event bus delivers at-least-once and consumers register with a `consumer_group` — two services in the same group share work (competing consumers); different groups each get a copy.

---

## DR posture

| Concern         | Today's implementation                                                                                  |
|-----------------|---------------------------------------------------------------------------------------------------------|
| Durability      | WAL mode + `fsync` on commit. RPO target < 1 min via WAL backup to remote storage (out of scope here).  |
| Replay          | Webhook deliveries log every attempt; `POST /deliveries/:id/replay` re-queues with attempts=0.          |
| Audit trail     | Append-only journal + immutable `payment_events` + webhook delivery log + broker event log.             |
| Invariant alarm | Background scan every 30s; surfaces drift on Mission Control and logs critical line to stdout.          |
| Cold restart    | Each service rebuilds its schema on boot; broker queue and offsets survive in `data/broker.db`.         |

In a production deployment the WAL/event-bus DBs would be Postgres + Kafka/RabbitMQ; the contracts are designed so swapping the storage layer doesn't touch consumer code.

---

## Project layout

```
ledger-secure-platform/
├── lib/                          # Shared infrastructure
│   ├── money.ts                  #   BigInt minor-unit math + ISO 4217 table
│   ├── types.ts                  #   Project-wide TypeScript vocabulary
│   ├── db.ts                     #   Per-service SQLite factory (WAL + FK)
│   ├── broker.ts                 #   Kafka/RabbitMQ-shape pub/sub on SQLite
│   ├── cache.ts                  #   Redis-shape in-process Map + TTL
│   ├── hmac.ts                   #   HMAC SHA-256 signer + timing-safe verifier
│   ├── idempotency.ts            #   withIdempotency() race-safe wrapper
│   ├── service-base.ts           #   Express bootstrap + logger + error handler
│   └── http.ts                   #   Service-to-service client (with retries)
├── services/
│   ├── ledger/                   # 5111  double-entry engine
│   ├── payments/                 # 5112  state-machine orchestrator
│   ├── fx/                       # 5113  rates + locked quotes
│   ├── reconciliation/           # 5114  matcher + heal queue
│   ├── fraud/                    # 5115  rules + Welford baseline
│   └── webhook/                  # 5116  HMAC delivery + DLQ + replay
├── frontend/                     # Next.js 15 SSR
│   ├── app/                      #   (app) route group = operator console
│   ├── components/               #   ThemeProvider, NotifyProvider, Modal, Sidebar…
│   └── lib/                      #   server/client fetch helpers, formatters
├── scripts/
│   ├── start-all.ts              # spawns all six services + the frontend, colour-tagged
│   ├── seed.ts                   # multi-merchant, multi-currency demo data
│   └── smoke.ts                  # 25-step end-to-end assertion suite
├── data/                         # SQLite databases (git-ignored)
└── .env.example                  # copy → .env.local; rotate secrets first
```

---

## Tech stack

- **Runtime:** Node.js, TypeScript strict
- **Web framework:** Express on the backend, Next.js 15 (App Router) on the frontend, React 19
- **Storage:** SQLite (better-sqlite3) per service — drop-in for Postgres in production
- **Broker:** SQLite-backed event log with `consumer_offsets` table — drop-in for Kafka or RabbitMQ
- **Cache:** Map + TTL in-process — drop-in for Redis
- **Money:** BigInt minor units, banker's rounding, ISO 4217-conformant decimals
- **Crypto:** node:crypto (HMAC SHA-256, `timingSafeEqual`)
- **Theme:** Vault aesthetic — institutional navy + warm cream + copper accent, IBM Plex Serif + IBM Plex Mono, light/dark

---

## What's intentionally not here

- An authentication layer for the operator console (every endpoint is open in dev)
- A real KYC / AML / sanctions screening provider integration
- Card / ACH / SEPA processor adapters — the FX rate market and the recon statement feeds are simulated
- A persistent Postgres + Kafka + Redis topology — the shared library contracts are designed so each can be swapped without touching consumer code

Plenty of room to grow into a real treasury platform; the foundations underneath are honest.

---

Crafted in the Vault aesthetic.
