# Database engineering report

> **Change during this work (2026-10-27).** While this phase was in progress,
> another process restructured the repository: the browser prototype moved from
> `app/` to `legacy-demo/`, and a Next.js application tier appeared in `src/`
> with API routes that connect to `lms_dev` and call `api.set_actor()`. That
> tier is not reviewed anywhere in these documents — it was not written here and
> has not been read, so nothing below should be taken as an assessment of it.
> The statement "no application tier exists" describes the state this work was
> carried out against. Two things are visible without reviewing it, and are
> recorded as APP-06 in [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md): its
> connection string names no database user, and `.env.local` points at the
> local socket, so it connects as the invoking operating-system account rather
> than as `lms_app`. On this machine that account is a superuser, which
> bypasses every row-level security policy — the province isolation described
> below would be inert at runtime until the connection uses `lms_app`.


PostgreSQL 16.13. Written 2026-10-27, describing `db/` as it stands.

## Starting point

The repository contained no database. `app/` is a browser-only prototype: 30
screens, records in `localStorage`, no server, no schema, no ORM, no
migrations, no query patterns to inspect. The brief for this phase asked to
"first inspect the existing schema, ORM, migrations, query patterns, and
database version" — there were none of those things, so the schema was derived
from the prototype's own module specifications instead:
`legacy-demo/assets/js/core/spec.js` (fields, validation, computed totals per module),
`legacy-demo/assets/js/core/engine.js` (provinces, roles, workflows, the approval
matrix, unit conversions) and `legacy-demo/assets/js/data/demo.js` (record shapes).

That matters for reading the rest of this report: everything here is new, and
the prototype remains the only user interface. The database does not yet have
an application in front of it.

## What was built

| | Count |
| --- | --- |
| Tables (`lms`) | 89 |
| Tables (`audit`) | 3 |
| Views (`api`) | 22 — 18 `security_invoker`, 4 documented owner-rights exceptions |
| Materialized views | 2 |
| Routines | 63, of which 17 are `SECURITY DEFINER` |
| Triggers | 103, from 23 trigger functions; 4 are deferred constraint triggers |
| Row-level security policies | 65, on 61 tables |
| Indexes | 225 — 35 partial, 3 GIN, 2 GiST |
| Primary keys | 92 |
| Foreign keys | 229 |
| Unique constraints | 48 |
| CHECK constraints | 145 |
| Exclusion constraints | 2 |
| Domains | 11 |
| Generated columns | 22 |
| Migrations | 19 |
| Automated tests | 16 files, 482 assertions |

Reproduce from nothing:

```sh
psql -d postgres -f db/bootstrap/01_roles.sql          # once per cluster, superuser
db/tools/rebuild.sh lms_dev seed                       # migrate + fictional demo data
psql -d lms_dev -f db/bootstrap/03_leakproof.sql       # optional, superuser — see DB-12
python3 db/tools/run_tests.py                          # 16 files, 482 assertions
db/tools/backup.sh verify lms_dev                      # dump, restore, compare
```

---

## 1. Schema

Four schemas, and the split is the access-control design rather than
organisation for its own sake:

| Schema | Holds | Who can reach it |
| --- | --- | --- |
| `lms` | base tables, the system of record | application role, through grants and policies |
| `audit` | audit events, record versions, authentication events | `SELECT` only, for everyone but the triggers |
| `api` | `security_invoker` views and the routines the application may call | the only surface the reporting role has |
| `util` | actor-context helpers | `USAGE`, and `EXECUTE` on two functions |
| `ext` | the four extensions, so an unqualified name cannot resolve to one | — |

### Module coverage

Every module the prototype implements has a schema behind it.

| Module | Tables |
| --- | --- |
| Users, roles, approval groups, organisation | `app_role`, `app_user`, `app_user_group`, `app_user_province`, `approval_group`, `office`, `login_session` |
| Provinces and administrative hierarchy | `province`, `province_level`, `admin_unit`, `admin_unit_path` (materialized) |
| Measurement units | `measurement_unit`, `unit_conversion`, `province_unit` |
| Projects and land | `project`, `project_type`, `project_survey`, `survey`, `land_status` |
| Landowners and ownership | `landowner`, `survey_ownership_share`, `survey_ownership_history` |
| Acquisition and title | `acquisition`, `acquisition_survey`, `acquisition_title_check`, `title_check_item` |
| Compensation cases | `compensation_case`, `case_owner`, `case_lease_line`, `case_crop_line`, `case_tree_line`, `case_misc_line`, `case_document_check`, `case_document_item`, `land_use`, `tree_species` |
| Leases and agreements | `lease`, `lease_lessor`, `lease_survey`, `lease_renewal` |
| ROW corridors | `row_corridor`, `row_survey`, `row_landowner` |
| Payments | `payment_request`, `payment_release`, `payment_receipt`, `payment_allocation`, `payment_hold`, `payment_category`, `idempotency_key` |
| Budgets | `budget` |
| DBPFC (Sindh government land) | `dbpfc_estimate`, `dbpfc_survey`, `dbpfc_rate_history` |
| Workflow | `workflow`, `workflow_stage`, `workflow_step_group`, `workflow_transition`, `workflow_assignment`, `workflow_comment`, `workflow_escalation`, `workflow_matrix_history` |
| Grievances | `grievance`, `grievance_category` |
| Encroachments | `encroachment`, `encroachment_category` |
| Litigation | `legal_case`, `legal_case_landowner`, `legal_case_survey`, `legal_hearing` |
| Mutations and succession | `mutation`, `mutation_survey`, `mutation_heir` |
| Documents | `document`, `document_category`, `document_access_log` |
| Notifications | `notification` |
| Configuration | `system_setting`, `setting_history`, `code_sequence`, `derived_refresh` |
| Audit and versions | `audit.audit_event`, `audit.record_version`, `audit.auth_event` |
| Import and provenance | `import_batch`, `import_row`, `import_validation_error`, `data_provenance`, `migration_reconciliation` |
| Integrations | `integration_endpoint`, `integration_outbox` |
| Reconciliation | `reconciliation_run`, `reconciliation_exception` |

### Numeric types, and why none of them is a float

Money is `numeric(18,2)` through the domain `lms.money_pkr`. A `float8` cannot
represent Rs 0.01 exactly, so a sum of releases would eventually stop
reconciling against the ledger by a few paisa and nobody would be able to say
where it went.

| Domain | Type | For |
| --- | --- | --- |
| `money_pkr`, `money_pkr_pos`, `money_pkr_nonneg` | `numeric(18,2)` | all amounts; up to Rs 10¹⁶, four orders above the largest plausible case |
| `area_acres` | `numeric(14,4)` | land area; 0.0001 acre = 4.36 sq ft, finer than any revenue record, and a 40-ghunta split stays exact |
| `share_pct` | `numeric(7,4)` | ownership and case shares |
| `rate_pkr` | `numeric(18,4)` | per-acre, per-year and per-tree rates |
| `cnic` | `text` + regex | identity number, `00000-0000000-0` |
| `record_code` | `citext` + regex | user-facing codes — see DB-12 |
| `latitude`, `longitude` | `numeric(9,6)` | ~11 cm resolution |

**The application's half of the contract.** Exact types in the database are
only half the job: a client that reads `numeric` into a JavaScript `number`
re-introduces the error it was avoiding. The application tier must use a
decimal type end to end — `BigDecimal`, `decimal.Decimal`, a JS decimal
library — and must not round on the way in. The prototype uses plain JavaScript
numbers throughout and would need this changed.

**Rounding order, fixed and documented** so the application can agree with the
database to the paisa: each line is rounded to two decimals (the crop and tree
line amounts are generated columns that do exactly that), **then** the lines
are summed. Rounding after summing gives a different total.

### Where the invariants live

Most are ordinary constraints. These are the ones that could not be, with the
mechanism and its limitation:

| Invariant | Mechanism | Limitation |
| --- | --- | --- |
| Shares on a parcel ≤ 100% | deferred constraint trigger `ownership_share_total_ck` | Enforced at COMMIT; a long transaction can hold an invalid state meanwhile. Deliberate: a mutation redistributes shares through states that are individually invalid |
| Case payee shares = exactly 100% | deferred constraint trigger | Same |
| Heir shares = exactly 100% | deferred constraint trigger | Same |
| Allocations ≤ voucher net and ≤ case total | deferred constraint trigger, plus a check in the routine for a readable error | Same |
| Lease area ≤ parcel area | row trigger `case_lease_line_area_ck` | Reads the parent; per statement, not deferred |
| Parent unit is one level up, same province | row trigger | Reads another row |
| A project's district is a district | row trigger | Reads another row |
| DBPFC parcels are government land | row trigger | Reads another row |
| Transferor is not their own heir | row trigger | Reads the parent |
| Approved case is immutable | row trigger, with the generated columns excluded from the diff | A privileged session can disable it; detected by `api.reconcile()` |
| Released voucher's amounts immutable | row trigger | Same |
| A stay order blocks payment | trigger maintaining `payment_hold` from `legal_case` | Keeps the two in step so a stay cannot be recorded without blocking payments, nor a decided case leave a stale block |
| One parcel, one approved lease at a time | `EXCLUDE USING gist (survey_id, term_range)` on `lease_survey`, partial on `is_blocking` | Needs `term_range` duplicated from the parent lease; a trigger keeps the copy honest |
| One conversion factor per unit per instant | `EXCLUDE USING gist (unit_code, valid_range)` | — |

Two things are worth singling out as *not* triggers. `compensation_case.total_amount`
is a **stored generated column** — the sum of its four components — so it is
arithmetically impossible for the total to disagree with its parts. Same for
`payment_request.wht_amount` and `.net_amount`: the figure on a cheque is
arithmetic the database performed, not a number a client sent, and an attempt
to write it raises `428C9`.

---

## 2. Routines

63 routines. The full signature list is in the database
(`\df lms.*`, `\df api.*`); what follows is why each group exists.

### Called by the application

| Routine | Purpose | Transaction and failure behaviour |
| --- | --- | --- |
| `api.set_actor(uuid)` | first statement of every transaction; validates the account is known and active | `SET LOCAL`, so it cannot outlive the transaction; raises `28000` on unknown or suspended |
| `api.convert_area(value, from, to, as_of, allow_unconfirmed)` | the only conversion path; reads the versioned factor in force on a date | raises on an unknown unit, a negative value, or an unconfirmed factor without an explicit opt-in |
| `api.acre_ghunta(numeric)` | the Acre-Ghunta display form every Sindh report prints | `IMMUTABLE` — 40 ghunta per acre is a definition, not a configurable factor |
| `api.case_totals(uuid)` / `recalculate_case_totals(uuid)` | compute, and persist, a case's totals from its lines | the second locks the case `FOR UPDATE` and refuses a locked one |
| `api.case_settlement(uuid)` | allocated and released for one case; index-backed, usable in a `LATERAL` | read-only |
| `api.case_liability(uuid)` | the full liability picture for one case | read-only |
| `api.budget_status(uuid, int)` | approved, released, committed, balance, utilisation | returns `approved_amount` NULL when no budget exists — "no budget control", not "no budget left" |
| `api.ownership_share_total`, `validate_ownership_shares`, `validate_survey_area` | callable checks, so a screen can warn before a save rather than failing at COMMIT | read-only; under 100% is a warning, over is an error |
| `api.advance_workflow(workflow, record, to_stage, note, as_group)` | the one way a record changes stage | locks the record, checks province, role, the matrix, segregation of duties and the entity guard; writes the transition, the assignment hand-off and the audit event; raises on refusal with the message the user should see |
| `api.request_payment(...)` | raise a voucher, idempotently | the key is inserted first; a retry of a success returns the same voucher, a retry of a failure proceeds normally because the failed transaction took the key with it |
| `api.release_payment(payment, key, date, note)` | the one place money leaves | three independent defences against a double payment: the stage check, the explicit release lookup, and `UNIQUE (payment_id)` — which is the one that holds when two transactions interleave |
| `api.allocate_payment(...)` | apply a payment to a case | checks both ceilings with the voucher locked |
| `api.apply_mutation(uuid)` | move the shares on final approval | called only by `advance_workflow`; `EXECUTE` is deliberately not granted to the application |
| `api.reconcile(scope, ref, as_of)` | seven integrity checks, recorded as findings | writes no financial record — ever |
| `api.validate_import_batch` / `promote_import_batch` | two-phase import | a batch with unresolved errors cannot be promoted; promotion requires Admin or Approver |
| `api.set_setting(key, value, note)` | the only way configuration changes | requires an Admin actor; the reason is handed to the history trigger through a transaction-local parameter, because the history table is append-only and cannot be annotated afterwards |
| `api.refresh_derived(object)` | refresh the materialized views `CONCURRENTLY` | must run outside a transaction block; reports per-object success or failure rather than abandoning the rest |
| `api.report_compensation_summary`, `report_payment_register`, `report_landowner_statement`, `report_approval_turnaround` | parameterised report datasets | `STABLE`, invoker-rights, so row-level security applies; the application never assembles SQL |
| `api.mask_cnic(text)` | keeps the district prefix and check digit, hides the middle | `IMMUTABLE` |

`api.report_approval_turnaround` reports the median and 90th percentile as well
as the mean, because one stalled case drags a mean and leaves the median alone,
and the difference between them is the useful signal.

### `SECURITY DEFINER`: 17 routines

`SECURITY INVOKER` is the default and the majority. The 17 definer routines
exist for one of two reasons, and each is listed with its justification in
[DATABASE_SECURITY_REVIEW.md](DATABASE_SECURITY_REVIEW.md) §3:

- **A policy cannot query the table it protects.** `lms.actor_provinces()`,
  `actor_role()`, `actor_groups()`, `api.set_actor()`.
- **The application must get an effect without the privilege.** Every routine
  that writes the audit trail, the release ledger, the workflow decisions or
  the ownership history — which the application holds no `INSERT` on, so that
  a release cannot exist without its evidence.

Every one of them: pins `search_path = pg_catalog, pg_temp`;
schema-qualifies every reference; re-checks province access, because definer
rights bypass row-level security; and is granted `EXECUTE` individually, never
to `PUBLIC`. `db/tests/test_10_roles_grants.sql` asserts the first and the last
across the whole schema; `test_06_rls_scope.sql` asserts the province re-check
on the four that matter most.

One piece of dynamic SQL builds an identifier: `lms.next_code_year()` creates a
sequence for a new year. The stem must already be registered in
`lms.code_sequence`, which the application cannot write to, and the derived
name still goes through `format(%I)`.

### Deliberately not in the database

Rendering, authentication, session handling, notification delivery, document
storage and the HTTP layer. The boundary is: **the database owns invariants and
the record of what happened; the application owns presentation and workflow
ergonomics.** Approval *rules* are in the database because they decide whether
money moves; approval *screens* are not.

---

## 3. Triggers

103 triggers from 23 functions. Every one is deterministic, narrowly scoped,
and covered by a test. No trigger writes to a table that has a trigger writing
back to it, so none can recurse — `tg_lease_propagate` writes `lease_survey`,
whose own trigger fires only on `lease_id` and writes nothing back to `lease`.

| Function | Attached to | Does |
| --- | --- | --- |
| `tg_stamp_created`, `tg_touch_version` | 17 versioned tables | stamp created/updated from the actor context, bump `version`, and pin `created_at`/`created_by` so an update cannot rewrite who created a record |
| `audit.tg_audit_row` | 31 tables | one audit event per real change, with the field-level diff; refuses an unattributed write; writes nothing when nothing changed |
| `audit.tg_record_version` | 7 record types | full row snapshot per version |
| `tg_append_only` | 8 tables | refuses `UPDATE` and `DELETE` on the audit tables and the ledgers |
| `tg_case_locked`, `tg_case_child_locked` | `compensation_case` + its 5 line tables | an approved or cancelled case and its lines are read-only |
| `tg_payment_locked` | `payment_request` | a released voucher's money is fixed; remarks may still be annotated |
| `tg_ownership_share_total`, `tg_case_owner_share_total`, `tg_mutation_heir_share_total`, `tg_allocation_limits` | 4 tables | the deferred total rules |
| `tg_admin_unit_parent`, `tg_project_district`, `tg_case_lease_line_area`, `tg_dbpfc_survey_class`, `tg_mutation_heir_not_transferor` | 5 tables | cross-row checks a CHECK cannot make |
| `tg_lease_survey_range`, `tg_lease_propagate` | `lease_survey`, `lease` | keep the exclusion constraint's date range honest |
| `tg_dbpfc_rate_history`, `tg_setting_history` | 2 tables | record every rate and configuration change |
| `tg_legal_case_stay` | `legal_case` | place and lift payment holds from the litigation register |
| `tg_mark_derived_stale` | `admin_unit` | record that a materialized view needs refreshing — it cannot refresh one itself |

### Two subtleties worth recording, because both were bugs first

**A `BEFORE DELETE` trigger must return `OLD`.** `tg_case_locked` originally
returned `NEW` on its allow path. In a `BEFORE DELETE` trigger `NEW` is NULL,
and returning NULL means *cancel this delete* — silently. The row survived and
the caller saw a successful `DELETE` of zero rows. Caught by
`test_01_constraints.sql` asserting that deleting a draft case cascades to its
lines.

**A `BEFORE` trigger sees NULL in every stored generated column.** PostgreSQL
computes them after the `BEFORE` triggers run, so a naive `to_jsonb(OLD)`
versus `to_jsonb(NEW)` diff reports every generated column as changed. The
locking triggers were therefore refusing an update that touched nothing but a
remarks field. `util.generated_columns(oid)` excludes them. `AFTER` triggers do
not have this problem, which is why the audit trigger never needed it.

### Migrations, maintenance and administrative corrections

The brief asks how these interact with the triggers, and the answer is a
system service account with a fixed, documented id
(`00000000-0000-0000-0000-000000000001`), seeded in migration 0002 — before
any audit trigger exists, which is how the chicken-and-egg is resolved.

- **Migrations** set `lms.actor_id` to it, so reference-data changes are
  attributed and `db_role` records that they arrived as `lms_owner`.
- **Maintenance jobs** do the same.
- **Administrative corrections** to a locked record are a deliberate
  privileged act: disable the specific trigger, make the change, re-enable it.
  The change is still audited, because the audit trigger is a different trigger
  and stays on. `test_15_maintenance.sql` performs exactly this and asserts
  that the audit row names only the corrected field.
- The service account has no password and **cannot be given one** — a CHECK
  constraint refuses it — so nothing can sign in as it.

### Bulk loads

The deferred triggers are evaluated per row at COMMIT, so a bulk import works.
`test_13_deferred_constraints.sql` inserts 50 parcels with 100 holdings in one
transaction and forces the check. The volume fixture loads 120,000 payments
with the audit triggers disabled and the audit rows generated in bulk, which is
the documented approach for a fixture and not for production.

---

## 4. Views

22 views, 18 of them `security_invoker`.

**Why `security_invoker` matters.** A view normally reads its base tables with
the privileges and the row-level security context of the **view's owner**.
These views are owned by `lms_owner`, which owns the tables and therefore
bypasses their policies — so a plain view would hand every caller every
province's rows no matter what the policies said. The underlying tables being
restricted would not save it: the view would be the way around the
restriction. PostgreSQL 15 introduced `security_invoker`; this deployment is
16.13. `test_05_views_rls.sql` asserts from `pg_class.reloptions` that nothing
outside the four documented exceptions is missing it.

| View | For |
| --- | --- |
| `v_admin_unit_path` | full "District → Taluka → Deh" paths |
| `v_survey_ownership` | parcels with share totals, apportionment state and committed area |
| `v_landowner_summary` | holdings, owned area weighted by share, active leases, paid to date, hold state |
| `v_project_land_status` | the project register: parcels, area, cases, approved compensation, released |
| `v_lease_register`, `v_lease_expiry_alert` | the lease register with the 180/90/60/30-day expiry bands |
| `v_row_renewal_schedule` | ROW corridors with the next yearly anniversary and open violations |
| `v_case_status` | the case list with days at stage and which queue is waiting |
| `v_approval_bottleneck` | open queues by workflow, stage, position and province, with how long the oldest has waited |
| `v_payment_release` | the payment register |
| `v_outstanding_liability` | approved compensation not yet paid — what the company owes landowners today |
| `v_reconciliation_exception`, `v_budget_utilisation`, `v_dbpfc_summary` | reconciliation findings, budget position, DBPFC estimates |
| `v_grievance_status`, `v_encroachment_status` | operational registers with age and overdue state |
| `v_audit_trail`, `v_record_version_history` | the trail with a field-level diff, and version history with validity ranges |
| `v_province_summary` | province-wise KPIs, live |
| `v_case_settlement` | per-case allocated and released, as one aggregate |

### The four owner-rights exceptions

Each bypasses row-level security and restates the province predicate in its own
body. Recorded as DB-05.

| View | Why it cannot be `security_invoker` |
| --- | --- |
| `v_landowner_summary_masked` | masking a CNIC requires reading it, which requires the caller to hold `SELECT` on it — at which point the mask is decorative |
| `v_payment_release_masked` | same |
| `v_province_summary_cached` | reads a materialized view, which cannot carry row-level security |
| `v_admin_unit_path` | same |

The control holding them to the policies: `test_05_views_rls.sql` asserts each
returns exactly the same row set as its policy-governed equivalent for the same
actor, and that a differently-scoped actor sees only its own province. The four
are named explicitly in that test, so a fifth cannot appear unnoticed.

### Materialized views: two, both measured first

Used only where a measurement justified them.

| Materialized view | Why | Freshness | Refresh |
| --- | --- | --- | --- |
| `lms.admin_unit_path` | the recursion cost is paid per query; the source is master data that changes in months, not minutes. Measured: it removed the recursion from every location lookup | `max_staleness` 1 day; display only, so staleness cannot affect a payment or an approval | `api.refresh_derived()`, `CONCURRENTLY`, so readers are never blocked |
| `lms.province_summary` | the live dashboard runs 16 aggregate subqueries over every large table, four provinces at a time: **1,078 ms** measured. The cached version is **0.08 ms** | `max_staleness` 15 minutes; nobody decides on a province-level count that cannot be a quarter of an hour old | same |

`CONCURRENTLY` requires a unique index, which both have. It cannot run inside a
transaction, so a trigger cannot refresh one — `tg_mark_derived_stale` records
that a refresh is needed in `lms.derived_refresh` and a maintenance job acts
on it. `api.v_province_summary_cached` reports its own age and whether that age
is past the agreed limit, so a screen can say "as at 09:45" or "figures are
stale" rather than presenting old numbers as current.

---

## 5. Indexes and query plans

225 indexes; 35 partial, 3 GIN, 2 GiST. The full evidence, with every plan
before and after, is in [QUERY_PLAN_EVIDENCE.md](QUERY_PLAN_EVIDENCE.md).

**Method.** Build the schema at migration 0018 — before the performance
indexes — load a volume fixture, measure 16 queries with
`EXPLAIN (ANALYZE, BUFFERS)` as the application role with row-level security in
force, apply migration 0019, measure again. The index set was chosen from the
first set of plans. Each query runs three times and the fastest execution is
reported, so a cold first read does not dominate.

**Volume** (`db/tools/perf_load.sql`, roughly a decade at the scale the
client's documents describe): 60,013 parcels, 50,010 landowners, 120,012
holdings, 30,000 cases, 120,000 vouchers, 84,000 releases, 20,000 leases,
126,000 workflow transitions, 296,152 audit events. **368 MB**, with 168 MB of
indexes after 0019.

### Headline measurements

| Query | Before | After | Change |
| --- | --- | --- | --- |
| Landowner name search | 11,289 ms | 175 ms | **64× faster** |
| Compensation summary report | 12,640 ms | 222 ms | **57× faster** |
| Outstanding liability register | 9,842 ms | 465 ms | **21× faster** |
| Case list by stage | 635 ms | 4.4 ms | **145× faster** |
| Payment history for a landowner | 12.3 ms | 0.23 ms | **54× faster** |
| Project register | 2,357 ms | 671 ms | **3.5× faster** |
| Province dashboard (live) | 1,078 ms | 937 ms | no material change |
| Province dashboard (cached) | — | 0.08 ms | new in 0019 |
| Parcel lookup by code | 173 ms | 0.75 ms | **223× faster**, but only with the cluster step below |

### What the measurements actually taught

**Three of the worst queries were not index problems.** They called
`api.case_liability()` once per row through a `LATERAL` — 30,000 function
calls, two aggregates each, to report 100 rows. An index would have hidden
that. They are rewritten to aggregate with the index instead, and that is where
most of the improvement came from. The first rewrite joined a whole-table
aggregate, which was better but still computed 30,000 settlements to report
100; the second uses `LATERAL` so only the surviving rows are computed. Both
intermediate states were measured.

**The dashboard genuinely needed a materialized view.** It did not improve with
indexes — it asks sixteen questions of every large table, and that is the work,
not the access path. 1,078 ms to 0.08 ms, at the cost of fifteen minutes of
staleness, on the one screen that tolerates staleness best.

**A `citext` domain made every code lookup a sequential scan.** Under
row-level security PostgreSQL will not evaluate a user's `WHERE` clause before
the security policy unless the operator is `LEAKPROOF`, and `citext_eq` is not
(while `texteq` and `uuid_eq` are). So the unique index on a code column was
unusable. `SELECT id FROM lms.survey WHERE code = '…'` was a sequential scan
discarding 60,012 rows in 207 ms; with citext's operators marked leakproof it
is an index scan in 1.7 ms. This is a consequence of a choice made in this
phase and it was found by measuring, not by reasoning.
`db/bootstrap/03_leakproof.sql` offers the fix as a superuser decision with its
own reasoning and residual risk; DB-12 records the decision and the
conservative alternative.

### Index rationale

Deliberately **not** indexed:

- `province_code` alone. Four provinces, so the policy predicate selects a
  quarter of any table and a sequential scan is correct. Province appears only
  as the leading column of composites whose later columns are selective.
- The small reference tables. A sequential scan of 16 rows beats an index, and
  the planner knows it.
- Foreign keys nothing joins on. Every primary key and unique constraint
  already has an index; the foreign keys indexed are the ones a measured query
  uses.

Chosen with reasons:

| Kind | Where | Why |
| --- | --- | --- |
| GIN trigram | `landowner.full_name`, `.father_name` | an unanchored `ILIKE` cannot use a B-tree. GIN over GiST because this is a read-mostly register where search speed matters more than index size |
| GIN `jsonb_path_ops` | `audit_event.new_data` | only `@>` is used; path_ops is markedly smaller and faster for it, at the price of not supporting `?`, which nothing asks |
| GiST | the two exclusion constraints | overlap is not expressible as a unique key |
| Partial (35) | the "work in progress" indexes: open assignments, pending payments, unresolved grievances, live encroachments, approved unterminated leases, stay orders | each stays proportional to the live register rather than to its history. `lease_expiry_idx` is the clearest: a growing table, a shrinking slice |
| Composite, province-first | case, payment, survey and grievance lists | the policy restricts province in every query whether the application asked or not, so it belongs first; the selective column follows |
| Reverse-direction | `payment_allocation(case_id)`, `survey_ownership_share(landowner_id)`, `case_lease_line(survey_id)` | a B-tree cannot be read from its second column, so a composite unique constraint answers one direction only |

The report also lists every index no measured query used, because an unused
index costs storage and write time and the list is worth reading before adding
more.

**Caveat.** Measured on a developer workstation, not a production-like server.
Absolute timings are indicative; the ratios and the plan shapes are what
transfer.

---

## 6. Transactions and concurrency

| Control | Mechanism |
| --- | --- |
| Atomic business operations | `api.advance_workflow` and `api.release_payment` write the state change, the ledger row, the workflow decision, the audit event and the outbox message in the caller's transaction — all or none |
| Row locking | `FOR UPDATE` before every financial decision, so two approvers clicking at once serialise rather than both recording an approval |
| Optimistic concurrency | `version` bumped by trigger; the application writes `WHERE id = ? AND version = ?` and reports a conflict on zero rows. The trigger cannot enforce the application's `WHERE` clause, so the contract is documented and tested |
| Idempotency | `lms.idempotency_key`, unique, with a request hash so a key reused with a changed amount is refused rather than returning the first result |
| Duplicate prevention | unique constraints and partial unique indexes, not pre-insert checks |
| Deadlocks | detected and reported as `deadlock detected`, so a client can retry; bounded retry is the application's job |
| Rounding and units | one rounding order, documented; one conversion routine reading one versioned table |
| Reconciliation | reports mismatches; rewrites nothing |

Isolation is PostgreSQL's default, Read Committed, with explicit row locks
where it matters. Serializable was considered and not adopted: the financial
paths take the row lock they need, and serialization failures would add retry
complexity for no additional guarantee here.

`test_07_concurrency.py` runs five scenarios with two real concurrent
sessions. The most important: with the triggers disabled and the privileges of
the schema owner, a second release row is **still** refused by
`payment_release_payment_id_key`. The no-double-payment guarantee does not
depend on reaching the routine.

---

## 7. Migrations

19 migrations, forward-only, one transaction each, SHA-256 recorded in
`lms_meta.schema_migration`.

| | |
| --- | --- |
| 0001 | schemas, extensions, domains, actor context |
| 0002 | reference data and organisation, the four roles, the system service account |
| 0003 | projects, parcels, landowners, ownership |
| 0004 | workflow definitions, stages, the approval matrix |
| 0005 | acquisitions, compensation cases, leases, ROW |
| 0006 | payments, releases, holds, reconciliation, budgets, DBPFC |
| 0007 | grievances, encroachments, litigation, mutations |
| 0008 | audit, versions, documents, notifications, sessions |
| 0009 | import, provenance, migration reconciliation, integrations |
| 0010 | core routines: actor, codes, unit conversion, case totals |
| 0011 | workflow transitions and the per-workflow guards |
| 0012 | budgets, liabilities, payment lifecycle, allocations, reconciliation, mutations |
| 0013 | triggers |
| 0014 | views |
| 0015 | reference data: provinces, levels, units, workflows, settings, code sequences |
| 0016 | row-level security |
| 0017 | grants and the masked reporting views |
| 0018 | import validation and report datasets |
| 0019 | indexes, the query-shape rewrites, the two materialized views |

**Rollback.** There are no down migrations, and that is a decision rather than
an omission. A down migration that drops a column is a data-loss operation
dressed as a safety feature, and the one for a backfill cannot be written at
all. Recovery is forward: write a new migration that corrects the previous one,
or restore from backup and replay. For a change that cannot be corrected
forward — a dropped column — the procedure is restore-and-replay, which is why
the restore path is verified rather than assumed.

**Tested** by `test_16_migration.py` (24 assertions): every migration applies
to a clean database; a second run is a no-op; migrations load reference data
and no demo data; applying in two halves **with data written in between**
reaches a schema fingerprint identical to a single pass — columns, constraints,
indexes, triggers, policies, views and routine signatures all compared;
editing an applied migration is refused as drift; and a failing migration
commits nothing and can be fixed and re-run.

**Changes needing a backfill, a lock or a rewrite.** None so far. The
procedure, for when one arrives: add the column nullable, backfill in batches
outside the migration, then add the constraint `NOT VALID` and `VALIDATE` it
separately — so no statement holds a long exclusive lock. The runner's
one-transaction-per-migration rule means a batched backfill does not belong in
a migration at all; it belongs in a script the migration's comment points to.

**Seed data.** `db/seed/seed_demo.sql` and `seed_demo_transactions.sql`. Every
record is fictional and labelled so at the top of each file. Never loaded by a
migration; both refuse to run over existing data. The second deliberately goes
through the `api` routines — walking a compensation case through six different
people, because strict segregation of duties makes fewer impossible — so
loading the seed is itself a smoke test of the workflow layer.

**Migration reconciliation.** `lms.migration_reconciliation` records
source-versus-target counts and totals per entity for a legacy load, with
`reconciled` as a generated column, so a sign-off cannot contradict the numbers
beside it. No legacy load has been performed.

---

## 8. Import pipeline

Two phases: rows land in `lms.import_row` as `jsonb` and are validated there;
only a batch that validates clean may be promoted. A 4,000-row spreadsheet with
six bad CNICs produces six exceptions naming the line and the rule, not a
half-loaded register.

Implemented for landowners and parcels — the two registers the client's
spreadsheets actually hold (`requirments/CSV Datasets.zip`). An unsupported
entity is reported as such rather than passing validation silently.

Normalisation is recorded, not just applied: `raw` and `normalised` sit side by
side, so a reviewer can see what the import changed about their data. Checks
include CNIC format and punctuation repair, duplicates against the register
*and* within the same file, unknown provinces and administrative units, numeric
and positive areas, and units with no conversion factor. An unconfirmed
conversion factor and a missing IBAN are warnings, not errors: the row loads
and the figure is flagged. Re-uploading an identical file is refused by a
partial unique index on the content hash. Every promoted record gets a
`lms.data_provenance` row naming the file and the line.

`test_12_import.sql`, 47 assertions, covers all of it.

---

## 9. Backup and recovery

`db/tools/backup.sh` has three commands; the third is the one that matters.
`verify` dumps, restores into a scratch database, and compares **row counts per
table, the financial totals, the set of cheque numbers, the audit span, the
schema and the migration history**.

**Run, and it passes:**

```
RESTORE VERIFIED: row counts, financial totals, cheque numbers,
audit span, schema and migration history all match.
```

The first run **failed**, and that is the argument for verifying rather than
assuming: a single-database dump does not carry database-level settings, so
the `search_path` that migration 0001 sets was lost on restore. Re-applying it
is now a documented step of the restore procedure, and the fingerprint is taken
with a pinned `search_path` so the comparison is about the schema rather than
about how constraint definitions happen to render.

Format is `pg_dump -Fc` (compressed, selectively and parallel restorable), with
`pg_dumpall --globals-only` alongside, because roles are cluster-wide and a
database dump does not contain them. `--no-owner` is deliberately **not** used:
object ownership is part of the security design, and a restore that reassigned
it would quietly disable row-level security.

**RPO and RTO are proposed targets, not validated figures.**

| | Proposed | Basis |
| --- | --- | --- |
| RPO | 24 hours with daily dumps; 5 minutes with WAL archiving | arithmetic, not measurement. WAL archiving is not configured |
| RTO | 1 hour for a database of this size | the demo restore takes seconds on 736 KB; nothing of production size has been restored |

Neither has been validated by a recovery exercise against a real environment,
and they should not be quoted as commitments until one has been done. Missing
entirely: encryption of the dumps, off-site copies, retention enforcement,
point-in-time recovery. DB-07.

**Retention and archival.** `lms.document_category.retention_years` holds a
period per class — title documents, agreements and court documents
indefinitely, because a land title has no expiry; identity and bank documents
10 years, because holding them longer than needed is itself a risk;
correspondence 7. `retention.audit_years` is 10. **None of it is enforced**:
there is no archival job, and the periods are recorded intent.

---

## 10. Verification

`python3 db/tools/run_tests.py` — 16 files, **482 assertions**, against a
database rebuilt from the migrations. Every file is listed in
[DATABASE_SECURITY_REVIEW.md](DATABASE_SECURITY_REVIEW.md) with what it covers.

| File | Covers | Assertions |
| --- | --- | --- |
| `test_01_constraints` | keys, CHECKs, uniques, the exclusion constraints, deletion policies, generated columns | 30 |
| `test_02_routines` | unit conversion, Acre-Ghunta, case totals, share and area validation, budget, liability, reports | 52 |
| `test_03_triggers` | audit capture, versioning, append-only, locking, derived data, rollback | 48 |
| `test_04_financial` | duplicate payment, double release, idempotency, allocation limits, holds, budget | 31 |
| `test_05_views_rls` | view security, province scoping through every view, masking | 36 |
| `test_06_rls_scope` | base-table scoping, definer re-checks, self-privilege, per-person tables | 31 |
| `test_07_concurrency` | two real sessions: double release, the constraint without the routine, optimistic concurrency, duplicate race, deadlock | 15 |
| `test_08_audit_immutability` | what the application cannot write, alter or remove; no DDL | 33 |
| `test_09_identity_context` | actor required, suspended accounts, Viewer read-only, no leakage across pooled transactions | 14 |
| `test_10_roles_grants` | the whole privilege model, read from the catalogue | 61 |
| `test_11_mutation` | shares move, history written, guards refuse | 24 |
| `test_12_import` | validation, duplicates, exceptions, promotion, provenance | 47 |
| `test_13_deferred_constraints` | why deferred, and a 50-parcel bulk load | 17 |
| `test_14_reconciliation` | reports and changes nothing; catches a tampered total | 5 |
| `test_15_maintenance` | migration and maintenance attribution; the administrative-correction procedure; the limit of append-only | 14 |
| `test_16_migration` | clean, incremental, drift, failure | 24 |

The majority of assertions are negative — a test that asserts something is
*refused*. A control is only demonstrated by what it refuses.

**Three bugs the suite caught during development**, named because they are the
kind a functional test would not find: the `BEFORE DELETE` trigger returning
`NEW` and silently cancelling deletes; the locking triggers seeing every
generated column as changed and refusing valid updates; and
`lms.next_code_year` being invoker-rights, so the first record of a new year
would have failed for the application role with a permission error. A fourth,
found by measurement rather than by test: the `citext` index problem in DB-12.

---

## 11. Unresolved risks

Full detail in [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md). The ones that bear
on the database:

| ID | Risk | Severity | State |
| --- | --- | --- | --- |
| APP-01 | No application tier exists — no authentication, authorisation, sessions, headers or rate limiting | Critical | Open |
| DB-01 | Definer routines bypass row-level security by design | High | Mitigated; no automatic check on a future routine |
| DB-02 | Audit immutability stops at the schema owner | High | Mitigated; needs an append-only store outside the database |
| DB-03 | TLS not enforced | High | Open — infrastructure |
| DB-07 | Backups unencrypted, no off-site copy, no retention enforcement, no PITR | High | Open — infrastructure |
| DB-04 | Actor attribution trusts the application | Medium | Accepted — awaiting a named signature |
| DB-05 | Four owner-rights views restate the province predicate | Medium | Mitigated by row-set comparison tests |
| DB-06 | Polymorphic record references with no foreign key | Medium | Mitigated by routine-level enforcement |
| DB-08 | Document bytes depend on an object store that does not exist | Medium | Open |
| DB-09 | Privileged database activity is not monitored | Medium | Open |
| DB-12 | `citext` makes code lookups unindexable under RLS | Medium | Mitigated by an optional cluster step; decision pending |
| DB-10 | Two conversion factors unconfirmed | Low | Mitigated — the routine refuses them |
| DB-11 | Thirds leave a 0.0001% rounding residue | Low | Accepted |

## 12. What is not done

Stated plainly, because a report that only lists what was built is misleading.

1. **The application tier.** Everything in V2, V3 and V13 of the ASVS, and
   most of the SOC 2 common criteria, waits on it.
2. **Infrastructure.** TLS, encryption at rest, a secret store, object storage,
   log collection, monitoring, alerting, connection pooling and resource
   limits. None is configurable from a schema.
3. **A validated recovery exercise.** The procedure is tested; nothing of
   production size has been restored, and the RPO and RTO remain proposals.
4. **Retention enforcement.** The periods are recorded; no job applies them.
5. **Scheduled execution of the controls that already exist.** The test suite,
   `api.reconcile()` and `backup.sh verify` all produce exactly the evidence a
   SOC 2 Type II examination wants — and none of them runs on a schedule, so
   none of it is operating evidence yet. This is the cheapest remaining
   improvement by a wide margin.
6. **Access-control failure logging.** A refused cross-province read raises but
   records nothing. `audit.audit_event.action` already permits `'DENY'`;
   nothing writes it.
7. **A consistency check for polymorphic orphans.** One query per entity would
   detect them; it is not written.
8. **A lint for definer routines without a province check.** Would close DB-01
   properly; it is not written.
