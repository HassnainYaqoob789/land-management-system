# Security architecture

> **Change during this work (2026-10-27).** While this phase was in progress,
> another process restructured the repository: the browser prototype moved from
> `app/` to `legacy-demo/`, and a Next.js application tier appeared in `src/`
> with API routes that connect to `lms_dev` and call `api.set_actor()`. That
> tier is not reviewed anywhere in these documents — it was not written here and
> has not been read, so nothing below should be taken as an assessment of it.
> The statement "no application tier exists" describes the state this work was
> carried out against. Two things are visible without reviewing it, and are
> recorded as APP-06 in [SECURITY_FINDINGS.md](../SECURITY_FINDINGS.md): its
> connection string names no database user, and `.env.local` points at the
> local socket, so it connects as the invoking operating-system account rather
> than as `lms_app`. On this machine that account is a superuser, which
> bypasses every row-level security policy — the province isolation described
> below would be inert at runtime until the connection uses `lms_app`.


## What this system is, as of this phase

The Land Management System has two parts in this repository, and the gap
between them is the most important thing on this page.

**`app/` — a browser-only prototype.** Thirty screens, no server. Records live
in the browser's `localStorage`; the session lives in `sessionStorage`. Roles,
province scope and workflow rights are decided in JavaScript. It was built to
demonstrate the domain before award, and it does that well. It is not a
security architecture: every rule in it can be bypassed by anyone willing to
open the developer console.

**`db/` — a PostgreSQL database, added in this phase.** The authoritative
system of record, with the schema, the financial invariants, the workflow
rules, row-level province scoping, least-privilege roles and an audit trail.
Built so that the rules hold *below* the application rather than inside it.

**What is missing: the application tier.** There is no server, no API, no
authentication, no session management, no security headers, no rate limiting.
Everything the OWASP ASVS asks of an application is therefore absent, and is
recorded as APP-01 in [SECURITY_FINDINGS.md](../SECURITY_FINDINGS.md). This
document describes the database layer honestly and does not claim the rest.

```
                     ┌──────────────────────────────────────────┐
  browser            │  app/  (prototype, localStorage)         │
                     │  roles and scope enforced in JavaScript  │
                     └──────────────────────────────────────────┘
                                      ╎
                      ╎ THE TIER THAT DOES NOT EXIST YET ╎
                      ╎ authentication · sessions · input       ╎
                      ╎ validation · headers · rate limiting    ╎
                                      ╎
   ┌───────────────────────────────────▼──────────────────────────────────┐
   │ PostgreSQL 16                                                        │
   │                                                                      │
   │  api     security_invoker views · routines the app is allowed to call│
   │  ─────────────────────────────────────────────────────────────────── │
   │  lms     base tables · constraints · triggers · row-level security   │
   │  audit   append-only events, versions, authentication events         │
   │  util    actor context helpers                                       │
   │                                                                      │
   │  roles   lms_owner (owns all, cannot log in)                         │
   │          lms_migrator → DDL   lms_app → DML   lms_report → SELECT    │
   └──────────────────────────────────────────────────────────────────────┘
```

## The design principle

Every control in the database is placed so that it holds when the layer above
it is wrong. That is not a general preference; it is a response to what this
system does. It moves money to individual landowners against approvals, and it
records who owns land. A bug in a web controller that lets a payment be
released twice is a payment made twice.

So the rules that matter are not conventions or application checks. They are:

| Rule | Where it lives | Why not in the application |
| --- | --- | --- |
| A payment is released at most once | `UNIQUE (payment_id)` on `lms.payment_release` | An application check reads, decides, then writes; two requests can both pass the read |
| No duplicate live voucher for a payee, category and period | partial unique index `payment_no_duplicate_live_uq` | The prototype did this with a JavaScript `find()` before inserting — the same race |
| One landowner per CNIC | `UNIQUE` on `lms.landowner.cnic` | Same race |
| A cheque number is never reused | `lms.cheque_no_seq`, which the application has no privilege on | A counter column can be rolled back and reissued |
| Ownership shares never exceed 100% of a parcel | deferred constraint trigger | Spans rows; must hold on the transaction's result, not each statement |
| Case payee shares total exactly 100% | deferred constraint trigger | Same |
| A parcel is not under two approved leases at once | `EXCLUDE USING gist` on `lms.lease_survey` | Overlap is not expressible as a unique key |
| An approved case cannot be edited | `lms.tg_case_locked` plus the same on its line tables | The figure a payment was released against must not move |
| An audit row cannot be altered | grants, plus a `BEFORE UPDATE OR DELETE` trigger | An application that can edit the trail has no trail |
| A retry cannot pay twice | `lms.idempotency_key`, unique | A timeout is indistinguishable from a failure at the client |
| An account sees only its provinces | row-level security on every province-bearing table | `scope.js` is a usability feature, not a boundary |

[DATABASE_SECURITY_REVIEW.md](../DATABASE_SECURITY_REVIEW.md) covers each of these
with its test. [DATABASE_ENGINEERING_REPORT.md](../DATABASE_ENGINEERING_REPORT.md)
is the full inventory.

## Trust boundaries

**Between the database and everything else.** The database trusts the
application for exactly one thing: the identity of the end user, supplied as
`lms.actor_id` at the start of each transaction. It trusts it for nothing else
— not the amount on a cheque (generated), not the total of a case (generated),
not whether an approval happened (written only by a routine the application
cannot bypass), not which province a row belongs to (checked by policy on read
and on write).

That one piece of trust is DB-04. It is mitigated by the fact that the setting
is transaction-local, so a pooled connection cannot carry one request's
identity into the next, and that a write with no actor is refused rather than
recorded anonymously. It is not eliminated.

**Between roles inside the database.** Four roles, and the separation between
them is load-bearing rather than decorative:

- `lms_owner` owns every object and **cannot log in**. No ordinary session
  holds the rights to drop a table, disable a trigger or bypass a policy.
- `lms_migrator` can log in and is a member of `lms_owner`; every migration
  does `SET ROLE lms_owner` so migrated objects belong to the owner, not to
  the migrating account.
- `lms_app` is the runtime. No DDL, no table ownership, no `BYPASSRLS`, no
  `TEMP` on the database, and no privilege at all on the audit tables, the
  release ledger, the workflow decisions, the ownership history or any
  reference table.
- `lms_report` holds `SELECT` on the views and on base tables with the
  sensitive columns withheld at column level: no CNIC, no IBAN, no bank
  details, no address, no password verifier, no session token.

`db/tests/test_10_roles_grants.sql` asserts all of this against the catalogue
rather than against the migration that was supposed to produce it, so a grant
restored by a later blanket `GRANT` would fail the test.

**Why the application has so few privileges.** It gets the *effect* of
releasing a payment through `api.release_payment()`, a `SECURITY DEFINER`
routine that writes the release, the audit event, the workflow transition and
the integration outbox in one transaction. It cannot get that effect any other
way, because it holds no `INSERT` on any of those tables. A bug, or an attacker
with the application's credentials, cannot record a release without its
evidence, or evidence without its release.

The cost is DB-01: those routines bypass row-level security, so each re-checks
province access itself, and the tests assert that each one does.

## Province scope

An account sees the provinces listed for it in `lms.app_user_province`. That is
enforced in one place, as policy, on:

- every table carrying `province_code` (24 tables, migration 0016);
- every child table, through its parent (28 more, generated from one mapping so
  the policies cannot drift apart);
- the audit trail, with one exception: Internal Audit sees all provinces,
  because a province-limited trail would make their review incomplete;
- notifications, sessions and user rows, which are scoped to the individual.

With no actor set, `lms.actor_provinces()` returns an empty array and nothing
is visible. The default is deny, not allow.

The views are `security_invoker`, which PostgreSQL 15 introduced and this
deployment (16.13) supports. Without it a view reads its base tables as the
view's owner — `lms_owner`, which bypasses the policies — and every view would
hand every caller every province's rows regardless of what the policies said.
Three views cannot use it, for reasons in DB-05, and restate the predicate
themselves.

## Data classification

| Class | What | Where | Controls |
| --- | --- | --- | --- |
| Personal, sensitive | CNIC, IBAN, bank branch, address, phone | `lms.landowner`, `lms.payment_receipt` | Province policy; column-level `SELECT` withheld from `lms_report`; masked views for reporting; read access to documents logged |
| Financial | case totals, vouchers, releases, allocations, budgets | `lms.compensation_case`, `lms.payment_*`, `lms.budget` | Generated amounts; append-only release ledger; no `DELETE` for the application; reconciliation |
| Legal | litigation, stay orders, hearings | `lms.legal_case`, `lms.legal_hearing` | Province policy; a stay order automatically blocks payment |
| Authentication | password verifiers, session token hashes | `lms.app_user`, `lms.login_session` | Hash-format CHECK; no plaintext; token stored only as SHA-256; withheld from `lms_report` |
| Audit | events, versions, authentication attempts | `audit.*` | Append-only; no application write privilege; actor required |
| Reference | provinces, units, workflows, settings | `lms.province`, `lms.unit_conversion`, `lms.workflow*`, `lms.system_setting` | Read-only to the application; changed by migration or by `api.set_setting()`, which checks the actor is an Admin; every change recorded |
| Geography | administrative unit names | `lms.admin_unit` | Public information; the only data in a materialized view |

## Secrets

Nothing in the schema stores a credential. `lms.integration_endpoint.secret_ref`
holds the *name* of a secret in the deployment's secret store, never a secret.
`db/bootstrap/01_roles.sql` creates the login roles with no passwords and says
where credentials belong. The session token is stored only as a SHA-256, so a
database dump cannot be replayed as a live session.

Database connection strings are the deployment's concern and are not in this
repository. DB-03 records that TLS is not enforced in this environment.

## Input handling at the database layer

The database is not a substitute for application input validation, and this
section is not a claim that it is. What it does contribute:

- **Domains**, so the numeric and format contract is in one place rather than
  repeated on forty columns: `lms.cnic` (NADRA format), `lms.money_pkr`
  (`numeric(18,2)`, never float), `lms.area_acres`, `lms.share_pct`,
  `lms.record_code`, `lms.latitude`, `lms.longitude`.
- **Allowlists rather than denylists** where a value is enumerable: the
  document MIME types, the payment modes, the workflow stages (a foreign key
  into `lms.workflow_stage`, so a stage that does not belong to that workflow
  is unrepresentable).
- **No dynamic SQL built from caller input.** The two places that build an
  identifier read it from a table the application cannot write to and still
  pass it through `format(%I)`.
- **Parameterised report routines** instead of the application assembling SQL:
  `api.report_compensation_summary`, `api.report_payment_register`,
  `api.report_landowner_statement`, `api.report_approval_turnaround`.

## Change management

Schema changes go through `db/migrations/`, forward-only, one transaction each,
recorded with a SHA-256. Editing an applied migration is reported as drift and
refused — `db/tests/test_16_migration.py` asserts that, and also asserts that a
failing migration commits nothing and that applying in two halves reaches a
byte-identical schema to applying in one.

Configuration changes go through `api.set_setting()`, which requires an Admin
actor and records the before value, the after value, who and why in
`lms.setting_history` (append-only). Approval-matrix changes are recorded in
`lms.workflow_matrix_history`.

## What is tested, and what that means

`db/tools/run_tests.py` runs 16 files, 400-odd assertions, against a database
rebuilt from the migrations. The suite includes negative tests throughout — a
test that asserts a thing is *refused* is the only kind that proves a control
exists. Cross-province denial, double release, duplicate payment, audit
tampering, privilege escalation, DDL by the application, identity leaking
between pooled transactions: each is attempted and each is expected to fail.

Three of the bugs this suite caught during development are worth naming,
because they are the kind that a passing functional test would not have found:
a `BEFORE DELETE` trigger returning `NEW` (silently cancelling the delete), a
locking trigger that saw every generated column as changed (refusing valid
updates), and a year-code routine the application role could not actually call.

What the suite does not and cannot show: that the application is secure (there
is none), that the controls operate over time (see
[SOC2_READINESS.md](../compliance/SOC2_READINESS.md)), or that anyone outside this work has
reviewed it.
