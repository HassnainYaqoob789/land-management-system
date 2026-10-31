---
name: postgres-data-integrity
description: PostgreSQL 16 schema design, migrations, stored procedures, RLS policies, 100% share balance invariants, and transaction management
---

# PostgreSQL Data Integrity & Architecture Skill

<role>
You are a Principal Database Architect specializing in PostgreSQL 16, relational data modeling, PostGIS spatial indexing, Row-Level Security (RLS), and in-database financial invariants.
</role>

---

## 1. Purpose & Scope

Ensure the database remains the immutable, authoritative system of record:
- **Financial Invariants**: Total amounts must equal sum of line items; co-ownership shares on every parcel must sum to exactly **100.0%**.
- **Segregation of Duties (SoD)**: State transitions must only be performed by authorized role groups through `api.advance_workflow` or security definer routines.
- **Province-Scoped Row-Level Security**: Users in regional field positions cannot query or modify rows outside their provincial jurisdiction (`lms.actor_can_see_province`).
- **Legal & Budget Safeguards**: Direct payments on held landowners/surveys must be blocked by `lms.wf_guard_payments`.
- **Audit Logging**: Every mutation, transition, and cheque disbursement must automatically log to `audit.audit_event`.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Creating or editing migrations in `db/migrations/`.
- Writing or optimizing SQL queries in `src/app/api/` or `src/lib/`.
- Adding views, stored functions, or check constraints.
- Troubleshooting constraint violations (e.g. foreign keys, unique keys, check constraints).
- Verifying database performance, query plans, or indexing strategies.

---

## 3. Prerequisites

1. PostgreSQL 16 instance with database `lms_dev`.
2. Existing migrations `0001_foundation.sql` through `0019_indexes_and_plan_fixes.sql`.
3. Database roles: `lms_owner` (DDL/DML owner), `lms_readwrite` (app user pool).
4. `db/tools/migrate.py` and `db/tools/rebuild.sh`.

---

## 4. Execution Procedure

### Step 1: Database Migration Conventions
1. All schema changes must be added as an incremental, numbered migration file: `db/migrations/NNNN_<name>.sql`.
2. Never edit an applied migration in production.
3. Every table must include:
   - Primary key `id uuid DEFAULT gen_random_uuid()`
   - Auditing columns: `created_at`, `created_by`, `updated_at`, `updated_by`, `version`
   - Explicit foreign keys with appropriate `ON DELETE RESTRICT` constraints.

### Step 2: In-Database Invariant Patterns
- **100% Co-Ownership Share Balancing**:
  ```sql
  -- Verified on parcel survey submission
  SELECT coalesce(sum(share_percent), 0) FROM lms.survey_owner WHERE survey_id = p_survey_id;
  -- Must equal 100.0000 exactly
  ```
- **Code Stems & Sequence Numbers**:
  Always use `lms.next_code_year('CC')` for compensation cases (`CC-YYYY-XXXXX`), `lms.next_code_year('VCH')` for payment vouchers, and `lms.next_code('LN-')` for lease lines.
- **Actor Setting in Transactions**:
  Every connection executing DML must first run:
  ```sql
  SELECT api.set_actor('USER_UUID');
  ```
- **Security Definer Routines**:
  Mutations that update sensitive state (e.g. `api.release_payment`, `api.request_payment`, `api.advance_workflow`) must execute as `SECURITY DEFINER` with explicit jurisdiction re-checks.

---

## 5. Expected Deliverables

- Clean, transactional SQL migration files.
- Zero orphaned foreign keys or unbounded scans.
- Query plan verification (`EXPLAIN ANALYZE`).
- Successful execution of database test suite: `python3 db/tools/run_tests.py`.

---

## 6. Validation Steps

```bash
# Verify all migrations apply cleanly
python3 db/tools/migrate.py verify

# Run database test suite (16 files, 482 assertions)
python3 db/tools/run_tests.py

# Check query plans for heavy tables
psql -d lms_dev -c "EXPLAIN ANALYZE SELECT * FROM api.v_landowner_summary;"
```

---

## 7. Failure Handling

- If a check constraint fails (e.g. `payment_request_pay_type_check`), query `pg_constraint` to inspect the exact allowed values:
  `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '...';`
- If a generated column error triggers (`cannot insert a non-DEFAULT value into column`), omit generated columns from the INSERT list.

## Rules learned at volume (2026-10-29)

- Write row-level-security predicates with the actor functions in scalar
  sub-selects — `(SELECT lms.actor_role())`, `(SELECT lms.actor_provinces())::bpchar[]` —
  so they run once per statement (migration 0036). A bare call runs per row
  (~23 µs each: seconds on a 100k-row table).
- Do not put a non-inlinable function (`SET search_path`, SECURITY DEFINER,
  plpgsql) in a view's `FROM … LATERAL` for every row; aggregate once and join
  (migration 0038). Check equivalence on the volume fixture before replacing.
- Measure with `db/tools/perf_load.sql` on a throwaway database, as `lms_app`,
  inside one transaction with the actor set (`SELECT api.set_actor(…)`); a
  session without an actor sees no rows and gives meaningless timings.
- Money rules (withholding tax, duplicate vouchers, holds) belong in `api.*`
  routines; never accept a client-chosen rate for a landowner payee.
