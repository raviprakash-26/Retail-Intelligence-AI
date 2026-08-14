# Contributing

Conventions this codebase depends on. They exist because this is a financial
system: a mistake here is not a rendering glitch, it is a wrong number on
somebody's balance sheet.

## Before every commit

```bash
npm run verify   # typecheck → lint → tests
```

## Non-negotiables

### Money

- Never use `number` arithmetic for a monetary value. Use `@/lib/money`.
- Never compare amounts with `===`. Use `equals()` or `compare()`.
- Never store money as `Float` or `Double`. `Decimal(18,4)`, always.
- `toNumber()` exists for charts and statistics only. Never round-trip a value
  through it on the way back to the database.

### Accounting

- Business modules do not write to `journal_entries` or `journal_lines`. They
  call `postJournalEntry()`, which is the only entry point to the ledger.
- Never compute a financial statement figure by summing source documents. Derive
  it from journal lines.
- Never mutate a posted document. Reverse it or void it, with a reason.
- Any operation touching more than one table runs inside a `$transaction`.

### Multi-tenancy

- Every tenant-owned model carries `companyId`.
- Every unique constraint on a tenant-owned model is composite with `companyId`.
- `companyId` comes from the session. It never comes from a request parameter,
  a form field, or a URL segment.
- Never filter by tenant in a React component. Scope the query.

### Authorization

- Check permissions, not roles: `can("sales.void")`, not
  `role === "accountant"`.
- Every protected operation is checked on the server. Hiding a button is
  presentation; it is not enforcement.
- A new capability means a new permission key in `@/lib/rbac/permissions`, added
  to the role templates that should hold it. The seed is idempotent — re-run it.

### AI

- The AI never calculates a financial figure. It reads results that application
  code computed.
- The AI never writes to a financial record.
- Send the minimum data needed to answer the question, scoped to one tenant.
- Every financial answer cites its period, its figures and its source.

### Honesty in the product

- Anything estimated is labelled "Estimated".
- Anything prepared for filing is labelled "Prepared for review". The product
  does not claim to have filed anything.
- Audit findings describe anomalies and risks. They never assert that fraud
  occurred.
- Forecasts are ranges with stated limitations, not point predictions.
- Never ship a form that fakes a successful submit. If the backend is not there
  yet, say so on screen.

## Adding a migration

```bash
npm run db:migrate -- --name descriptive_name
```

Constraints Prisma cannot express — check constraints, triggers, partial
indexes — go in a hand-written migration. Explain in a comment what each one
prevents and why it belongs in the database rather than only in code.

Never edit an applied migration. Add a new one.

## Code style

- TypeScript `strict`. `any` is a lint error.
- Small, focused functions. Explicit return types on anything exported.
- Comments explain _why_, not _what_. If a line needs a comment to say what it
  does, rename something instead.
- Reuse the existing component before writing a new one.

## Tests

- Accounting rules, tax arithmetic and permission boundaries need unit tests.
- Anything that touches the database needs an integration test.
- Test the boundary and the failure, not just the happy path. A test that only
  proves a correct entry is accepted has not tested the constraint.
