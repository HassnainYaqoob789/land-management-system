---
phase: 4
plan: 1
wave: 1
gap_closure: false
---

# Plan 4: PostgreSQL Database Architecture, Routines, Triggers & Integrity Controls

## Objective
Implement PostgreSQL 16 as the authoritative, independently secured enterprise system of record. Enforce relational constraints, exact `numeric(18,4)` decimal math, stored procedures for financial calculations and duplicate prevention, automated triggers for immutable auditing, reporting views, province-scoped Row-Level Security (RLS), and least-privilege database roles across 18 versioned forward-only migrations.

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ARCHITECTURE.md`
- `requirments/prompt.md` (Phase 4, sections 4.1 through 4.9)
- `db/bootstrap/01_roles.sql`
- `db/bootstrap/02_database.sql`
- `db/migrations/0001_foundation.sql` through `0018_functions_import_report.sql`
- `db/tools/migrate.py`
- `db/tools/run_tests.py`

## Tasks

<task type="auto" effort="high">
  <name>Author Relational Schema & Exact Numeric Precision Migrations</name>
  <files>
    db/migrations/0001_foundation.sql
    db/migrations/0002_reference_and_org.sql
    db/migrations/0003_land_and_landowners.sql
    db/migrations/0004_workflow.sql
    db/migrations/0005_acquisition_case_lease_row.sql
    db/migrations/0006_payments_budget_dbpfc.sql
    db/migrations/0007_grievance_legal_mutation.sql
    db/migrations/0008_audit_documents_notifications.sql
    db/migrations/0009_import_and_integration.sql
  </files>
  <action>
    Design and implement normalized tables covering:
    - `lms_ref`: provinces, administrative units, designations, measurement conversion rates.
    - `lms_org`: users, roles, organizational hierarchy, approval groups.
    - `lms_cadastre`: projects, surveys/khasras, landowners (CNIC master), parcel ownership shares.
    - `lms_land`: acquisitions (1894 Act), leases, ROW corridors, DBPFC cases.
    - `lms_finance`: compensation cases, payment vouchers, payment lines, budget heads.
    - `lms_legal`: grievances, litigations, title mutations (*Wirasat / Intiqal*).
    - `lms_audit`: append-only audit log, record versions, document attachments.
    Enforce exact `numeric(18,4)` types for currency, areas, and shares.
  </action>
  <verify>
    python3 db/tools/migrate.py verify
  </verify>
  <done>
    All migration scripts pass syntax validation, SHA-256 checksum tracking, and forward-only execution standards.
  </done>
</task>

<task type="auto" effort="high">
  <name>Implement Stored Procedures, Functions & Financial Integrity Controls</name>
  <files>
    db/migrations/0010_functions_core.sql
    db/migrations/0011_functions_workflow.sql
    db/migrations/0012_functions_financial.sql
    db/migrations/0018_functions_import_report.sql
  </files>
  <action>
    Implement PostgreSQL stored routines using `SECURITY INVOKER` by default:
    1. Land unit conversion routines (converting Acre, Kanal, Marla, Ghunta, Jireb, Rod, Pole to/from square feet).
    2. Co-ownership share sum validator enforcing 100.0% constraint.
    3. Workflow stage transition and designation authority validator.
    4. Financial settlement, WHT calculation, duplicate payment check, and liability reconciliation.
    5. CSV batch import validation and variance reporting.
  </action>
  <verify>
    grep -E "CREATE OR REPLACE FUNCTION" db/migrations/0010_functions_core.sql db/migrations/0012_functions_financial.sql
  </verify>
  <done>
    Routines are deployed with strict parameter typing, safe search paths, and comprehensive error handling.
  </done>
</task>

<task type="auto" effort="high">
  <name>Automated Triggers, Reporting Views, Row-Level Security & Least Privilege</name>
  <files>
    db/migrations/0013_triggers.sql
    db/migrations/0014_views.sql
    db/migrations/0016_rls.sql
    db/migrations/0017_grants.sql
    db/bootstrap/01_roles.sql
  </files>
  <action>
    1. Triggers: Enforce immutability on `lms_audit.audit_log`, auto-increment record version numbers, and validate parcel share totals on DML.
    2. Views: Create `v_landowner_summary`, `v_project_status`, `v_lease_renewal_calendar`, `v_pending_liabilities`, `v_dbpfc_status`, `v_executive_kpis`.
    3. RLS: Configure Row-Level Security policies restricting records based on `app_user.province` context.
    4. Least Privilege: Create separate database roles (`lms_owner`, `lms_migrator`, `lms_app`, `lms_readonly`, `lms_audit`).
  </action>
  <verify>
    grep -E "ENABLE ROW LEVEL SECURITY" db/migrations/0016_rls.sql
  </verify>
  <done>
    Triggers guard audit immutability; views provide parameterized reporting; RLS isolates cross-provincial data; least-privilege roles enforced.
  </done>
</task>

## Must-Haves
- [x] 18 versioned SQL migrations with checksum tracking.
- [x] Exact numeric precision (`numeric(18,4)`) for all financial and area columns.
- [x] In-database stored procedures for financial math and duplicate prevention.
- [x] Audit log immutability enforced by database triggers.
- [x] Province-scoped Row-Level Security (RLS) policies implemented.
- [x] Least-privilege role separation (`lms_owner`, `lms_migrator`, `lms_app`, `lms_readonly`, `lms_audit`).

## Success Criteria
- [x] `db/tools/migrate.py verify` validates checksum integrity.
- [x] Automated test suites in `db/tests/` exercise constraints, routines, triggers, and RLS.
- [x] Comprehensive database security review published in `docs/DATABASE_SECURITY_REVIEW.md`.
