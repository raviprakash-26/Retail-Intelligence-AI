# Retail Intelligence AI

**Smart Accounting. Intelligent Auditing. Better Business Decisions.**

A multi-tenant SaaS that gives small and medium retail businesses a real
double-entry accounting system, GST and tax preparation, business analytics,
forecasting and AI assistance — from a single transaction entry.

The retailer records what happened once. The platform works out the accounting,
the stock movement, the tax treatment, the statements and the analysis behind it.

---

## Status

**All 27 phases complete** — project foundation, database schema, design
system, public website, authentication, company onboarding, the application
shell, master data, the full transaction set, the accounting engine and its
reports, inventory, GST and income tax preparation, analytics, forecasting, the
AI accountant, the AI auditor, the AI advisor, subscriptions, platform
administration, security hardening, the testing pass and deployment. See
[Roadmap](#roadmap) for what is built, and
[what this is not ready for](#what-this-is-not-ready-for) for what is not.

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

**Staff can be paid.** A monthly run reads the salaries on the employee
records, works out provident fund, insurance and professional tax, and posts one
entry that owes each authority separately. It does not compute TDS, and says so
where somebody would otherwise assume it had.

**And every figure can be taken away.** Fourteen reports — including a ledger for
any account and a statement for any customer or supplier — each running the
service that owns its numbers rather than recomputing them, exportable as a CSV
that carries the same figures and the same caveats, and laid out to print.

**And goods can come back.** A credit note against an invoice puts the stock
back at what the sale issued it for, debits a contra-revenue account rather than
shrinking Sales, and appends negative rows to the GST register. A debit note
against a bill takes the stock off the shelf, gives up the input credit claimed
on it, and names the gap between what the supplier refunds and what the books
carried. Neither edits the document it reverses.

**Every cost is now recorded too.** Rent, salaries, electricity and repairs
each post to their own account, so the profit and loss account adds up without
anyone sorting receipts at year end — and something the shop keeps and uses goes
to fixed assets rather than being written off in the month it was bought.

**Money movement is recorded too.** A receipt matched to the invoices it
settles keeps "who owes me what, and for how long" answerable without anyone
reconciling by hand; money received against nothing in particular still moves
the ledger in full and is shown sitting on account until somebody attributes it.
Capital the owner puts in is equity, a loan is a liability, and money the owner
takes out reduces capital — none of them touch the profit and loss account.
Receivables and payables are aged from each document's _due_ date, so nobody is
chased for an invoice that is not yet payable.

**The chart of accounts is yours to shape.** Every account the books can post
to is visible with what it currently holds, and the accounting equation is shown
at the top rather than assumed — a retailer who can see their own books balance
has a reason to trust the figures on every other page. Add a line for a cost the
standard chart does not name, rename any account including the ones the system
posts to, and retire the ones you do not use.

**Every entry the books contain is readable in one place.** The journal lists
them all, says which document produced each one, and links back to it. Seeing
that a shop's accounting is the direct consequence of the sales and bills
already recorded is the whole argument for entering a transaction once. The few
things that are genuinely only accounting — depreciation, an accrual, a bad debt
written off — can be posted by hand, through the same engine and the same
balance check as everything else.

**Each account has a ledger.** Laid out the way a bahi khata is — what was
carried in at the top, every movement in date order, the balance running down
the right, what is carried out at the bottom. Narrow a customer or supplier
account to one name and it becomes the statement you would send them, which
reconciles with the ageing report exactly because both read the same posted
lines.

**The trial balance is the checkpoint.** Every account with a balance, in two
columns, totalled — and honest about what that proves: the arithmetic holds, not
that the books are right. A purchase recorded against Rent balances perfectly
and is still wrong.

**The statements build themselves.** A trading account, a profit and loss
account and a balance sheet, all from the same entries — with a plain-language
reading above them that says what the margin actually means, and a note under
each that says what it deliberately leaves out.

**Stock reconciles with the books.** What is on the shelves is compared with
the Inventory account in the ledger and the answer is shown rather than assumed
— and a physical count that differs can be corrected honestly, as a transaction
that posts real accounting rather than an edit to a number.

**GST returns are prepared, never filed.** A working paper built from the tax
already on your documents, with the set-off applied in the order the law
prescribes and the tax register reconciled against the ledger. Nothing on the
page can submit it, and it says so.

**Income tax is estimated, never advised.** The computation starts from the
profit the statements already show, adds the book depreciation back and takes
the Act's own figure instead, and stops where judgement begins — cash paid over
the section 40A(3) limit and bills left unpaid past the micro-enterprise time
limit are listed with the vouchers behind them rather than being silently
applied, so the answer reads as the range it actually is. Section 44AD sits
beside it for comparison. Nothing on the page files anything, and it says so.

**The books can now be read as a business.** Revenue and gross profit over
time, which products earn rather than merely sell, who buys, which days carry
the week, and eleven ratios with a single indicator summarising them. Every
figure is arithmetic on posted entries — the trend buckets add up to the revenue
on the statements because both read the same lines — and a ratio that cannot be
worked out honestly gives its reason rather than a zero.

**The next few weeks come as ranges.** Revenue is a line fitted through the
weeks already recorded with a band drawn from how far those weeks fell from it,
and cash is a roll-forward of invoices raised, bills received and what the shop
actually spends to keep running. Where the history is too short or too uneven to
narrow down, the page says so instead of putting a confident figure in the
middle of a useless range.

**The assistant answers from the books, and computes nothing.** It reads
through a fixed set of read-only queries bound to one tenant, quotes only what
those queries returned, and shows them behind every answer. Where no provider is
configured it says so and answers nothing, rather than substituting something
plausible.

**The auditor observes, and accuses nobody.** Nine checks run as queries over
the books — a ledger that does not balance, cash that goes below zero, a
duplicate invoice number, a sale below cost — and each finding carries the
evidence that made it fire alongside the ordinary reasons it usually happens.
The score is arithmetic on the severities, re-derivable by hand, and says on the
page that it is not a measure of honesty.

**The advisor suggests, and promises nothing.** Ten detectors over figures the
platform has already computed — cash sitting with customers, stock sitting still,
margin slipping, costs outrunning sales — each saying what the books show, what it
is worth, and the reasons a shopkeeper who knows their trade would be right to
ignore it. What a suggestion is worth is either an amount already in the books, a
band with its assumption printed beside it, or an admission that there is no
honest figure.

**A plan decides what is available, and the server decides that.** Every
feature-gated page and every action that adds to the books checks the
subscription rather than trusting the sidebar. What a lapsed subscription stops
is new entries and nothing else: the books already recorded stay readable,
printable and exportable, and the refusal says so in the same breath.

**The platform can be run without reading anybody's books.** Administration
shows how each business uses the service — plan, allowances, counts, status —
and not one figure from its ledger. There is no way to sign in as a customer,
and every administrative change is written to the same append-only log the
tenants' own actions go to.

**It builds into a container and knows when it is unwell.** A multi-stage
image, a compose file for a single machine, separate liveness and readiness
probes, and a pipeline that runs the same three gates a developer runs. What it
is _not_ ready for is written down as plainly as what it does — payments,
filing, backups and scale are all named.

**Goods that come back are recorded as returns, not as edits.** A credit note
against an invoice and a debit note against a bill each post their own balanced
entry, move the stock the other way and append negative rows to the GST
register. Neither touches the document it reverses. Every module that is not
built says so on its own page rather than showing an empty screen, and no figure
anywhere in the product is invented to fill a gap.

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

### Platform administrator

The seed also creates one administrator, so the admin panel at `/admin` is
reachable on a fresh checkout without a SQL statement. It holds no membership of
any business, and cannot read one's books from there.

| Email                            | Password           |
| -------------------------------- | ------------------ |
| `admin@retailintelligence.local` | `AdminRetail@2026` |

Development only, and refused outside it for the same reason as the demo tenant:
an account with a published password and platform-wide reach is a security
incident on a live system, not a convenience.

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
| `npm run test:e2e`      | Browser suite against a production build           |
| `npm run test:coverage` | Coverage report                                    |
| `npm run db:migrate`    | Create and apply a migration                       |
| `npm run db:seed`       | Seed platform data and the demo tenant             |
| `docker compose up -d`  | Run the application and a database on one machine  |
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
    (admin)/admin/         Platform administration, outside the tenant shell
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
    returns/               Return dialog, note lists, notes against a document
    expenses/              Expense form, list and category breakdown
    settlements/           Receipt/payment form, allocation table, ageing panel
    inventory/             Stock list, stock card, count correction
    gst/                   GST working paper: GSTR-1 tables, set-off, reconciliation
    tax/                   Income tax working paper: computation, blocks, 44AD
    analytics/             Trend chart, product and customer breakdowns, ratios
    forecast/              The projected band, cash weeks, and what is not known
    ai/                    The assistant, with the queries behind each answer
    auditor/               Findings with their evidence and ordinary explanations
    advisor/               Suggestions with what they are worth and when to ignore them
    billing/               The plan, what it includes, and what has been used
    admin/                 Tenant list, one tenant, plan editor, activity
    accounting/            Chart, journal, ledger, trial balance, statements
    company/               Settings, team, branches, business switcher
    brand/                 Logo and identity
  lib/
    money.ts               Exact decimal arithmetic — money never touches a float
    tax/gst.ts             GST rules: place of supply, rate splits, round-off
    tax/set-off.ts         Input-credit set-off, in the order the law prescribes
    tax/income-tax.ts      Slabs, rebate, surcharge, cess — one table per year
    tax/depreciation.ts    Block-of-assets depreciation under the Act, pure
    tax/presumptive.ts     Section 44AD and the section 44AB audit threshold
    analytics/ratios.ts    Eleven ratios, null with a reason where honest
    analytics/health.ts    A composite indicator that is not a credit score
    analytics/range.ts     Reporting periods, shared across the client boundary
    forecast/series.ts     Least-squares fit, prediction band, and three refusals
    ai/tools.ts            Nine read-only queries, none of which takes a company
    ai/prompt.ts           The rules, and the unverified-figure check
    auditor/rules.ts       The rule catalogue, the score, and the words it may not use
    advisor/catalogue.ts   What may be suggested, and the words it may not promise
    advisor/impact.ts      Recorded, estimated or unquantified — and the ordering
    billing/entitlements.ts Features, allowances, and what lapsing may not do
    admin/scope.ts         What administration may look at, and what it may not
    inventory/valuation.ts FIFO and weighted average, as pure functions
    settlements/ageing.ts  Ageing buckets and oldest-first allocation, pure
    navigation.ts          One navigation model, gated by permission and plan
    constants/cookies.ts   Cookie names shared across the server/client boundary
    accounting/            Double-entry rules, chart of accounts, account tree
    rbac/                  Permission catalogue and role templates
    billing/               Plan definitions and entitlements
    validation/            Zod schemas shared by client and server, and one date
    env.ts                 Validated environment; the app refuses to boot without it
    db.ts                  Prisma singleton
  server/
    accounting/            Posting, balances, ledger, trial balance, statements
    documents/             Accounts, GST register, reversal — shared by modules
    sales/                 Invoice posting: tax, stock, journal, GST register
    purchases/             Bill posting: landed cost, input credit, payables
    returns/               Credit and debit notes, read from the original document
    expenses/              Expense posting: categories, capital vs revenue
    settlements/           Receipts and payments: allocation, ageing, void
    inventory/             Positions, movements, reconciliation, adjustments
    gst/                   GST working paper, periods, register reconciliation
    tax/                   Income tax computation, disallowances found in records
    analytics/             Trend from the ledger, breakdowns from the invoice lines
    forecast/              Revenue projection and the cash commitment roll-forward
    ai/                    Tool runner bound to one tenant, provider, transcript
    auditor/               Nine checks as queries, the run, and settled findings
    advisor/               Ten detectors over figures the platform already computes
    billing/               Entitlement resolution, usage counts, plan changes
    admin/                 Platform metrics, tenant metadata, plan and status changes
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
npm run test          # 1296 tests: unit + integration
npm run test:unit     # unit only, no database required
npm run test:e2e      # 49 checks in a browser, against a production build
npm run test:coverage # line and branch coverage
```

Three layers, each answering a question the others cannot.

**Unit tests** cover the arithmetic and the vocabulary: accounting rules, GST,
inventory valuation, income tax slabs and reliefs, depreciation blocks, the
ratio engine and its refusals, the forecasting band and when it declines to draw
one, the words the auditor may not use and the outcomes the advisor may not
promise, how money is written on a page down to the lakh grouping, and what
configuration the application refuses to boot on.

**Integration tests** run against a real PostgreSQL instance — `riai_test`,
and they refuse to start if `DATABASE_URL` does not name a `_test` database.
They cover the things only a database can answer: that every posting balances,
that a report reconciles with the ledger it reads, that entitlements resolve and
a lapsed subscription still cannot touch a record, that platform administration
never returns a figure from a tenant's books, that document numbering survives a
rollback, and that one company cannot see another's anything.

**End-to-end tests** run in a browser against the standalone server — the exact
artefact the container runs — rather than the dev server or even `next start`:
the content security policy, static versus dynamic rendering and the contents of
the client bundle all behave differently under `next dev`, and a suite that
passes only there is checking a build nobody ships. They cover the
layer the other two cannot reach — server actions need a request context, so
they sit at zero percent in the unit and integration suites — and they check
what a person actually sees: that a sale entered through the form posts its own
accounting, that a cashier asking for the trial balance directly gets the
refusal and none of the figures, that no page promises or accuses anything, and
that nothing scrolls sideways on a phone.

Three things worth knowing about how they are written.

They sign in **once per role** and share the session. Signing in per test trips
the per-account rate limit eight sign-ins in and then fails whichever test
crossed it — failures that move between runs and read like flakiness while being
the product working as designed.

The horizontal-overflow check asks the page to scroll and asserts it does not
move, rather than comparing widths. Chrome inflates
`documentElement.scrollWidth` with the content of descendant scrollers, so the
comparison reports overflow for a wide table that is correctly scrolling inside
its own container — the arrangement the rule exists to encourage.

A cashier asking for a page their role forbids gets HTTP **200**, not 403. The
guard is doing its job — the page renders the refusal and none of the report —
but the shell has already streamed by the time a nested page calls
`forbidden()`, so the status is committed. The tests assert the figures are
absent, which is what actually matters.

Line coverage sits around 69%. The untested remainder is mostly React
components and the thin action wrappers the browser suite drives.

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

**The supplier is the seller.** Whether the bill carries GST depends on _their_
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

## What a return does

A return is not a void, and it is not an edit. Voiding says the document should
never have existed; a return says the trade happened and some of it came back.
Both leave the original where it is, because a ledger that can be edited is not
a ledger.

**Everything is read from the document being reversed.** The form sends a
document id, a date and a quantity per line. It does not send a price, a tax
rate or a total — those come from the invoice or bill line being returned
against. That is a trust boundary, and it is also the only way the accounting
reverses cleanly: returning at today's price misstates revenue, returning at
today's average cost invents a profit on goods that only travelled to the
customer and back, and returning at today's tax rate files the wrong credit
note.

**You cannot return more than went out.** Each line draws down against what the
original carried, minus what earlier returns already took. The check is keyed by
invoice line rather than by product, so the same item at two prices on one
invoice is tracked separately. The form shows what is left before anybody starts,
and the server refuses it again on the way in.

### A credit note, against an invoice

```
   4 returned of 10 sold at ₹100, 18% GST
                       │
   ┌───────────────────┼──────────────────────┐
   ▼                   ▼                      ▼
 Stock ledger     Journal entry          GST register
 +4 PCS           Dr Sales Returns 400   SalesReturn rows
 @ the cost the   Dr GST Output     72   at −400 taxable
 sale issued it   Cr Receivables   472   and −72 tax
                  Dr Inventory     240
                  Cr Cost of Sales 240
```

**Sales Returns, not a smaller sale.** The return debits a contra-revenue
account beside Sales rather than reducing it. Netting the two would hide the
return rate, which for a retailer is one of the more diagnostic numbers there
is — and the trading account still shows gross sales less returns, because that
is what a contra account is for.

### A debit note, against a bill

The mirror, with one asymmetry that matters. Under perpetual inventory a
purchase is never an expense — it debits stock — so a return **credits stock**
rather than a contra-purchase income account. The goods are physically back with
the supplier, and an asset that is not there must not sit on the balance sheet.

The second asymmetry follows from the first. Stock leaves at what the valuation
method says it is worth today, exactly as any other issue does, because that is
what keeps the Inventory account and the stock ledger in agreement. But the
supplier refunds the price on _their_ bill. Where freight was capitalised, or
the weighted average has moved since, the two disagree — and the difference is
real money. It is recognised as a direct cost rather than left inflating the
value of goods that have gone.

**Input credit is given up.** Tax claimed on goods that went back is reversed,
which is what a debit note does under GST.

The standard chart still carries a **Purchase Returns** account at 5002, and it
stays at zero. It is the contra to Purchases at 5001, which under perpetual
inventory is never posted to either — the pair is kept for businesses migrating
from periodic books, not because anything here writes to it. A debit note is
found under Returns and in the journal, not in that account.

### What both do to the tax register

Negative rows are **appended**; the original document's rows are never edited.
A period somebody has already reviewed still reads the way it did when they
reviewed it, and the return appears in the period it happened in rather than
retrospectively changing an earlier one.

Returns are rounded to the rupee like every other document here, and the
fraction is posted to Round Off rather than absorbed. A credit note for ₹176.65
is issued at ₹177 with 35 paise accounted for — the alternative is an entry that
does not balance, which is how this was found.

---

## Payroll

Salaries for a month, posted as one balanced entry — and the entry is the
reason this module is worth reading about, because payroll is the transaction
where the obvious posting is wrong.

Gross pay is a cost and net pay is owed to staff, but the gap between them is
not one thing. It is four separate debts to four separate authorities, each
with its own due date: provident fund to the EPFO, insurance to the ESIC,
professional tax to the state, TDS to the income tax department. Crediting them
to a single "deductions" account produces an entry that balances perfectly and
cannot answer _what do I owe the EPFO this month_, which is the only question
the deduction exists to raise.

```
   Two staff, ₹40,000 of gross pay, EPF and professional tax applicable
                                │
   Dr Salaries & Wages   40,000     Cr Salary Payable          35,800
   Dr Employer Contrib.   3,600     Cr PF Payable               7,200
                                    Cr Professional Tax Payable   200
```

**The employer's share is a cost, not a deduction.** Its own expense line, so
what an employee is paid and what they cost are two visible figures rather than
one blurred into the other. Both halves credit the same liability, because both
are remitted in a single payment.

**Three schemes are computed; one is not.** EPF at 12% of basic to the ₹15,000
ceiling, ESI at 0.75% and 3.25% of gross with the ₹21,000 limit — where an
employee above it leaves the scheme entirely rather than contributing on a
capped wage, which is the rule people get wrong — and professional tax as a flat
monthly figure above a threshold.

**TDS on salary is not computed, and the product says so on the page.** It
depends on the employee's projected annual income, the regime they elected, what
they declared by way of investments and rent, and what a previous employer
already withheld. A figure produced without those inputs would look like a tax
computation and be a guess, and a wrong one lands on the employee rather than on
the business. It is entered by whoever runs the payroll, or left at nil.

Whether an establishment is covered by EPF or ESI at all is a fact about the
business — headcount, registration, when it crossed the threshold — so both
default to off and are switched on deliberately. Professional tax is null rather
than inferred from the address: every state sets its own, and a plausible wrong
default is worse than an obviously absent one.

A period can be paid once. Salaries are read from the employee records on the
server, so the form can say when staff are paid and how much tax was withheld,
and cannot say what anybody earns.

---

## Reports

Fourteen of them, and not one adds up a column of its own.

A report here is a _view of figures something else already computed_. The trial
balance report runs the trial balance service. The profit and loss report runs
the statements service. The ageing reports run the ageing service. Every card on
the hub names the module its figures come from, so a reader who wants to argue
with a number knows where to go and do it.

That is a constraint rather than a convenience. A reports module that computes
is one that will eventually disagree with the page it claims to summarise, and
when the trial balance says one thing and the trial balance _report_ says
another, neither is usable by anybody. The integration tests run the report and
the source and compare them, which is the only assertion about this module worth
making.

|                |                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Accounting** | Trial balance · Profit and loss · Balance sheet · Day book · Account ledger                                                                                |
| **Business**   | Sales register · Purchase register · Expenses by category · Stock on hand · Receivables ageing · Payables ageing · Customer statement · Supplier statement |
| **Compliance** | GST summary                                                                                                                                                |

**Three of them are about a subject, not just a period.** An account ledger, a
customer statement and a supplier statement each need to know _which one_ before
they mean anything, so those reports ask, and until somebody answers there are no
figures on the page and no export link beside them. Nothing is pre-selected:
showing the first account in the chart as though it were the answer to a question
nobody asked is worse than an empty page that says "Choose an account".

The subject is checked against what this tenant owns before it is used. A
customer id borrowed from another company is _refused_, not quietly rendered as a
statement with no rows in it — an empty report and a report somebody was not
allowed to run must never look the same, or the interface has taught a reader to
read a refusal as a fact about their business.

A ledger and a party statement are the same document reached two ways: opening
balance, the movements in the window, a running balance, closing balance. So
there is one renderer, and the customer statement is the receivables ledger for
one customer rather than a second implementation of the idea. An account with no
movement in the window is still not empty if it carries a balance forward —
"nothing happened in March" and "there is nothing to say" are different
statements, and only the second earns a "Nothing to report".

**Two gates, not one.** `reports.view` opens the cabinet; each report still asks
for its own drawer. Somebody who may read reports but not purchases does not get
the purchase register by asking for it as a report — and the download route asks
the same questions the page asked, because an export endpoint that checks less
than the screen is simply the way around a permission.

**Exports are CSV, and print is print.** The file is built on the server from
the same call the page made, so it cannot disagree with what was on screen, and
money is written in its exact stored form rather than as `₹1,04,522.00` — a
figure no spreadsheet will add up. A report's caveats travel into the file with
it, because a note that only appears on screen is lost the moment somebody
emails the export, and the export is the copy that travels.

There is no PDF renderer and no `.xlsx` writer. Print is the browser's own
dialogue, which is also how a PDF gets made, against a stylesheet that drops the
shell and repeats table headers across pages. CSV opens in Excel. Shipping two
document-generation libraries to produce second, differently-laid-out copies of
a page that already exists was not worth it, and claiming a "PDF export" for a
print button would have been the kind of overstatement the rest of this document
avoids.

**A spreadsheet is an interpreter, not a viewer.** A cell whose text begins `=`,
`+`, `@` or a control character is evaluated as a formula when the file opens,
and that text came from whatever somebody typed into a product name. Quoting is
not a defence — a quoted field is evaluated just the same — so a leading formula
character is defused with an apostrophe. A figure that is merely negative is
left alone: `-472.0000` is not a formula, and mangling every negative number in
the ledger to guard against one nobody wrote would be its own kind of wrong.

**Every export is written to the audit log.** A report is the form in which a
tenant's figures actually leave, and "who took a copy of the ledger, and when"
is a question worth being able to answer.

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

## What a receipt does

Money in and money out are the same event with the arrow reversed, so one engine
posts both, and two rules hold it together.

**The control account always moves by the full amount.** Receiving ₹5,000 from a
customer reduces receivables by ₹5,000 whether or not anyone says which invoice
it was against. Allocation — which bill it settled — is a sub-ledger question,
not a ledger one. Money that is not matched to a document is an advance, which
is a real position a customer can be in, and it is shown as such rather than
being quietly forced onto the oldest invoice.

**An allocation can never exceed what is owed.** Over-allocating would report an
invoice as more than settled and net away somebody else's debt, so every figure
is checked against the document's own outstanding amount inside the posting
transaction — not against what the browser said a moment earlier.

**Not everything that arrives is income.** Capital the owner puts in is equity,
a loan received is a liability, and money the owner takes out is drawings that
reduce capital. None of the three touches the profit and loss account, and the
form says so in the words a retailer would use rather than in account names.

**Ageing counts from the due date, not the document date.** An invoice on 30
days' credit raised three weeks ago is not overdue, and a report that says it is
sends someone to chase a customer who has done nothing wrong. Outstanding is
total minus settled, read from the documents themselves — never a stored running
balance, which drifts the moment anything is voided and has nothing to reconcile
against.

Voiding a receipt reverses its entry and takes the allocations back off the
invoices they cleared, so those invoices are outstanding again and reappear in
the ageing. Nothing is deleted: the original entry, the reversal and the reason
all stay.

---

## Where the figures come from

Every account balance in the product is computed in one place. The chart of
accounts, the dashboard, the ledger and the statements all read the same
function, so there is exactly one answer to "what is in Cash in Hand" and no two
screens can disagree.

Three rules hold it together.

**Only posted lines count, and a void is cancelled by its reversal rather than
excluded by status.** That is what lets a voided sale stay visible in the journal
— the business did raise that invoice — while being absent from the profit
figure. Filtering documents by status instead would make the journal and the
statements tell different stories.

**Opening balances are ordinary journal entries.** A business migrating in posts
its starting positions on the day before the year opens, so nothing needs a
special case for them. An opening-balance column fed by a different mechanism
than the rest of the ledger is a column that eventually disagrees with it.

**Balances are reported where they actually sit, not where they ought to.** A
supplier ledger with a debit balance is an advance paid; forcing it to the credit
column by the account's declared nature would hide exactly the anomaly a trial
balance exists to surface.

Nothing is a stored running total. Balances are aggregated from the lines on
every read, because a stored balance drifts the moment an entry is backdated or
voided and there is nothing to reconcile it against.

The chart itself is editable, within limits that keep the engine standing.
Posting rules resolve accounts by a `systemKey` no one can edit, so any account
can be renamed — call Sales "Counter Takings" if that is the word used in the
shop — while the accounts the engine posts to cannot be removed or reclassified.
Accounts are retired, never deleted, and an account still holding a balance
refuses to be retired until it is cleared.

---

## The journal

Every entry the books contain, in one register, whatever produced it. Most were
derived from a document, and each says which — clicking from a journal line to
the invoice behind it is how the accounting stops being something that happens
elsewhere.

A few things are genuinely only accounting: depreciation, an accrual, a
prepayment released over the year, a bad debt written off. Those are posted by
hand, and the path is fenced deliberately.

**A document's entry is never reversed from the journal.** Reversing the entry
behind an invoice without touching the invoice would leave the sale standing in
the sales register with no accounting under it — the two would disagree and
neither would be obviously wrong. Void the document; its entry follows, along
with the stock it moved and the settlements that went with it.

**A control account needs a name.** Posting to Accounts Receivable without
saying whose debt it is creates a receivable nobody can chase, age or settle. A
bad debt write-off is a real and necessary entry, so it is allowed — attributed
to the customer whose debt it was.

**Sales and purchases are not on the list of things you can post by hand.** A
sale entered as a journal entry would move the ledger without moving the stock,
without a GST register row and without a document to show anyone.

The form shows the running difference as you type, names which side is short,
and keeps the button disabled until it is nil — an accountant works the entry
out as they enter it, and being told after a failed submit what they already
knew helps nobody. The same schema then runs again on the server, which posts
through the same engine every other module uses.

---

## The ledger

One account at a time, laid out the way a paper ledger is: balance brought
forward, every movement in date order, the running balance beside each line,
balance carried forward. A retailer who has kept a bahi khata recognises the
page immediately, which is the point — software that replaces a thing should
look like the thing before it looks like software.

Two details make it harder than it appears, and both would fail quietly.

**The running balance has to survive pagination.** Row 51 shows the balance
after fifty-one transactions, not after the one above it on the page.
Accumulating in the view would restart at the opening figure on every page and
each page after the first would be wrong, so the running total is computed by
the database across the whole ordered set with a window function and the page is
taken from that.

**The ordering has to be total.** Two entries on the same day need a tiebreak,
or the running balance shuffles between page loads and two printouts of the same
ledger disagree with each other. Date, then entry number, then line number — no
two lines can tie on all three.

On a customer or supplier account the ledger can be narrowed to one name, which
makes it the statement you would send someone disputing a balance. It reconciles
with the ageing report exactly, because both are derived from the same posted
lines rather than from separate running totals.

Balances are shown as a positive figure with `Dr` or `Cr` beside them rather
than as negative numbers, and the closing balance is also stated in words —
"Sharma Provision Store owes you this much" rather than "₹1,180 Dr".

The reports catalogue offers the same page as an account ledger and a party
statement, so it can be exported and printed with the rest. It calls this
service. There is no second query that walks the journal again and eventually
disagrees with this one about what a customer owes.

---

## The trial balance

Every account with a balance, in two columns, grouped by type and totalled. It
is the checkpoint between the ledger and the financial statements: if the two
columns disagree there is no point producing a balance sheet, because it cannot
be right. `assertLedgerBalances()` is the gate the statements sit behind, and it
refuses rather than rounds.

Give it a start date as well as an as-at date and it splits into what was
carried in, what moved, and what is left — the shape an accountant wants at year
end.

Two things about it are stated on the page rather than left implied.

**A balanced trial balance does not mean the books are correct.** A purchase
recorded against Rent instead of Purchases balances perfectly and is still
wrong. It catches arithmetic, not judgement — and in this system it catches
little even of that, because an unbalanced entry cannot be written in the first
place. It is here because it is the report an accountant asks for, and because
seeing it agree is worth something.

**Balances are reported where they actually sit.** A supplier ledger with a
debit balance is an advance paid; putting it in the credit column because
payables are supposed to be credits would hide exactly the oddity the report
exists to surface.

Every account name links to its ledger, because "why is Rent ₹48,000" is the
next question and it should be one click away.

---

## The financial statements

A trading account, a profit and loss account and a balance sheet, all three
derived from the same posted lines the ledger and the trial balance read. No
figure is stored and none is computed a second way, so none of them can disagree
with a ledger reached from it.

**They are gated on the ledger balancing.** Producing a balance sheet from a
ledger whose two sides differ means publishing a figure known to be wrong, so
the check runs first and the page refuses, pointing at the trial balance.

**The trading account is the perpetual form, because that is how these books
work.** A bill puts goods into stock; a sale takes their cost out of stock at
the moment it happens. The textbook periodic layout — opening stock plus
purchases less closing stock — would print ₹0 against Purchases here and mislead
anyone who knows the classical form. Gross profit is revenue less the cost of
what was actually sold, and the page says why there is no Purchases line rather
than leaving a reader to wonder.

**Profit sits inside capital on the balance sheet.** Income and expense accounts
are not closed to retained earnings until a year-end close, which this system
does not yet perform, so what has been earned is shown as its own line within
the owner's stake. Without it the two halves would differ by exactly the profit
— and it is the owner's, whether or not a closing entry has been written.

Period figures and position figures are read from separate windows. Income and
expenses are measured _over_ the period; assets, liabilities and capital _at_
its end. Mixing the two is the classic way to produce a balance sheet that does
not balance, and there is a test that runs the statements over a single month of
a longer history and asserts the sheet still agrees.

Above the statements is a plain-language reading — what was left out of every
₹100 of sales, what running the shop cost, whether the period made money. Every
figure in it is read straight off the statement below. It says explicitly that
it is not advice, and that an accountant should review the statements before
they are relied on or filed.

---

## Inventory

Positions are never entered. They are the consequence of the bills and invoices
already recorded, and the only thing the module writes is a correction.

**Stock is reconciled against the books, and the answer is shown.** It is
recorded twice by design — as quantities in the inventory ledger and as a rupee
balance in the Inventory account — by different code down different paths. Three
figures must agree: the cached position on each product, the sum of every
movement ever recorded for it, and the ledger balance. If they diverge, one of
them is lying and every margin built on the cost of sales is suspect. This is
the inventory analogue of the trial balance, and it is the single most useful
thing the module can tell a retailer deciding whether to trust their own
figures.

Nothing is repaired automatically. A reconciliation that silently corrects what
it finds destroys the evidence of how it broke.

**A count that differs is a transaction, not an edit.** A physical count almost
never matches exactly: things are dropped, spoiled, taken, or miscounted at the
till. Pretending otherwise leaves a retailer with a figure they know is wrong
and no honest way to fix it. So an adjustment says what was counted and why, and
posts real accounting.

Stock lost is a cost recognised now — goods bought and never to be sold have
already been paid for, and leaving them in inventory overstates both the asset
and next month's margin. Stock found is _not_ income: it is a correction to an
asset that was understated, so it reverses the same expense rather than being
credited to revenue. Treating it as income would inflate turnover with goods
nobody bought, and on a GST return that is a number with consequences.

The form asks what was counted, never the difference. A retailer counts the
shelf; asking them to work out and sign a delta invites a sign error nobody
notices until the stock figure is meaningless. The books' figure is shown beside
the box, and what will happen — how much moves, what it is worth, where the
value goes — is spelled out before anything is posted.

---

## GST

**Nothing here is a filing, and nothing here claims to be.** The platform
prepares a working paper from the transactions already recorded; a person
reviews it and files on the GST portal. The banner says so, the description says
so, and there is no control anywhere that could be mistaken for submitting —
because a retailer who believes their return has gone in when it has not is
worse off than one with no software at all. An end-to-end check asserts no such
control exists.

**The set-off order is applied properly.** IGST credit is used first and must be
exhausted before CGST or SGST credit is touched; CGST credit may never be set
against SGST, or SGST against CGST, because the two belong to different
governments. Cess is ring-fenced to cess. Getting this wrong produces a payable
that is arithmetically defensible and legally wrong, so the rules live in one
pure module with the whole table under test, including the crossings that must
never happen. The page explains the order rather than only applying it — and
explains it even when there was no credit, which is exactly when someone asks
why they are paying the whole amount.

**Only claimable credit is set off.** Tax on a purchase marked as not
recoverable never became an asset; it went into the cost of the goods. It is
shown separately so the two figures add up to the tax actually paid, and
labelled as not part of the claim.

**The register is reconciled against the ledger.** GST is recorded twice — as
rows in the tax register and as balances in the GST accounts — by different
code. A difference means the return is being prepared from figures the books do
not support, and the page says not to file from it until that is explained.

Sales are split into the B2B table (by customer, as GSTR-1 wants) and B2C
(summarised by rate, because names are not reported), with a rate-wise summary
and an HSN summary. Invoices are counted as documents, not register rows: one
invoice carrying three rates is one invoice, and counting rows would overstate
every table on the return.

---

## Income tax

**Every figure is an estimate prepared for review, and not tax advice.** It is
arithmetic applied to a rate table. It does not know about salary, rent,
interest, capital gains, deductions under Chapter VI-A, or losses brought
forward from earlier years — and for a proprietor, whose business income is
taxed as part of their own, those are usually what decides the answer. The
banner says so before anything else on the page, and nothing there files,
submits or pays anything.

**It starts from the books rather than beside them.** The book profit comes out
of the same statements engine every other report reads, so the computation
cannot disagree with the profit and loss account. Turnover is revenue net of
returns, straight out of the trading account.

**Book depreciation comes out and the Act's goes in.** They are different
calculations on different rules and are not meant to agree. The Act pools assets
into blocks defined by their rate, writes each block down on its written-down
value, gives half the rate to anything bought with under 180 days of the year
left, and takes sale proceeds off the block rather than off the asset — so
proceeds that exhaust a block leave no depreciation at all. Where an asset
carries no rate of its own the block is guessed from what it is called, and the
working paper prints the guess next to the asset rather than burying it.

**Disallowances are found in the records, not assumed.** Cash paid to one person
in one day above the section 40A(3) limit is a fact about vouchers that exist,
and it is listed with them. The limit is on the day's total, not on any single
voucher — three payments of ₹4,000 to one supplier on one date are caught, which
is the point of aggregating. Drawings are excluded, because money the owner
takes out is not expenditure. Cash spent on an asset is separated out too: that
is not disallowed as expenditure, it stops counting towards the cost for
depreciation, which is a different consequence.

**Judgement is left where it belongs.** The mechanical adjustments are applied;
the ones turning on facts the platform cannot see are shown as a second figure.
Supplier bills unpaid past 45 days are exposure under section 43B(h) only if the
supplier is a registered micro or small enterprise, which is on their invoice or
the Udyam portal and not in these books — so the page shows the amount, says
what has to be checked, and calls the list a floor rather than the whole of it.
The result is a range with both ends explained instead of one number carrying
more confidence than it earned.

**A loss is reported as a loss.** The computation is a statement that has to add
up, and a figure quietly floored at nil turns three lines that should reconcile
into three that do not. There is no tax on a loss and no refund either; it
carries forward, which this does not track.

**Section 44AD sits beside the computation, not instead of it.** Deemed income
at 8% of turnover and at 6% on the part received through banking channels, with
the ceiling that applies given the receipt mix — ₹2 crore, or ₹3 crore where
cash is within 5%. The same cash share decides whether the section 44AB audit
limit is ₹1 crore or ₹10 crore, and a shop that banks nearly everything is often
entitled to the relaxation without knowing. That share is measured from movement
on the cash and bank accounts, excluding opening entries: money in the drawer
when the year opened was not received during it.

**Rates are versioned by assessment year, and a carried-forward table says so.**
A computation on the wrong year's law looks exactly like a correct one, so an
unknown year computes nothing rather than borrowing another year's rates. The
year in progress uses last year's rates until the Finance Act is entered, marked
provisional on the face of every figure.

Both regimes are shown side by side for anyone who has the choice, cheapest
first — that ordering is arithmetic on this year's business income, and the page
says as much rather than recommending one. Advance tax instalments fall on the
prescribed dates, and the liability is rounded to the nearest ten rupees as
section 288B requires.

---

## Analytics

**Nothing here is predicted.** Every figure is arithmetic on entries already
posted; forecasting is a separate thing and arrives labelled as such.

**The trend cannot disagree with the statements.** Revenue per bucket is the
movement on the trading-account income accounts — the same definition the
profit and loss account uses, on the same posted lines, grouped by date in the
database. The buckets add up to the revenue on the statements to the paisa, and
a test asserts exactly that. A manual entry to Sales belongs in the trend for
the same reason it belongs in the P&L.

**The breakdowns read the invoice lines, and the page says so.** Which product
earned what cannot come from the ledger, because the ledger does not know about
products. Where a discount or a manual entry was posted straight to an account
the two views differ slightly, which is stated rather than reconciled away.

**Product margins use the cost captured when the sale posted**, not today's
purchase price. A margin recomputed from the current price would move every
time a supplier changed theirs, and would say something different about last
month every month. The page also names the case worth knowing: the biggest
seller is often not the biggest earner, and both facts are true.

**Growth against nothing is not a percentage.** Where the previous period had
no sales the tile says there is no comparison and gives the absolute change,
which is meaningful either way. The comparison window is always the same length
of time immediately before, and a running year is reported up to today rather
than to a year end that has not happened.

**Concentration is an observation, not a warning.** Where one customer is 40% or
more of a period's sales the page says so — and only where there are at least
three names, because with two customers a 50% share is arithmetic rather than
concentration. Whether it is a risk depends on the relationship, which the books
cannot see.

Eleven ratios sit behind all of it: margins, running costs, stock turnover and
days, collection and payment days, the cash cycle, current and quick ratios and
return on capital. **A ratio that cannot be computed honestly is not shown as a
zero.** A shop holding no stock has no stock turnover, and "0 times" would say
its stock never moves — the opposite of the truth. Each one shows the reason
instead. Where a figure crosses a line that is factual it is flagged: a current
ratio under 1 _means_ short-term debts exceed short-term assets. Where the right
level depends on the trade, no verdict is offered.

**The health indicator is not a credit score.** No bureau issues it, no lender
sees it, it has no bearing on any loan, and the sentence saying so lives beside
the computation rather than in the interface, so a second place that shows the
figure cannot show it without the caveat. Five weighted components each state
their rule and the figure it was applied to, so the number can be re-derived by
hand. Where fewer than three can be measured there is no score at all — a shop
three weeks old has nothing to say about collection days, and scoring it would
be a judgement about missing data rather than about the business.

---

## Forecasting

**A forecast is a range, never a figure.** "Revenue will be ₹5,42,300" is a
sentence no honest arithmetic produces, and putting it in large type invites
decisions the numbers do not support. Everything on this page comes back as a
band, the band is drawn from how far the shop's own history fell from the
fitted line, and where there is a middle it is drawn thin, dashed and second.

Two panels make two different kinds of claim, and the page says which is which.

**Revenue is a fit.** Ordinary least squares through the weeks already
recorded, with the textbook prediction interval — which widens the further out
it reaches, because it should, and because that falls out of the formula rather
than being imposed on it. The band is 80%, not 95%: a 95% band on a shop's
weekly takings is so wide it says nothing. The method is explainable in one
sentence to the person whose business it is, which a gradient-boosted anything
is not.

**Cash is not a fit at all.** It rolls forward commitments that already exist:
invoices raised, bills received, and a running cost taken from what the shop
actually spent over the last thirteen weeks. Depreciation is excluded, being a
real cost that never moves any cash. Money from sales not yet made is
deliberately absent, which makes the line a floor rather than a prediction —
and money already past its due date lands in the first week rather than being
dropped, because a projection that quietly forgets overdue money is one that
flatters.

Two cash lines are drawn, both out of the shop's own records. One has every
invoice landing on its due date. The other shifts each invoice by the days
customers have actually been taking past it, measured from receipts already
allocated to invoices rather than assumed. **The gap between those lines is what
slow collection costs, stated in weeks of cash.** Where nothing has been settled
yet there is nothing to measure, the two lines are identical, and the page says
why.

Three refusals, each of them tested:

- **Too little history is a refusal, not a guess.** Six periods is the floor;
  below it there is a stated reason where the projection would have been.
- **A history too uneven to narrow down says so.** Where the band is wider than
  the figure inside it, the page tells you to read the range as the answer and
  treat the middle of it as meaningless.
- **A suspiciously perfect history admits it.** Every point falling exactly on
  the line gives a band of nothing, which would be the most overconfident output
  the module could produce.

Two limitations are stated every time, including on the refusals: this is a
straight line through what has already happened, and there is no seasonal
adjustment — a shop whose Diwali is far bigger than its March will not see that
pattern here. The direction of travel is words rather than a rate, because
"trending up 3.7% a week" reads as a fact about the future.

Nothing is stored. A forecast written to a table goes stale the moment the next
invoice is posted, and a stale projection nobody remembers generating is worse
than one computed on the spot.

---

## The AI Accountant

**The assistant does no arithmetic.** Every figure it states comes from a tool
result it has just received, and each of those nine tools is a thin wrapper
over a service that already exists — the same balance engine the statements
read, the same GST working paper the GST page shows, the same ratio set
analytics displays. The model is never in a position to calculate a financial
figure, because it never has the pieces: it asks a question and receives an
answer application code computed.

**No tool takes a company.** Not one input schema has a `companyId`, and a test
walks every schema — nested fields included — asserting none ever appears. The
tenant is bound by the runner from the session. A call carrying `companyId`,
`tenantId` and `company` pointing at another business returns this business's
figures, because validation strips fields the schema does not have and the
identifier has nowhere to land. That case has a test of its own.

**No tool writes.** Every entry is marked read-only, the runner checks it before
dispatching rather than trusting the catalogue, and a tripwire test fails on any
tool name containing create, post, update, delete, void, edit, write or remove.
Asked to record something, the assistant says it cannot and names the page that
can.

**Every answer carries the queries behind it.** Tool calls are persisted against
the message with their arguments and results, and the interface puts them one
click away — so a figure quoted in June can be traced in December.

**An answer that quotes money without asking for any is marked.** That check is
deterministic and runs before anybody reads the reply: no tool call in the turn
plus a rupee figure in the text means the number came from the model's own head,
and the interface says the figure could not be traced to a query. It does not
depend on the model admitting anything.

**Where no provider is configured, nothing is faked.** A fresh installation has
`AI_DRIVER=disabled`; in that state the page says the assistant is not switched
on, the composer is disabled, and no substitute answers anything. An assistant
that invented plausible replies when its provider was missing would be worse
than one that is honestly off. The API key is read in one module, used in one
header, and never returned, logged, or put into an error message.

A transcript belongs to one user of one company. A conversation id from somebody
else's session resolves to nothing rather than to their transcript, which may
quote figures their role is not allowed to see.

---

## The AI Auditor

**Nothing here accuses anybody of anything.** A set of database queries has no
standing to call a person dishonest, and a shop owner reading "possible fraud"
about their own books is being told something the software does not know. So the
vocabulary is enforced rather than intended: a list of words the auditor may not
use — fraud, theft, stolen, embezzlement, criminal, dishonest, and the rest — is
tested against every title, description, recommendation and explanation in the
catalogue, and again against the findings a real run produces on seeded books.
The end-to-end pass reads the rendered page and asserts the same thing.

**No model produced any of it.** The checks are SQL, the severities are fixed in
the catalogue, and the score is arithmetic on them. The word "AI" in the name of
the page describes where it sits in the product, not how the findings were
reached — which is why the same run on the same books gives the same answer
twice.

**Every finding carries the other half of the sentence.** Alongside the evidence
that made it fire, each one lists the ordinary reasons it usually happens: stock
going negative is far more often a sale entered before its purchase than
anything else, and a round-figure cluster is far more often a shop that prices in
round figures. Those explanations sit in the catalogue, are read at display time
rather than frozen into the row, and are required by test to exist and to be
long enough to say something.

**The score can be worked out by hand.** It starts at 100 and each finding takes
off a fixed amount for its severity — 40, 15, 6, 2, and nothing at all for the
informational ones — floored at zero. The risk level is the worst single finding
and does not rise with the count, because twenty small things are still twenty
small things and inflating the level would make the word meaningless. Beside the
number the page says what it is not: not a measure of honesty, not comparable
with any other business, and seen by nobody outside the account.

**A run replaces what is still open, and leaves alone what somebody has
answered.** Findings marked seen, sorted, or not-a-problem-here survive the next
run and stay out of the score. A judgement about a finding is worth more than the
finding, and re-raising it every night is how a list teaches people to ignore it.
Each run records the rule-set version that produced it, so a finding that
vanishes next month can be explained by the rules changing rather than the books.

**A check that fails is named, not hidden.** The checks run independently and the
run reports which could not be completed. An audit that returned nothing because
one query broke would be worse than one that says which one broke.

One check earned its keep before shipping: the backdated-entry rule fired on
every newly registered company, because the opening-balance entry is dated the
first day of the financial year and created at signup, so it is late by
construction. That was fixed in the check — opening and closing entries are
excluded from anything measuring when work was entered — rather than tested
around. A rule that fires on clean books on day one is precisely how a findings
list gets ignored.

Ten of the eleven rules in the catalogue have a check behind them. The eleventh,
the GST register against the ledger, is reconciled on the GST page but is not yet
part of an audit run — it is listed here because the catalogue is the honest
place to see what is and is not covered.

Passing every check is not an audit in the statutory sense, and the page says so.
A purchase recorded against Rent passes every one of them and is still wrong.

---

## The AI Business Advisor

**No model produced any of this either.** Ten detectors run over figures the
platform has already computed — the receivables ageing, the cash projection, the
analytics report, the stock positions — and every threshold in them is a named
constant. The same books produce the same list every time, which is the whole
point: a suggestion you disagree with is one worth arguing with rather than one
worth re-rolling until it says something else.

**Nothing here promises an outcome.** The advisor is reading one shop's books
and nothing else. It has not met the customers, does not know which supplier is
reliable, and cannot tell a deliberately quiet month from a bad one. So a list of
words that promise — guarantee, will increase, risk-free, you must — is tested
against the catalogue and against the sentences a real run actually produces. It
matches whole words, because "indefinitely" contains "definitely" and a shop
whose stock turns faster than its suppliers' credit can run below a current ratio
of one indefinitely without anybody promising anyone anything.

**What a suggestion is worth is said three different ways, and the difference is
the point.**

- **Recorded.** Overdue receivables are not an estimate of anything. That money
  has been earned, invoiced, and is sitting somewhere other than the bank, and
  the figure quoted is the figure the ageing report shows — asserted by test
  against the same query the receipts page reads.
- **Estimated.** A margin slip is worth something only under an assumption, so
  the assumption is printed beside the amount and the answer is a band rather
  than a point. The band is not vagueness; it is the actual precision. Estimates
  rank on the low end of their own band, because ordering the list by the
  optimistic end would put the most speculative suggestions at the top.
- **Unquantified.** What an empty shelf costs is not in any ledger, because a
  sale that did not happen is not recorded anywhere. Putting a figure on it would
  mean inventing the customers who turned round and walked out, so the page says
  there is no honest figure instead.

**Every suggestion carries the case against itself.** Beside what to do sits
_when this does not apply_ — the seasonal line whose season has not come, the
large buyer whose payment run is monthly, the loss leader that brings people
through the door, the owner's loan sitting in current liabilities that is not
going to be called. These get the same room on the page as the suggestion, and
each is required by test to be there and to say something. A shopkeeper who knows
their trade will often read one of these and be right to ignore it; the page is
built for that reader rather than against them.

**Urgency is arithmetic, not adjectives.** Each suggestion starts at the urgency
its kind deserves — running out of cash next month outranks a long cash cycle
whatever the amounts — and rises one step when the amount at stake passes a tenth
of the period's revenue, because "when you can" is the wrong label on a tenth of
the year's turnover. Nothing is ever de-escalated: a small overdue balance is
still money somebody owes. The page says when a suggestion was moved and why.

**Nothing is padded.** A detector that finds nothing returns nothing, there is no
minimum list length, and a shop with nothing to fix is told that rather than
handed three vague ideas so the screen looks busy. Where one of the four readings
of the books fails, it is named — a short list is not the same as a clean one.

**Two decisions were about not duplicating logic.** Concentration defers entirely
to the threshold the analytics service already applies, because two rules for one
fact is two pages that can disagree about it. And the stock detectors read the
same rows the inventory page builds, extracted rather than reimplemented.

The slow-moving-stock detector fired on every newly registered company before it
shipped, for the same reason the auditor's backdated-entry check did: opening
stock is dated the first day of the financial year whatever day it was entered.
It now declines to judge staleness until the books are older than the window it
measures, and never claims stock has been still for longer than the books have
existed. Greeting a new business by telling it all of its stock is dead is how a
page like this gets ignored on day one and never opened again.

---

## Subscriptions

**Entitlements are data, and the server is what checks them.** A plan's
features are a list on a row rather than a `plan === "business"` conditional, so
packaging changes without a deployment and one customer can be given something
without a special case nobody will remember to remove. Every feature-gated page
asks for itself and every action that adds to the books asks before it writes.
Until this phase the sidebar marked what a plan did not include and nothing else
stopped anybody — a Starter customer could type `/app/ai/auditor` and use it.

A tripwire test reads the page sources and fails if a feature-gated navigation
item has a page that does not call `featureGate` with that same feature. It
cannot prove the gate returns the right answer — the integration tests do that —
but it catches the mistake actually worth catching, which is somebody adding the
eleventh gated module and forgetting.

**A lapsed subscription stops new entries. It never seals the ledger.**
Everything already recorded stays readable, printable and exportable for as long
as the account exists, the modules stay on the page, and every read-only refusal
says so in the same breath as the refusal — asserted against all three messages,
including that none of them uses the words delete, lost or removed. A shopkeeper
who stopped paying in March still has a return to file in July, and software
that holds their own accounting hostage to collect a debt is not something worth
building.

Editing what is already there stays open when a subscription lapses; only adding
stops. And a downgrade never reaches into the records: five users moving to a
two-user plan all keep working, nothing is deleted, and adding a sixth is what
waits.

**Three refusals, deliberately kept apart.** `FEATURE_NOT_INCLUDED` is about
packaging, `FORBIDDEN` is about a role, and `SUBSCRIPTION_READ_ONLY` is about
payment. They are checked in the order a person would ask, so nobody on a plan
without the assistant is told they have used up their AI messages. All three are
returned as results rather than thrown, because an action in this codebase does
not throw for something a form has to render.

**Status is worked out, not trusted.** A trial past its end is expired whether
or not a nightly job has run, and a period that ended without a renewal is late
— a subscription that is only correct after a sweep is one that is wrong every
night. A declined payment gets a week of grace before anything stops, because a
declined card is usually a declined card rather than a decision.

**Usage is counted from the records.** Members, branches, products, this month's
transactions and this month's AI messages are counted by querying, not by
keeping a running total beside them: a counter that has drifted is how a
business ends up unable to add the third of the three users it is paying for. A
pending invitation counts as a seat, because counting only accepted ones lets a
two-seat business invite twenty people and find out on the day they all sign in.

**This build cannot charge anybody, and says so.** The environment schema knows
about Razorpay and Stripe, the tables carry the provider columns, and there is a
seam for an integration — but none is written, and nothing pretends otherwise. A
plan change that would cost money is declined with the reason. Downgrades and
cancellations, which cost nothing, apply immediately. No upgrade is granted that
nobody paid for and no invoice is marked paid that no bank has seen. A working-
looking "Pay now" button that resolved against nothing would be a lie told to a
shopkeeper about their own money.

---

## Platform administration

**Running the service does not require reading anybody's books.** Somebody has
to answer a support email, see why a tenant cannot add a user, change what a
plan costs, suspend an account that is abusing it — and none of that needs a
shop's ledger. So the line is written down rather than assumed: operational
metadata is visible, a tenant's own money is not.

| Visible                                     | Not visible                            |
| ------------------------------------------- | -------------------------------------- |
| How many entries a business made this month | What any of them was for               |
| How many people can sign in, and as what    | What the business sold, owes or earned |
| Which plan, what it costs us, what it pays  | Who its customers and suppliers are    |
| Whether the account is suspended            | Any balance, invoice or statement      |

A support engineer needs to know a tenant posted 400 entries last month to
answer "why am I being told I have hit my limit". Nobody needs to know one of
them was for four lakh rupees to answer that, and a panel that shows it anyway
turns every support request into an unlogged disclosure of somebody's turnover.

**The tests run against what the panel actually returns.** A company is
registered, given stock, and made to sell 250 units at ₹137; then every admin
payload is swept both for the field names money travels under and for the
figures themselves, in each of the shapes money leaves this codebase in.
Customer names are checked the same way — who a shop trades with is worth as
much as what it sold them. The end-to-end run does it again against the rendered
page.

The first version of that sweep flagged `tenants.total` and `list.total`, which
are row counts. A guard that fires on every count gets suppressed within a week,
so bare `total` came out of the name list and a value-based check went in: it
catches the same number arriving in a field called something else, which is the
failure that would actually survive review.

**There is no impersonation.** No "sign in as this customer" button exists,
because that is the feature that gets used at three in the morning and explained
afterwards. If an administrator genuinely has to see inside a tenant, a member
of that tenant invites them the ordinary way — which leaves a record on both
sides that the tenant can see and withdraw.

**Everything an administrator does is logged**, with their identity, in the same
append-only table the tenants' own actions go to. The activity page reads it and
says on the page that nothing there can be edited or removed, including from
there. Administration that leaves no trace is indistinguishable from a breach
afterwards.

**What can be changed is deliberately small.** Suspension stops people signing
in, deletes nothing, and is reversible by the next administrator who disagrees.
An entitlement override is how a promise made in a support conversation becomes
a row somebody can find later rather than a conditional in the code; clearing it
puts the business back on whatever its plan says. A plan's price and name are
editable — its `key` is not, because subscriptions point at it and renaming an
identifier under live rows is how a customer silently loses a feature.

The area lives outside the tenant shell. That shell is built around a company
context, and administration has none; bolting a section onto it would leave an
administrator permanently looking at some tenant's chrome, which is the
confusion that ends with somebody acting on the wrong account.

---

## Security hardening

**One origin check, in one spelling.** It existed in three — a `guardOrigin`
here, a local `guard` there, an inline `isSameOrigin` block elsewhere — which is
how one of them quietly stops being called. There is now `requireSameOrigin()`
for actions that return a result and `assertSameOrigin()` for the handful that
redirect.

Standardising made a coverage test possible, and the coverage test found seven
state-changing actions with no check at all: signing out, signing out
everywhere, verifying an email, resending a verification, switching business,
setting the financial year, and marking notifications read. Switching business
is the one that mattered — it changes which tenant the session points at.
Read-only actions are now listed by name with a reason rather than inferred from
the absence of a call, and a second test fails if one of them starts writing.

**Three tests that read the build rather than the intention.**

- _The client bundle._ Scans everything the browser downloads for the values of
  every secret environment variable, and for connection strings and key
  material. It found no secret — but it did find the entire server environment
  schema, because `publicEnv` lived in the same module and one client component
  importing it dragged the file in. No value was leaking; a map of every
  credential the deployment expects was. `publicEnv` now has its own module and
  `env.ts` finally imports `server-only`, which its own docstring had claimed
  for months.
- _Raw SQL._ No `$queryRawUnsafe`, no string concatenation inside a tagged
  template, and any query touching a tenant-owned table must name `companyId`.
  All pass today; they exist for the query written next year.
- _The origin coverage above._

**A content security policy, in two halves, because one was not possible.** A
nonce is the right way to allow the framework's own inline bootstrap without
allowing every injected script — but a statically prerendered page has its
inline scripts written at build time, and nothing can stamp a per-request nonce
onto them. A nonce policy there does not harden the page, it breaks it, which
the end-to-end run demonstrated by rendering a sign-in page with no working
form.

So the strict policy goes where the data is: `/app`, `/admin` and `/onboarding`
are rendered per request and get `script-src 'self' 'nonce-…'`, fresh every
request. The public pages are static and get `'unsafe-inline'`, which is worth
less and covers no session and no tenant data. `strict-dynamic` is deliberately
absent — it makes the browser ignore `'self'`, and with it nothing loads at all.
Everything else is strict on both: `default-src 'self'`, `connect-src 'self'`
(every outbound call the product makes is made by the server), `object-src
'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`.

One thing is knowingly blocked, and the end-to-end run asserts it is the _only_
thing: the pre-paint script `next-themes` injects. It lives in the root layout,
shared with the static pages, so giving it a nonce would mean making every page
in the product dynamic — a real cost to avoid a flash of the light theme for
dark-mode users. If the layout tree is ever split so the application area has
its own provider, it gets the nonce and the exception goes away.

**Rate limits where money is at stake.** Questions to the assistant are capped
per user per minute: the plan's monthly allowance is a commercial limit, and a
loop spends real money at the provider long before a monthly count notices.
Invitations are capped per company per hour, because they send email to
addresses nobody gave us.

**Cookies.** The session is `__Host-` prefixed, HttpOnly, SameSite=Lax and
Secure wherever the deployment is HTTPS — the browser refuses the prefix
otherwise. The financial-year and sidebar cookies were not marked Secure; they
are now. Neither is sensitive, but one cookie quietly weaker than the rest is
how the habit goes.

---

## Deployment

```bash
docker compose up -d --build
docker compose run --rm app npx prisma migrate deploy
docker compose run --rm app npx tsx --conditions=react-server prisma/seed.ts
```

The image is multi-stage and ends up holding a Node runtime, the standalone
server Next.js emits, the Prisma engine and the migrations — no build tools, no
development dependencies, no source. It runs as an unprivileged user, because a
process that posts other people's accounts should not also be able to rewrite
the filesystem it runs on.

Debian slim rather than Alpine, deliberately. Prisma's query engine is a native
binary and its musl build has been a reliable source of "works locally,
segfaults in the cluster"; thirty megabytes is not worth that class of bug in
something that records financial transactions. The `binaryTargets` line in the
schema is what makes the engine exist inside the image at all — without it the
container starts, serves one page, and fails on the first query.

`.dockerignore` excludes `.env`. That one line is the difference between a
deployment and an incident: the file sits beside the source, holds the database
password and the signing secret, and `COPY . .` would bake it into a layer
anybody who can pull the image can read.

### Two probes, answering different questions

| Endpoint      | Asks                      | On a database outage |
| ------------- | ------------------------- | -------------------- |
| `/api/health` | Is this process running   | still 200            |
| `/api/ready`  | Should it be sent traffic | 503                  |

Conflating them is a common and expensive mistake: a liveness probe that touches
the database restarts every container when Postgres blinks, turning a
recoverable outage into a longer one of the application as well. Both were
tested against a genuinely stopped database, not a mocked one.

Neither says anything beyond the answer — no version, no hostname, no
connection error. A health endpoint is reachable by anybody who can reach the
service, and a connection error quoted back over HTTP names the host, the port,
the database and often the user. The reason goes to the log instead.

Both are excluded from the middleware matcher. A probe hit every few seconds
that runs through the same request pipeline it exists to observe is a probe that
cannot tell you that pipeline is broken.

### Rate limiting across more than one instance

```bash
RATE_LIMIT_DRIVER=redis
REDIS_URL=redis://redis:6379
```

The in-memory driver keeps its counts in one process, so a second replica
silently doubles every limit somebody configured. A production build refuses to
start on it unless `RATE_LIMIT_ALLOW_IN_MEMORY=true` says out loud that this is
a single-instance deployment — that guard existed before the Redis driver did,
and it is why the gap was safe rather than merely undocumented.

**The counter is incremented and given its lifetime in one script.** As two
commands there is a window where the process dies after `INCR` and before
`EXPIRE`, and a counter with no expiry never resets — that identifier is locked
out permanently. One `EVAL`, one round trip, no window. A test hammers the same
key twenty-five times concurrently and asserts the TTL is never `-1`.

**Every check is bounded at one second.** node-redis retries a dead server
indefinitely by default, so `connect()` never rejects — which means the
fallback below was unreachable when it was first written and a sign-in would
have waited forever, which is worse than either failing open or failing closed.
The bound is what makes the fallback reachable at all, and there is a test that
points the limiter at a dead port and asserts it answers quickly.

**If Redis is unreachable the request is allowed, and the failure is made
loud.** That is a deliberate trade. Failing closed would mean a Redis blip locks
every customer out of signing in — a total outage of the product to protect one
control. So the attempt proceeds, an error goes to the log, and
`riai_rate_limit_unavailable_total` goes up. A limiter that has quietly stopped
working is the thing worth preventing, and that counter is what an operator
alerts on.

In CI a missing Redis is a failure rather than a skip. A skipped suite reports
green, which makes "the tests ran" indistinguishable from "the service never
came up" — and exercising a real server was the entire point of declaring one.
Locally it still skips, because not having Redis installed is a fact about the
machine.

The tests run against a real Redis rather than a mock. Everything worth proving
here — that the counter is shared between connections, that it expires, that the
increment and the expiry are atomic — is a property of Redis, and none of them
survives being mocked.

### Backups, and the restore nobody rehearsed

```bash
DATABASE_URL=… BACKUP_DIR=./backups ./scripts/backup.sh
./scripts/restore.sh ./backups/riai-20260814T020000Z.dump "$RESTORE_DATABASE_URL"
```

`docker compose up` runs the first of those nightly into a volume, keeping
fourteen days.

**A `pg_dump` that exits 0 is not a backup.** It is a file. What makes it a
backup is somebody having restored it and found the ledger intact — which is why
the dump is written under a temporary name, read back with `pg_restore --list`,
and only then renamed. `pg_dump` creates its output file _before_ it can fail,
so writing straight to the final name leaves a partial file that looks exactly
like a backup, and a file that looks like a backup is worse than no file at all.

**The restore script refuses a target that does not look like one.**
`pg_restore --clean` drops and recreates every object it touches, and the wrong
URL is one shell-history entry away from the right one. A database whose name
ends in `_test`, `_restore`, `_staging` or `_scratch` is accepted; anything else
needs `RESTORE_I_MEAN_IT=yes`.

**Both scripts strip `?schema=` from the URL.** That parameter is Prisma's, not
libpq's, and `pg_dump` rejects it outright — every `DATABASE_URL` in this
project carries it, so this is the difference between the scripts working for
everybody and working for nobody. It was found by the round-trip test on its
first run, which is rather the point of having one.

The round trip is exercised in CI: back the test database up, restore it into a
scratch one, and count the companies, accounts and journal lines that arrived.

### Metrics, off until somebody turns them on

A third endpoint beside the two probes, answering a third question: not _is it
alive_ or _should it get traffic_ but _what has it been doing_.

```bash
export METRICS_TOKEN=…              # 16 characters or more
curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:3000/api/metrics
```

Unlike the probes it is **off by default**. Health says `ok` and nothing else
precisely so that anybody who can reach the service learns nothing from it;
process counts and database reachability do not meet that bar. Without
`METRICS_TOKEN` the route 404s, and a wrong token gets the same 404 — not a
401, because a 401 confirms there is something behind the door worth guessing
at.

**The counters are per-process.** They live in the memory of one Node process,
reset when it restarts, and two replicas each report their own. That is the same
limitation this document already records for in-memory rate limiting, and the
payload says so in a comment on the first line rather than leaving a scraper to
find out.

**Nothing about a tenant's business appears.** Failures are counted by module
and code, exports by report, documents by kind — never by company, never with a
value. Running the platform does not require reading anybody's books, and a
scrape endpoint is the last place to make an exception to that.

Logs are one JSON object per line: level, message, timestamp and whatever
context the caller attached, on stdout for information and stderr for warnings
and errors — the split every container runtime already routes differently.
Context runs through the same redaction the audit log uses, because a password
reaching a log aggregator is as leaked as one reaching the database, and an
`Error` is unwrapped into name, message and stack rather than stringified, since
`JSON.stringify(new Error("x"))` is `{}` — which is how exceptions quietly
become empty objects in logs.

### What must be set before it will start

The application refuses to boot on a configuration it cannot trust, and says
which line to fix rather than failing on the first request that needs the
missing value. In production it will not accept the placeholder `AUTH_SECRET`
from `.env.example`, will not serve a non-localhost deployment over plain
`http`, and will not use in-memory rate limiting unless the deployment either
provides Redis or states that it runs a single instance — two replicas with
in-memory counters hand an attacker twice the budget, quietly.

Neither the demo tenant nor the development administrator will seed into a
production environment. Both have published passwords; on a live system that is
an incident rather than a convenience.

### What this is not ready for

The rest of this document describes what the product does. This section is the
other half, and it is here because a deployment guide that implies more
readiness than exists is the same kind of dishonesty the rest of the build
avoids.

- **No payment can be taken.** There is a seam for Razorpay and Stripe and no
  integration behind it. Subscriptions work, plan changes that cost nothing
  apply immediately, and an upgrade is declined with the reason.
- **Nothing is filed with any authority.** GST and income tax are prepared for a
  human to review and submit.
- **Backups run, but only to the same machine.** There is a nightly dump, a
  restore script and a test that proves the round trip — and the dump lands in a
  volume beside the database it came from, so it survives a dropped table and
  not a dead disk. For books somebody will need in a tax dispute three years
  from now, use managed Postgres with point-in-time recovery and copy the dumps
  somewhere else.
- **Nothing has been tested behind more than one process.** Rate limiting now
  shares a counter through Redis, which was the structural blocker, but no part
  of this has actually been run as two replicas — and the metrics counters are
  still per-process.
- **Observability stops at logs and a scrape.** Errors are structured JSON and
  there is a token-gated Prometheus endpoint, but there is no tracing, no
  alerting, and the counters are per-process — two replicas each report their
  own, and a restart resets them.
- **The AI features need a provider that has not been paid for.** With none
  configured they say so and answer nothing, which is the intended state rather
  than a broken one.
- **It has never been run at scale.** Every figure in this document comes from a
  test suite and a seeded shop, not from production traffic.

---

## Opening balances

A business migrating onto this platform arrives owing money, being owed it, and
with stock on the shelves. Those positions enter the ledger as **balanced
journal entries**, not as numbers stored next to the master record — otherwise
the trial balance is wrong from day one and every statement built on it inherits
the error.

| Position                  | Entry                                     |
| ------------------------- | ----------------------------------------- |
| Customer owes ₹50,000     | Dr Receivables · Cr Owner's capital       |
| Supplier owed ₹30,000     | Dr Owner's capital · Cr Payables          |
| 40 bags of rice at ₹1,450 | Dr Inventory ₹58,000 · Cr Owner's capital |

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
_and_ a value in the journal, and correcting it properly is a stock adjustment
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

| Phase | Scope                                                             | Status   |
| ----- | ----------------------------------------------------------------- | -------- |
| 1     | Foundation, schema, design system, public site, auth UI           | **Done** |
| 2     | Authentication — sessions, verification, rate limiting, audit     | **Done** |
| 3     | Company onboarding — settings, branches, team, invitations        | **Done** |
| 4     | Application shell — navigation, search, dashboard                 | **Done** |
| 5     | Master data — products, parties, staff, opening balances          | **Done** |
| 6     | Sales — invoicing, GST split, stock issue, void                   | **Done** |
| 7     | Purchases — bills, input tax credit, landed cost, void            | **Done** |
| 8     | Expenses — categories, GST, capital vs revenue, void              | **Done** |
| 9     | Receipts & payments — allocation, ageing, void                    | **Done** |
| 10    | Accounting engine — chart of accounts, balances, the equation     | **Done** |
| 11    | Journal — register, manual entries, reversal                      | **Done** |
| 12    | Ledger — running balance, party statements                        | **Done** |
| 13    | Trial balance — two columns, and what balancing proves            | **Done** |
| 14    | Financial statements — trading, P&L, balance sheet                | **Done** |
| 15    | Inventory — positions, stock cards, reconciliation, counts        | **Done** |
| 16    | GST preparation — GSTR-1 working paper, set-off, reconciled       | **Done** |
| 17    | Income tax — computation, depreciation, 44AD, advance tax         | **Done** |
| 18    | Analytics — trend, products, customers, ratios, health            | **Done** |
| 19    | Forecasting — revenue band, cash commitments, refusals            | **Done** |
| 20    | AI Accountant — read-only tools, traceable answers                | **Done** |
| 21    | AI Auditor — deterministic checks, observations not allegations   | **Done** |
| 22    | AI Business Advisor — detectors, bands, and when to ignore them   | **Done** |
| 23    | Subscriptions — entitlements, allowances, server-side gates       | **Done** |
| 24    | Admin panel — metadata only, no impersonation, logged             | **Done** |
| 25    | Security hardening — CSP, origin coverage, bundle scanning        | **Done** |
| 26    | Testing — a browser suite in the repository, coverage gaps        | **Done** |
| 27    | Deployment — image, compose, probes, pipeline, honest limits      | **Done** |
| 28    | Returns — credit and debit notes, contra accounts, GST reversal   | **Done** |
| 29    | Reports — one catalogue over existing services, CSV and print     | **Done** |
| 30    | Payroll — statutory deductions, four liabilities, no invented TDS | **Done** |
| 31    | Observability — structured logs, a gated scrape, honest scope     | **Done** |
| 32    | Backups — a verified dump, and a restore with a safety catch      | **Done** |
| 33    | Shared rate limits — one counter across instances, bounded wait   | **Done** |
| 34    | Reports about one subject — account ledger, party statements      | **Done** |

---

## Licence

Proprietary. All rights reserved.
