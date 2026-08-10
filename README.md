# Retail Intelligence AI

**Smart Accounting. Intelligent Auditing. Better Business Decisions.**

A multi-tenant SaaS that gives small and medium retail businesses a real
double-entry accounting system, GST and tax preparation, business analytics,
forecasting and AI assistance — from a single transaction entry.

The retailer records what happened once. The platform works out the accounting,
the stock movement, the tax treatment, the statements and the analysis behind it.

---

## Status

**Phases 1–8 of 27 complete** — project foundation, database schema, design
system, public website, working authentication, company onboarding, the
application shell, master data, sales invoicing, supplier bills and expenses.
See [Roadmap](#roadmap) for what is built and what is not.

You can register a business, sign in and out, reset a password, confirm an email
address, edit your business and accounting settings, manage branches, invite
team members, switch between businesses, work inside the dashboard shell, and
set up the records everything else is built on — products with HSN codes and GST
rates, customers and suppliers with GSTIN validation, staff, categories and
units of measure.

**You can now trade.** A sale posts its own balanced entry, issues stock at
what it cost and splits the GST by place of supply. A bill brings stock in at
its landed cost, holds recoverable GST as an asset and raises what you owe the
supplier. Buy at two prices and sell, and the cost of sales is the blend — the
margin on the dashboard is real.

**Every cost is now recorded too.** Rent, salaries, electricity and repairs
each post to their own account, so the profit and loss account adds up without
anyone sorting receipts at year end — and something the shop keeps and uses goes
to fixed assets rather than being written off in the month it was bought.

**Money movement is not built yet.** Receipts and payments arrive in Phase 9,
and the reports built on all of it in Phases 10–14. Sales and purchase *returns*
are still to come as well. Every module that is not built says so on its own
page rather than showing an empty screen, and no figure anywhere in the product
is invented to fill a gap.

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
    (app)/app/             The signed-in application, inside the shell
    globals.css            Design tokens (OKLCH, light + dark)
  components/
    ui/                    shadcn/ui primitives
    marketing/             Landing page sections
    auth/                  Auth forms
    shell/                 Sidebar, top bar, search, mobile bar, placeholders
    dashboard/             KPI cards, onboarding checklist
    master-data/           Products, parties, staff, categories and units
    documents/             Line editor, product picker, void — shared by both
    sales/                 Invoice form and list
    purchases/             Bill form and list
    expenses/              Expense form, list and category breakdown
    company/               Settings, team, branches, business switcher
    brand/                 Logo and identity
  lib/
    money.ts               Exact decimal arithmetic — money never touches a float
    tax/gst.ts             GST rules: place of supply, rate splits, round-off
    inventory/valuation.ts FIFO and weighted average, as pure functions
    navigation.ts          One navigation model, gated by permission and plan
    constants/cookies.ts   Cookie names shared across the server/client boundary
    accounting/            Double-entry rules, chart of accounts, system keys
    rbac/                  Permission catalogue and role templates
    billing/               Plan definitions and entitlements
    validation/            Zod schemas shared by client and server
    env.ts                 Validated environment; the app refuses to boot without it
    db.ts                  Prisma singleton
  server/
    accounting/            Journal posting engine
    documents/             Accounts, GST register, reversal — shared by modules
    sales/                 Invoice posting: tax, stock, journal, GST register
    purchases/             Bill posting: landed cost, input credit, payables
    expenses/              Expense posting: categories, capital vs revenue
    inventory/             Stock positions and the movement ledger
    auth/                  Sessions, company context, permission guards
    master-data/           Products, parties, staff; opening-balance posting
    company/               Settings, team, branch and onboarding services
    fiscal/                Financial-year resolution and period listing
    search/                Tenant-scoped global search
    notifications/         Notification feed
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
npm run test          # 478 tests: unit + integration
npm run test:unit     # unit only, no database required
```

Integration tests run against `riai_test` and refuse to start if
`DATABASE_URL` does not name a `_test` database.

Coverage includes the accounting rules, GST arithmetic, permission boundaries
(an auditor cannot write; a cashier cannot void), tenant isolation, document
numbering under rollback, and every database constraint listed above.

---

## Authentication

Sessions are opaque, database-backed and revocable. A JWT would avoid the
lookup, but it cannot be revoked before it expires — and "remove this person's
access now" has to mean now.

| Property           | How                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Token storage**  | Only a SHA-256 digest is stored. A database disclosure yields nothing replayable as a sign-in.                                                               |
| **Cookie**         | `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` prefixed over HTTPS. Unreadable from JavaScript.                                                          |
| **Revocation**     | Per-session, or all at once via a `sessionEpoch` bump. Suspending a user ends their access on the next request.                                              |
| **No enumeration** | Sign-in returns one message for a wrong password and an unknown address, and burns comparable time on both. Password reset always reports success.           |
| **Rate limiting**  | Two axes on every credential endpoint — per IP _and_ per account. Either alone is trivially evaded.                                                          |
| **Lockout**        | Progressive, from 1 minute at five failures up to an hour.                                                                                                   |
| **CSRF**           | Origin is compared against the host the request arrived on, so a proxy or preview URL does not break actions while an attacker's origin still never matches. |
| **Open redirect**  | `?next=` accepts only same-site paths; `//evil.example` and friends are rejected.                                                                            |
| **Audit**          | Sign-in, failure, lockout, sign-out, registration, verification and reset all land in the append-only log with IP and user agent.                            |

Registration creates the user, the company, the chart of accounts, the fiscal
calendar, the roles and the opening journal entry **in one transaction**. A
half-created tenant is worse than none.

Email verification is a prompt, not a wall: a retailer locked out of their own
books until an email arrives simply leaves. It gates the operations where an
unconfirmed address is actually dangerous — inviting team members and billing.

Authorization lives in `src/server/auth/context.ts`. `companyId` always comes
from the session, never from a URL or form field, and code asks
`requirePermission("sales.void")` rather than checking a role name.

---

## Team and permissions

Roles are bundles of permissions, seeded per company and editable. The guards
that matter are the ones that prevent a business locking itself out or a
member quietly escalating:

| Guard                                                      | Why                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **The last Owner cannot be removed, suspended or demoted** | A company with no Owner has nobody who can manage it or restore access.                                  |
| **Nobody can change their own role**                       | Otherwise "grant myself Owner" is one request away for anyone holding `users.manage`.                    |
| **Only a confirmed email may invite**                      | An unverified inviter could hand out access to books they have not proven they control.                  |
| **Removing or suspending ends sessions immediately**       | Revoking access has to mean now, not at session expiry.                                                  |
| **Changing a role ends sessions too**                      | So the new permissions apply on the next request rather than whenever a cached context happens to lapse. |
| **A role is fixed at invitation time**                     | The invitee accepts a role someone chose for them; they cannot pick their own.                           |
| **Re-inviting supersedes the old link**                    | A forwarded earlier email cannot be used to join with a stale role.                                      |

Accepting an invitation marks the address verified — following the link proves
control of the mailbox, which is exactly what a verification email establishes.
An existing account keeps its password; the one typed at acceptance is ignored
rather than silently overwriting a credential they already rely on.

## Settings that lock

Some accounting settings stop being editable once they have shaped recorded
data. Changing the fiscal year would leave posted entries outside any period;
changing the currency would relabel amounts rather than convert them; changing
the stock valuation method would make historical cost of goods sold
irreproducible.

Rather than silently ignoring such an edit — or applying it — the settings page
disables the field **and states the reason**, and the server reports which
fields it kept unchanged. A disabled control with no explanation is just a
support ticket in waiting.

---

## What a sale does

A retailer enters an invoice. Four things follow from it, inside one database
transaction — all of them or none:

```
   Marie Biscuits × 10 @ ₹25, 18% GST, paid in cash
                          │
   ┌──────────────┬───────┴────────┬──────────────────┐
   ▼              ▼                ▼                  ▼
 Invoice     Stock ledger     Journal entry      GST register
 INV-0001    −10 PKT          Dr Cash    295     outward supply
             @ ₹18 cost       Cr Sales   250     HSN 1905, 18%
                              Cr CGST     22.50  taxable 250
                              Cr SGST     22.50  tax 45
                              Dr COGS    180
                              Cr Stock   180
```

The entry totals ₹475, not ₹295, because the cost of the goods rides in the same
entry as the revenue that earned it. Keeping them together is what makes the
margin on a sale visible in one place, and it keeps invoice and entry one-to-one.

**Nothing the browser sends decides what a sale was worth.** The form posts
products, quantities, rates and discounts; taxable value, CGST/SGST/IGST,
round-off and total are computed on the server by the same pure tax engine the
form previews with. An altered request can change what is claimed to have been
sold — it cannot change what the books say it earned.

**GST splits by place of supply.** Same state as the seller, the tax is CGST +
SGST; another state, it is a single IGST charge. The customer pays the same
either way, but the two are reported in different tables of the return. An
unregistered seller and a composition dealer charge no GST at all, and the
invoice says why rather than leaving a retailer to wonder where the tax went.

**Stock cannot go negative.** Selling what the business does not have would post
a fabricated cost of goods sold and leave a negative asset on the balance sheet.
The form warns while you type, naming the product and the shortfall, and the
server refuses regardless.

**A void reverses; it never erases.** The invoice, its entry and its stock
movements all stay exactly as they were. A reversing entry, a matching inward
stock movement and a negative register row are added beside them, with a stated
reason. The invoice number stays in the series — a number that simply vanished
is the gap a tax officer asks about.

---

## What a bill does

The mirror of a sale, with two differences that are not cosmetic.

**The supplier is the seller.** Whether the bill carries GST depends on *their*
registration, and whether it is CGST + SGST or IGST depends on their state
against yours. A supplier with no GSTIN charges nothing, and the form says so
rather than leaving a blank where the tax should be.

**Recoverable tax is not a cost.** A business registered under the regular
scheme sets input tax against the tax it collects, so GST on a bill is an asset:

```
   100 packets at ₹20, 18% GST, on credit
                       │
   ┌───────────────────┼──────────────────────┐
   ▼                   ▼                      ▼
 Stock ledger     Journal entry          GST register
 +100 PKT         Dr Inventory 2,000     inward supply
 @ ₹20 cost       Dr GST Input   360     claimable
                  Cr Payables  2,360
```

A composition dealer or an unregistered business cannot claim it, so the tax is
landed onto the stock — ₹2,360 into inventory at ₹23.60 a packet, and nothing in
the input accounts. Holding a credit that can never be claimed would overstate
assets and understate cost of sales for as long as the business exists, so the
request is overruled rather than honoured, whatever the form asks for.

**The same bill cannot be recorded twice.** A supplier's own reference is checked
against their earlier bills, because paying one twice is easy to do and hard to
notice afterwards. Voiding a bill frees the reference again.

**Voiding is refused once the stock has been sold.** Taking it back out would
drive the position negative and fabricate a cost, so the refusal names the
figures and points at a purchase return, which is what actually happened.

---

## What an expense does

One amount, one category — and two judgements that decide whether a profit
figure means anything.

**Capital or revenue.** A fridge bought for the shop is not a cost of this
month; it is an asset that wears out over years. Recording it as an expense
understates profit now and overstates it every month afterwards, and no report
built on those figures can be right. Capital items post to fixed assets and join
the asset register under `FA-<voucher>`, ready to be depreciated — and voiding
one withdraws it from the register, because depreciating something the books say
was never bought carries the mistake forward for years.

**Claimable or not.** ₹11,800 of rent at 18% is ₹10,000 of cost and ₹1,800 of
recoverable tax — for a business registered under the regular scheme. For anyone
else the whole ₹11,800 is the cost, exactly as on a purchase bill. The form
shows which figure will reach the profit and loss account before it is saved,
because that figure is not always the one on the receipt.

The category decides which expense account it posts to, so rent lands in Rent
and salary in Salary without anyone sorting receipts at year end. An expense
carrying no GST writes nothing to the tax register at all — a row of zeroes is
noise in a return.

---

## Opening balances

A business migrating onto this platform arrives owing money, being owed it, and
with stock on the shelves. Those positions enter the ledger as **balanced
journal entries**, not as numbers stored next to the master record — otherwise
the trial balance is wrong from day one and every statement built on it inherits
the error.

| Position                     | Entry                                    |
| ---------------------------- | ---------------------------------------- |
| Customer owes ₹50,000        | Dr Receivables · Cr Owner's capital      |
| Supplier owed ₹30,000        | Dr Owner's capital · Cr Payables         |
| 40 bags of rice at ₹1,450    | Dr Inventory ₹58,000 · Cr Owner's capital |

The counter-side is owner's capital because on migration that is exactly what
capital means: what the business owns minus what it owes. A suspense account
would be the textbook alternative, and it would leave every retailer with a
balance nobody ever clears.

Internally every position is expressed as a **signed debit to its control
account**, so one posting routine handles receivables, payables and stock —
including a customer in credit and a supplier paid in advance.

Editing an opening balance never rewrites the original entry. The change posts
its own entry for the difference, measured against the ledger rather than
against the master row, so a correction made by any route is accounted for.
Product opening stock is fixed at creation: it is a quantity in the stock ledger
*and* a value in the journal, and correcting it properly is a stock adjustment
with its own date and reason.

Party records are archived, never deleted. One that carried an opening balance
is named in a posted entry, and an entry that cannot say who it was with is not
an audit trail.

---

## The shell

Navigation is one declarative model in `src/lib/navigation.ts`, filtered through
three independent gates before anything renders:

| Gate           | Effect                                                             |
| -------------- | ------------------------------------------------------------------ |
| **Permission** | The item is not rendered at all. A door you cannot open is noise.  |
| **Plan**       | The item stays visible and marked, so the upgrade is discoverable. |
| **Build**      | The item is marked `Soon` with the phase it arrives in.            |

Hiding is a presentation decision, never a security one — every page behind
those links calls `requirePermission()` on the server regardless of what the
navigation chose to show.

The dashboard reads real balances from posted journal lines. A figure it cannot
compute yet — sales this month, gross profit — is shown as **pending, with the
module it waits on named**. It is never shown as `₹0.00`, because zero is a
factual claim about a business's trading, and an empty ledger is not the same
statement as no sales.

The financial year lives in a cookie so it survives navigation, and the server
re-validates it against the company's own years on every request: a cookie is
client data, and a year id from one tenant must never resolve inside another.
Global search runs entirely server-side under the session's `companyId`, so the
query text is the only thing the browser controls.

---

## Roadmap

| Phase | Scope                                                         | Status   |
| ----- | ------------------------------------------------------------- | -------- |
| 1     | Foundation, schema, design system, public site, auth UI       | **Done** |
| 2     | Authentication — sessions, verification, rate limiting, audit | **Done** |
| 3     | Company onboarding — settings, branches, team, invitations    | **Done** |
| 4     | Application shell — navigation, search, dashboard             | **Done** |
| 5     | Master data — products, parties, staff, opening balances      | **Done** |
| 6     | Sales — invoicing, GST split, stock issue, void               | **Done** |
| 7     | Purchases — bills, input tax credit, landed cost, void        | **Done** |
| 8     | Expenses — categories, GST, capital vs revenue, void          | **Done** |
| 9     | Receipts & payments                                           | Next     |
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
