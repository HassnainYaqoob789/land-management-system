# The LMS database

PostgreSQL 16, the authoritative system of record. The `app/` prototype in the
parent directory still keeps its data in the browser; nothing connects the two
yet, because there is no application tier between them. See
[../docs/security/SECURITY_ARCHITECTURE.md](../docs/security/SECURITY_ARCHITECTURE.md) for where
that leaves the system.

## Set up from nothing

```sh
# 1. Cluster roles. Once per cluster, as a superuser.
psql -d postgres -f db/bootstrap/01_roles.sql

# 2. A database, owned by lms_owner.
psql -d postgres -v db=lms_dev -f db/bootstrap/02_database.sql

# 3. The schema.
LMS_DSN="postgresql:///lms_dev?user=lms_migrator" db/tools/migrate.py up

# 4. Optional, as a superuser: makes record-code lookups use their index
#    under row-level security. Read the file first — it asks you to accept a
#    small, stated risk. See DB-12 in ../docs/SECURITY_FINDINGS.md.
psql -d lms_dev -f db/bootstrap/03_leakproof.sql
```

Or, for development, all of that plus fictional demo data in one step:

```sh
db/tools/rebuild.sh lms_dev seed
```

Then:

```sh
python3 db/tools/run_tests.py        # 23 files, ~690 assertions (Windows: set PGCLIENTENCODING=UTF8 and PYTHONUTF8=1)
db/tools/backup.sh verify lms_dev    # dump, restore into a scratch db, compare
```

## Layout

```
db/
  bootstrap/      cluster-level steps a superuser runs once
    01_roles.sql        the five roles and the two group roles
    02_database.sql     CREATE DATABASE, owned by lms_owner
    03_leakproof.sql    optional; see DB-12
  migrations/     0001 … 0019, forward-only, one transaction each, checksummed
  seed/           fictional demo data — never loaded by a migration
  tests/          16 files; _helpers.sql has the assertion functions
  tools/
    migrate.py          up / status / verify
    rebuild.sh          drop, migrate, seed, refresh
    run_tests.py        the suite
    backup.sh           dump / restore / verify
    perf.py             build a volume fixture, measure plans, write the report
    perf_load.sql       the volume fixture
```

Standard library only, everywhere — the tools shell out to `psql` rather than
needing a driver installed, which matches the convention `legacy-demo/serve.py`
already set.

## How the application is expected to use it

Connect as `lms_app`. Then, in every transaction:

```sql
BEGIN;
SELECT api.set_actor('<the authenticated user's app_user.id>');
-- … the request's work …
COMMIT;
```

`api.set_actor` uses `SET LOCAL`, so the identity is discarded when the
transaction ends and a pooled connection cannot carry it into the next
request. **Without it nothing is visible and no write succeeds** — row-level
security returns no rows and the audit trigger refuses an unattributed change.
That is the intended failure mode: a forgotten `set_actor` fails loudly rather
than silently writing anonymous records.

Read through the `api` views. Write through the `api` routines for anything
privileged — advancing a workflow, raising or releasing a payment, allocating
one, applying a mutation, changing a setting. The application holds no
privilege to do those things directly, which is deliberate: a release cannot
exist without its audit event and its workflow decision, because the same
routine writes all three in one transaction.

### Optimistic concurrency

`version` is bumped by a trigger on every update. The application's half of the
contract is to write:

```sql
UPDATE lms.landowner SET … WHERE id = $1 AND version = $2;
```

Zero rows affected means somebody else edited it first — report a conflict,
do not retry blindly. The trigger cannot enforce the `WHERE` clause, so this is
a contract rather than a guarantee; `tests/test_07_concurrency.py` demonstrates
what happens when both sides keep it.

### Decimal arithmetic

Every amount is `numeric`. A client that reads one into a JavaScript `number`
undoes the point of that, so the application tier must use a decimal type end
to end. Rounding order is fixed: round each line to the paisa, then sum. See
the engineering report.

### Idempotency

`api.request_payment` and `api.release_payment` take an idempotency key. Supply
a stable one per logical operation — not per attempt — and a retried request
returns the first result instead of paying twice. A key reused with a different
payload is refused rather than quietly returning the wrong answer.

### Maintenance

```sql
SELECT * FROM api.refresh_derived();   -- outside a transaction block
SELECT api.reconcile('all');           -- writes findings, changes nothing
```

`lms.derived_refresh` says which materialized views are stale and how stale
they are allowed to get. `api.reconcile()` is only useful if somebody reads
`api.v_reconciliation_exception` afterwards: it deliberately repairs nothing,
because silently rewriting financial history is how an error stops being
auditable.

## Reading the schema

Start with the migrations in order — they are written to be read, and the
reasoning for each decision is in the comments beside it rather than in a
separate document. `0001` sets up the numeric contract, `0016` is the whole
province-scoping design, `0017` is the privilege model, `0019` explains which
indexes exist and why the ones that do not were rejected.

Then:

- [../docs/DATABASE_ENGINEERING_REPORT.md](../docs/DATABASE_ENGINEERING_REPORT.md)
  — the inventory, the reasoning, and what is not done
- [../docs/QUERY_PLAN_EVIDENCE.md](../docs/QUERY_PLAN_EVIDENCE.md)
  — every plan before and after, generated from measurements
- [../docs/DATABASE_SECURITY_REVIEW.md](../docs/DATABASE_SECURITY_REVIEW.md)
  — each control with its test and its limit
- [../docs/SECURITY_FINDINGS.md](../docs/SECURITY_FINDINGS.md)
  — the open risks, including the ones created by this phase

## A warning about the demo data

Every record in `seed/` is invented. The password verifiers are deliberately
values that no password produces, so a seeded account cannot be signed in to —
a seed file with a working credential is how a demo password reaches
production. Both seed files refuse to run over existing data.
