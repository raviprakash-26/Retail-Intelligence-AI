# Retail Intelligence AI

**Smart Accounting. Intelligent Auditing. Better Business Decisions.**

A multi-tenant SaaS that gives small and medium retail businesses a real
double-entry accounting system, GST and tax preparation, business analytics,
forecasting and AI assistance — from a single transaction entry.

The retailer records what happened once. The platform works out the accounting,
the stock movement, the tax treatment, the statements and the analysis behind it.

---

## Status

**Phase 1 of 27 complete** — project foundation, database schema, design system,
public website and authentication UI. See [Roadmap](#roadmap) for what is built
and what is not.

> Authentication forms validate but do not yet submit; sessions land in Phase 2.
> The forms say so on screen rather than pretending to succeed.

---

## The core idea

```
                       RETAILER
                          │
                          ▼
                  Enter transaction once
                          │
                          ▼
              ACCOUNTING RULES ENGINE
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
     Journal entry    Inventory      Tax register
          │               │               │
          └───────────────┼───────────────┘
                          ▼
                  Ledger → Trial balance
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
      Statements      Analytics       AI layer
```

Business documents are _source records_. Financial truth lives in
`journal_entries` / `journal_lines` and nowhere else. Every report — ledger,
trial balance, trading account, P&L, balance sheet — is derived from those
lines, never assembled by adding sales and subtracting expenses.

---

## Design principles

These are constraints on the build, not marketing copy.

| Principle                                | How it is enforced                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Double entry is not optional**         | `CHECK` constraints reject a two-sided or negative line. A deferred constraint trigger verifies every posted entry balances _and_ agrees with its control totals before the transaction commits. |
| **Money is exact**                       | Every amount is `DECIMAL(18,4)` in the database and a `Decimal` in code. Floating-point arithmetic is not used for money anywhere.                                                               |
| **Posted history is immutable**          | Triggers reject updates and deletes on posted entries. Corrections are reversing entries or voids with a stated reason. The audit log is append-only.                                            |
| **Tenants are isolated server-side**     | Every tenant row carries `companyId`; every unique constraint is composite with it. Isolation lives in the data-access layer, never in UI filtering.                                             |
| **AI never produces a financial figure** | Profit, GST, balances, statements and ratios are computed by application code. The AI explains those results and flags anomalies.                                                                |
| **No overclaiming**                      | GST and tax outputs are marked "prepared for review". The product does not file returns and does not present its output as professional advice.                                                  |

---

## Stack

| Layer      | Choice                                                |
| ---------- | ----------------------------------------------------- |
| Framework  | Next.js 16 (App Router, Turbopack), React 19          |
| Language   | TypeScript 5.9, `strict` + `noUncheckedIndexedAccess` |
| Styling    | Tailwind CSS v4, OKLCH design tokens, light/dark      |
| Components | shadcn/ui (new-york) on Radix primitives              |
| Database   | PostgreSQL 16                                         |
| ORM        | Prisma 6                                              |
| Validation | Zod 4, shared between client and server               |
| Forms      | React Hook Form                                       |
| Charts     | Recharts                                              |
| Testing    | Vitest (unit + integration against a real database)   |

---

## Getting started

### Prerequisites

- Node.js 20.11+
- PostgreSQL 16+

### Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    Generate a real secret:
#    openssl rand -base64 48   →  AUTH_SECRET

# 3. Create the databases
createdb riai_dev
createdb riai_test

# 4. Apply migrations and generate the client
npm run db:migrate

# 5. Seed platform data and the demo tenant
npm run db:seed

# 6. Run
npm run dev
```

Open <http://localhost:3000>.

### Demo tenant

`npm run db:seed` creates **Ravi Retail Mart**, a Bengaluru kirana store with a
full chart of accounts, seven products, customers, suppliers, employees, opening
stock and a balanced opening journal entry.

| Role       | Email                            | Password          |
| ---------- | -------------------------------- | ----------------- |
| Owner      | `owner@raviretailmart.demo`      | `DemoRetail@2026` |
| Accountant | `accountant@raviretailmart.demo` | `DemoRetail@2026` |
| Cashier    | `cashier@raviretailmart.demo`    | `DemoRetail@2026` |

The tenant is flagged `isDemo` and is skipped entirely when `NODE_ENV=production`.
Set `SEED_DEMO_DATA=false` to skip it in development too.

---

## Commands

| Command                 | Does                                               |
| ----------------------- | -------------------------------------------------- |
| `npm run dev`           | Development server                                 |
| `npm run build`         | Production build (runs `prisma generate` first)    |
| `npm run verify`        | Typecheck → lint → tests. Run before every commit. |
| `npm run typecheck`     | `tsc --noEmit`                                     |
| `npm run lint`          | ESLint                                             |
| `npm run test`          | Migrate the test database, then run the full suite |
| `npm run test:unit`     | Unit tests only (no database needed)               |
| `npm run test:coverage` | Coverage report                                    |
| `npm run db:migrate`    | Create and apply a migration                       |
| `npm run db:seed`       | Seed platform data and the demo tenant             |
| `npm run db:studio`     | Prisma Studio                                      |
| `npm run db:reset`      | Drop, re-migrate and re-seed                       |

---

## Project layout

```
prisma/
  schema.prisma            Data model (45+ models)
  migrations/              Including hand-written integrity constraints
  seed.ts                  Platform data + demo tenant
  seed/                    Seed modules

src/
  app/
    (marketing)/           Public website
    (auth)/                Sign in, register, password reset
    globals.css            Design tokens (OKLCH, light + dark)
  components/
    ui/                    shadcn/ui primitives
    marketing/             Landing page sections
    auth/                  Auth forms
    brand/                 Logo and identity
  lib/
    money.ts               Exact decimal arithmetic — money never touches a float
    accounting/            Double-entry rules, chart of accounts, system keys
    rbac/                  Permission catalogue and role templates
    billing/               Plan definitions and entitlements
    validation/            Zod schemas shared by client and server
    env.ts                 Validated environment; the app refuses to boot without it
    db.ts                  Prisma singleton
  server/
    accounting/            Journal posting engine
    provisioning/          Tenant provisioning and purge
    sequences/             Gap-free document numbering

tests/
  unit/                    Pure logic
  integration/             Against a real PostgreSQL instance
```

---

## What the database enforces

The application validates before it writes. These constraints are the second
layer, so a bug in a service — or a manual `psql` session — still cannot produce
an unbalanced ledger.

- `journal_lines_single_sided` — exactly one of debit/credit is non-zero
- `journal_lines_amounts_non_negative` — no negative amounts
- `journal_entries_balanced_when_posted` — control totals must match
- `journal_entries_balance_check` — deferred trigger: lines must sum to the
  control totals, and there must be at least two of them
- `journal_entries_immutability` — posted entries reject updates and deletes;
  only `POSTED → VOIDED/REVERSED` is permitted, and a void requires a reason
- `journal_lines_immutability` — lines of a posted entry cannot change
- `audit_logs_no_update` / `audit_logs_no_delete` — append-only
- `tax_rates_components_reconcile` — CGST + SGST, or IGST, must equal the rate
- Partial unique indexes — one current fiscal year and one primary branch per
  company

Erasing a tenant (a deletion request, or resetting the demo) is possible only
through `purgeCompany()`, which sets a transaction-local flag the triggers check.
`SET LOCAL` means the permission dies with the transaction.

---

## Testing

```bash
npm run test          # 172 tests: unit + integration
npm run test:unit     # unit only, no database required
```

Integration tests run against `riai_test` and refuse to start if
`DATABASE_URL` does not name a `_test` database.

Coverage includes the accounting rules, GST arithmetic, permission boundaries
(an auditor cannot write; a cashier cannot void), tenant isolation, document
numbering under rollback, and every database constraint listed above.

---

## Roadmap

| Phase | Scope                                                         | Status   |
| ----- | ------------------------------------------------------------- | -------- |
| 1     | Foundation, schema, design system, public site, auth UI       | **Done** |
| 2     | Authentication — sessions, verification, rate limiting        | Next     |
| 3     | Company onboarding                                            |          |
| 4     | Dashboard shell                                               |          |
| 5     | Master data                                                   |          |
| 6–9   | Sales, purchases, expenses, receipts & payments               |          |
| 10–14 | Accounting engine, journal, ledger, trial balance, statements |          |
| 15    | Inventory                                                     |          |
| 16–17 | GST and tax preparation                                       |          |
| 18–19 | Analytics and forecasting                                     |          |
| 20–22 | AI Accountant, Auditor, Advisor                               |          |
| 23–24 | Subscriptions and admin panel                                 |          |
| 25–27 | Security hardening, testing, deployment                       |          |

---

## Licence

Proprietary. All rights reserved.
