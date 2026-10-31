# Database security review

PostgreSQL 16.13. Reviewed 2026-10-27 against the schema in `db/migrations/`
as applied to a database built from scratch by `db/tools/migrate.py`, with the
test suite in `db/tests/` as the evidence.

Each control below states what it is for, where it is implemented, how it was
tested, what the test found, and what it does **not** cover. A control with no
test is marked as such rather than listed as implemented.

Reproduce everything here with:

```sh
psql -d postgres -f db/bootstrap/01_roles.sql      # once per cluster, as superuser
db/tools/rebuild.sh lms_dev seed
python3 db/tools/run_tests.py
```

---

## 1. Role separation and least privilege

**Objective.** No session holds more privilege than its job needs, and the
application in particular cannot alter the schema, the audit trail, the money
ledger or the reference data that governs its own behaviour.

**Implementation.** `db/bootstrap/01_roles.sql`, `db/migrations/0017_grants.sql`.

| Role | Login | Owns | Holds |
| --- | --- | --- | --- |
| `lms_owner` | **no** | every object | everything, but no session can be it except by `SET ROLE` from `lms_migrator` |
| `lms_migrator` | yes | nothing | member of `lms_owner`; migrations `SET ROLE` to it |
| `lms_app` | yes | nothing | `SELECT/INSERT/UPDATE` on transactional tables, `SELECT` on reference data, `EXECUTE` on named routines |
| `lms_report` | yes | nothing | `SELECT` on views and on base tables with sensitive columns withheld |
| `lms_test` | yes | nothing | same as `lms_app`, plus the test fixtures; never created in production |

Not granted to the application, deliberately:

- `DELETE` on any core record — a case is cancelled, a document withdrawn, a
  payment stopped. `DELETE` exists only on the child rows of a draft (lease
  lines, payees, linked parcels, import staging), where removing a row *is*
  editing.
- Any privilege on `audit.audit_event`, `audit.record_version`,
  `audit.auth_event` beyond `SELECT` — `INSERT`, `UPDATE`, `DELETE` and
  `TRUNCATE` are all revoked explicitly rather than merely absent, so a later
  blanket `GRANT` cannot restore them unnoticed.
- Any privilege beyond `SELECT` on `lms.payment_release`,
  `lms.workflow_transition`, `lms.survey_ownership_history`,
  `lms.setting_history`, `lms.dbpfc_rate_history`, `lms.idempotency_key`,
  `lms.integration_outbox`.
- Any write on a reference table. The application cannot redefine a workflow,
  reassign an approval step, change a conversion factor or change the
  withholding rate.
- `USAGE` on `lms.cheque_no_seq`. Only `api.release_payment()` may draw a
  cheque number.
- `EXECUTE` on `api.apply_mutation()`. Ownership moves as a consequence of an
  approval, never as an operation of its own.
- `TEMP` on the database — `REVOKE ALL ON DATABASE … FROM PUBLIC` in
  `db/bootstrap/02_database.sql`, then only `CONNECT` granted back.

**Test.** `db/tests/test_10_roles_grants.sql`, 61 assertions, read from
`pg_roles`, `has_table_privilege`, `has_column_privilege`,
`has_function_privilege`, `has_sequence_privilege` and `pg_proc` — the
catalogue, not the migration.

**Result.** Pass. Including: no LMS role is a superuser, has `CREATEDB`,
`CREATEROLE` or `BYPASSRLS`; `lms_owner` cannot log in; every object in
`lms`, `api`, `audit` and `util` is owned by `lms_owner`; `PUBLIC` can read
nothing and execute nothing.

**Not covered.** Operating-system access to the data directory, `pg_hba.conf`,
and anything about the cluster rather than the database. Emergency
administrative access is documented below but not technically enforced.

---

## 2. Row-level security and province isolation

**Objective.** An account reaches only the provinces listed for it, whatever
query it writes and whatever the application forgot to scope.

**Implementation.** `db/migrations/0016_rls.sql`. Policies on 24
province-bearing tables, 28 child tables scoped through their parent, the audit
tables, and the per-person tables (`notification`, `login_session`, `app_user`
and its mappings). `lms.actor_provinces()` is the single predicate; with no
actor it returns an empty array, so the default is deny.

**Test.** `db/tests/test_06_rls_scope.sql` (31 assertions) and
`db/tests/test_05_views_rls.sql` (30 assertions).

**Result.** Pass. Specifically:

- With no actor, `lms.survey`, `lms.compensation_case` and `lms.landowner`
  return zero rows.
- A Sindh account sees no other province's parcels, landowners, payments,
  projects or administrative units; sees no Balochistan case even by
  primary-key lookup; and sees a Balochistan case's payees as zero rows even
  though `lms.case_owner` has no province column of its own.
- A Sindh account cannot insert a Punjab landowner (`42501`).
- The Sindh and Balochistan case sets are disjoint, compared as sets rather
  than as counts.
- Every `api` view except the three in DB-05 is `security_invoker`, asserted
  from `pg_class.reloptions` rather than assumed.
- An ordinary account sees one row in `lms.app_user` — its own — and cannot
  promote itself to Admin or grant itself another province (`42501` on both).
- Internal Audit sees more than one province's audit entries; a field officer
  sees exactly one.

**Not covered.** The policies admit an Admin to all four provinces. That is
deliberate — the role administers all four and every Admin action is audited —
but it means an Admin credential is a whole-system credential.

---

## 3. `SECURITY DEFINER` routines

**Objective.** Give the application the effect of a privileged operation
without the privilege, without creating a way around row-level security.

**Implementation.** Eleven definer routines. Every one: pins
`search_path = pg_catalog, pg_temp`; schema-qualifies every reference; takes
typed parameters; re-checks province access because definer rights bypass the
policies; and is granted `EXECUTE` individually.

| Routine | Why definer | Writes the application cannot |
| --- | --- | --- |
| `api.set_actor` | must read `lms.app_user` to validate the account | — |
| `lms.actor_provinces` / `actor_role` / `actor_groups` | a policy cannot query a table the policy protects | — |
| `api.advance_workflow` | an approval must come with its evidence | `workflow_transition`, `audit_event`, `workflow_assignment` |
| `api.request_payment` | retry safety | `idempotency_key`, `workflow_transition` |
| `api.release_payment` | the release and its evidence are one transaction | `payment_release`, `audit_event`, `workflow_transition`, `integration_outbox`, `cheque_no_seq` |
| `api.allocate_payment` | province re-check with the voucher locked | — |
| `api.apply_mutation` | a transfer must come with its history | `survey_ownership_history` |
| `api.reconcile` | writes findings | `reconciliation_*` |
| `api.validate_import_batch` / `promote_import_batch` | batch locking and provenance | `data_provenance` |
| `api.set_setting` | checks the actor is an Admin, which a grant cannot | `system_setting` |
| `api.refresh_derived` | only the owner may refresh a materialized view | — |
| `lms.next_code_year` | the first record of a year creates that year's sequence (DDL) | — |
| `audit.tg_audit_row` / `tg_record_version` | the trail must not be the application's to write | `audit.*` |

**Test.** `db/tests/test_10_roles_grants.sql` asserts that no routine in these
schemas lacks a pinned `search_path` and that none is executable by `PUBLIC`.
`db/tests/test_06_rls_scope.sql` asserts the province re-check in
`advance_workflow`, `request_payment`, `release_payment` and
`allocate_payment` with known out-of-scope records.

**Result.** Pass.

**Not covered.** A future definer routine added without a province check would
not be caught by anything automatic. See DB-01.

---

## 4. Audit and immutability

**Objective.** Every change to a protected record is recorded with who, when,
what changed and from what; and the record of it cannot be altered by the
application.

**Implementation.** `audit.tg_audit_row` on 31 tables, writing before and after
values plus the changed-field list; `audit.record_version` snapshots for the
seven record types whose past state gets asked about; `audit.tg_append_only` on
eight tables; the grants in section 1; `audit.audit_event.db_role` recording
which database role each change arrived as; `txid` grouping the rows of one
business transaction.

Actor attribution is required: a write with no actor context raises rather than
producing an anonymous audit row.

**Test.** `db/tests/test_03_triggers.sql` (48 assertions) and
`db/tests/test_08_audit_immutability.sql` (33 assertions).

**Result.** Pass.

- An update writes exactly one audit event, naming the table, the operation,
  the actor, the actor's role at the time, the record, the province, the
  changed field and both values.
- An update that changes nothing writes nothing.
- An update cannot rewrite `created_by`.
- The application cannot insert, update, delete or truncate an audit event, a
  version snapshot or an authentication event (`42501` on each).
- Nor create, alter or delete a payment release, fabricate a workflow decision,
  write ownership history, clear an idempotency key or rewrite a rate history.
- A trigger failure rolls back the audit rows written earlier in the same
  transaction, so the trail never records half an operation.

**Honest limit, and it is demonstrated rather than described.**
`db/tests/test_15_maintenance.sql` disables the append-only trigger as
`lms_owner`, deletes an audit row, and re-enables it — and asserts that it
worked. The guarantee is: tamper-evident against the application,
**not** tamper-proof against a database administrator. Closing it needs an
append-only destination outside this database. DB-02.

---

## 5. Financial integrity

**Objective.** Money cannot be paid twice, cannot be paid against an
unapproved case, cannot exceed what was approved, and cannot be altered after
it has moved.

**Implementation and test.**

| Control | Mechanism | Test |
| --- | --- | --- |
| One release per voucher | `UNIQUE (payment_id)` on `lms.payment_release` | `test_04`, and `test_07` with two concurrent sessions |
| Cheque numbers never reused | `UNIQUE (cheque_no)` + sequence the app cannot reach | `test_04`, `test_10` |
| No duplicate live voucher | partial unique index on payee, category, period, case, lease | `test_04`, and `test_07` with two concurrent first-time requests |
| Retry cannot pay twice | `lms.idempotency_key`, unique, with a request hash | `test_04` |
| Payment only against an approved case | checked in `api.request_payment` | `test_04` |
| Allocations within the voucher and within the case | checked in the routine, enforced by deferred trigger | `test_04`, `test_13` |
| Stay order blocks payment | `lms.payment_hold`, maintained by trigger from the litigation register | `test_03`, `test_04` |
| Budget check before verification | `lms.wf_guard_payments` | `test_02` (position), `test_04` |
| Released voucher immutable | `lms.tg_payment_locked` | `test_03` |
| Approved case immutable | `lms.tg_case_locked` and the same on its five line tables | `test_03` |
| Exact decimal arithmetic | `numeric` domains throughout; amounts are generated columns | `test_02`, `test_04` |

**Concurrency result** (`db/tests/test_07_concurrency.py`, 15 assertions, real
concurrent sessions):

- Two simultaneous releases: the first succeeds, the second fails with
  "already been released", and exactly one release row exists.
- With the triggers disabled and the privileges of the schema owner, a second
  release row is still refused by `payment_release_payment_id_key`. The
  guarantee does not depend on reaching the routine.
- Optimistic concurrency: two sessions that both read version N and write back
  `WHERE version = N` — the second updates zero rows and detects the conflict;
  the first write survives; the version advances by exactly one.
- Two concurrent first-time duplicate requests: exactly one succeeds, the
  other is refused by the duplicate-payment index.
- A deadlock is detected and reported as `deadlock detected`, so a client can
  retry it, rather than hanging.

**Reconciliation** (`db/tests/test_14_reconciliation.sql`): `api.reconcile()`
runs seven checks and writes findings only. The test disables a trigger, tampers
with an approved case total the way only a privileged session could, and
asserts that the run reports it as a `case_total_vs_lines` exception — and that
the routine rewrote no financial record.

---

## 6. Negative testing summary

A control is only demonstrated by something it refuses. Across the suite, 400+
assertions, the following are attempted and expected to fail:

- reading another province's records, by query, by view, by report routine and
  by primary key;
- writing a record into another province;
- a user promoting itself, or granting itself a province;
- releasing a payment twice, concurrently and serially;
- raising a duplicate voucher, concurrently and serially;
- reusing an idempotency key for a different payment, or with a changed amount;
- allocating more than the voucher net, or more than the case total;
- paying against an unapproved case, or a held payee;
- editing or deleting an approved case, its lines, or a released voucher;
- inserting, updating, deleting or truncating any audit table;
- fabricating a workflow decision, a release, or ownership history;
- changing a conversion factor, a workflow stage, an approval step or the
  withholding rate;
- `CREATE`, `ALTER`, `DROP`, `DISABLE TRIGGER`, `CREATE SCHEMA` as the
  application;
- writing with no actor context;
- acting as a suspended or unknown account;
- a Viewer advancing a workflow or raising a payment;
- an unconfirmed unit conversion without an explicit opt-in;
- a malformed CNIC, IBAN, coordinate pair, MIME type or oversized upload;
- a parcel in the wrong province, a unit under the wrong parent, a project
  whose "district" is not a district;
- a second lease over the same parcel for an overlapping period;
- ownership over 100%, case shares not 100%, heir shares not 100%;
- a transferor listed among their own heirs;
- promoting an import batch with unresolved errors, or twice, or as a
  data-entry account;
- loading the same import file twice.

---

## 7. Ownership, grants and privilege review

**Ownership.** `lms_owner` owns every schema, table, view, sequence, routine
and materialized view. Asserted in `test_10`.

**Emergency administrative access.** There is no break-glass account in the
schema. Administrative correction of a locked record requires a superuser or
`lms_owner` session, which in practice means the cluster superuser doing
`SET ROLE lms_owner`. `db/tests/test_15_maintenance.sql` documents the
procedure as a test: disable the specific trigger, make the change, re-enable
it — and the change is still audited, because the audit trigger is a different
trigger and stays on.

What is missing around that: the superuser credential is the cluster's and is
not managed by anything here; there is no approval workflow in front of it and
no alert when it is used. DB-09.

**Privilege review.** `test_10` is the review, and it runs on every test run.
There is no scheduled human review, because there is no deployment to review.

---

## 8. Connection security and pooling

**TLS.** Not enforced in this environment. DB-03, with the required
configuration stated there.

**Pooling.** The actor context is transaction-local (`SET LOCAL`), which is the
property a pool depends on. `db/tests/test_09_identity_context.sql` proves it
with two consecutive transactions on the same connection, after a commit and
after a rollback: the actor is gone, the province scope is empty, and a query
returns zero rows. A session-level `SET` would have left one user's identity
attached to the next user's request.

**Resource limits.** Not configured. A deployment needs `max_connections`, a
pooler, `statement_timeout` and `idle_in_transaction_session_timeout` —
particularly the last, since the locking triggers hold row locks for the
length of a transaction.

---

## 9. Migrations and schema change

Forward-only, one transaction each, checksummed. `db/tests/test_16_migration.py`
(24 assertions) asserts: every migration applies to a clean database; a second
run is a no-op; migrations load reference data and no demo data; applying in
two halves with data written in between reaches a schema fingerprint identical
to a single pass; editing an applied migration is refused as drift; and a
failing migration commits nothing and can be fixed and re-run.

---

## 10. Backup and recovery

`db/tools/backup.sh verify` dumps, restores into a scratch database, and
compares row counts, financial totals, the set of cheque numbers, the audit
span, the schema and the migration history. It has been run and it passes; the
output is in `docs/DATABASE_ENGINEERING_REPORT.md`.

The verification found a real difference on its first run — the
database-level `search_path` is not carried by a single-database dump — which
is now re-applied as a documented step of the restore procedure. That is the
point of verifying rather than assuming.

Not covered: encryption of the dump, off-site copies, retention enforcement,
point-in-time recovery. DB-07.

---

## 11. Monitoring

Not implemented. No audit logging of DDL, no alerting on privileged
connections, no detection of bulk reads. DB-09, dependent on APP-05.

---

## Summary

| Area | State |
| --- | --- |
| Role separation and least privilege | Implemented and tested |
| Row-level province isolation | Implemented and tested |
| Definer-routine containment | Implemented and tested; residual risk DB-01 |
| Audit capture | Implemented and tested |
| Audit immutability | Implemented against the application; limit demonstrated (DB-02) |
| Financial integrity | Implemented and tested, including under concurrency |
| Negative testing | Extensive |
| Migrations | Implemented and tested |
| Backup and restore | Procedure tested; protection and PITR absent (DB-07) |
| TLS, monitoring, secret management | Not implemented — infrastructure dependencies |
| Application-layer security | Does not exist (APP-01) |
