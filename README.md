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

**The intelligence layer comes next.** Sales and purchase _returns_ are still to
come as well. Every module that is not built says so on
its own page rather than showing an empty screen, and no figure anywhere in the
product is invented to fill a gap.

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
    settlements/           Receipt/payment form, allocation table, ageing panel
    inventory/             Stock list, stock card, count correction
    gst/                   GST working paper: GSTR-1 tables, set-off, reconciliation
    tax/                   Income tax working paper: computation, blocks, 44AD
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
    expenses/              Expense posting: categories, capital vs revenue
    settlements/           Receipts and payments: allocation, ageing, void
    inventory/             Positions, movements, reconciliation, adjustments
    gst/                   GST working paper, periods, register reconciliation
    tax/                   Income tax computation, disallowances found in records
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
npm run test          # 823 tests: unit + integration
npm run test:unit     # unit only, no database required
```

Integration tests run against `riai_test` and refuse to start if
`DATABASE_URL` does not name a `_test` database.

Coverage includes the accounting rules, GST arithmetic, inventory valuation,
income tax slabs and reliefs, depreciation blocks under the Act, ageing and
allocation, account balances and the accounting equation, permission
boundaries (an auditor cannot write; a cashier
cannot void), tenant isolation, document numbering under rollback, and every
database constraint listed above.

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
| 9     | Receipts & payments — allocation, ageing, void                | **Done** |
| 10    | Accounting engine — chart of accounts, balances, the equation | **Done** |
| 11    | Journal — register, manual entries, reversal                  | **Done** |
| 12    | Ledger — running balance, party statements                    | **Done** |
| 13    | Trial balance — two columns, and what balancing proves        | **Done** |
| 14    | Financial statements — trading, P&L, balance sheet            | **Done** |
| 15    | Inventory — positions, stock cards, reconciliation, counts    | **Done** |
| 16    | GST preparation — GSTR-1 working paper, set-off, reconciled   | **Done** |
| 17    | Income tax — computation, depreciation, 44AD, advance tax     | **Done** |
| 18    | Analytics                                                     | Next     |
| 19    | Forecasting                                                   |          |
| 20–22 | AI Accountant, Auditor, Advisor                               |          |
| 23–24 | Subscriptions and admin panel                                 |          |
| 25–27 | Security hardening, testing, deployment                       |          |

---

## Licence

Proprietary. All rights reserved.
