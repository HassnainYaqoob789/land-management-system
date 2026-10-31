# GSD Evidence-Based Release Gates

This document defines the strict, non-negotiable release criteria for the Mari Energies Land Management System (LMS).
A release or milestone cannot be marked "Complete" or "Release-Ready" unless all gates below are evaluated with verifiable empirical proof.

---

## 🚦 Gate Definitions & Status Standards

All gates must report one of five unambiguous statuses:
- **`PASSED`**: The check was executed, evaluated against objective criteria, and succeeded with zero unresolved failures.
- **`FAILED`**: The check was executed and did not meet acceptance criteria (blocks release).
- **`BLOCKED`**: The check could not execute due to an upstream dependency, hardware, or environment blocker (blocks release unless approved exception).
- **`SKIPPED`**: The check was intentionally bypassed with documented rationale (requires explicit sign-off; cannot be used for core security or financial invariants).
- **`NOT EXECUTED`**: The check was never attempted (blocks release).

---

## 📋 The Enterprise Release Gates (G8–G10 in the sign-off matrix below)

### Gate 1: Requirements Traceability & Coverage
- **Criterion**: Every feature in the release maps directly to a verified `REQ-XX` in `.gsd/REQUIREMENTS.md` and `.gsd/SPEC.md`. Zero unmapped or hallucinated functionality.
- **Evidence Required**: Updated Traceability Matrix in `.gsd/REQUIREMENTS.md` with commit SHAs and test file paths.
- **Verification Command**: `grep -c "Status: Implemented" .gsd/REQUIREMENTS.md`

### Gate 2: Clean Compilation & Type Safety
- **Criterion**: Next.js 15 App Router production bundle compiles with zero TypeScript errors, zero lint warnings, and zero missing page traces.
- **Evidence Required**: Full compiler logs.
- **Verification Commands**:
  ```bash
  npx tsc --noEmit
  npm run lint
  npm run build
  ```

### Gate 3: Unit & Regression Testing
- **Criterion**: All unit and regression tests pass (100% green). No test skipped or assertions weakened.
- **Evidence Required**: Command output covering domain calculations:
  - 100.0% mathematical share balancing
  - Pakistani area conversions (Acre, Kanal, Marla, Murabba, Jareeb, Sq. Yards)
  - NADRA CNIC regex format (`XXXXX-XXXXXXX-X`)
  - FBR Withholding Tax calculation (10% filer vs 20% non-filer)
- **Verification Command**: `npm run test:unit`

### Gate 4: Database Integrity & Invariants
- **Criterion**: PostgreSQL 16 schema integrity verified with zero constraint violations. In-database financial checks, foreign keys, and RLS policies enforced.
- **Evidence Required**: Successful run of 16 database test suites (482 assertions).
- **Verification Commands**:
  ```bash
  python3 db/tools/run_tests.py
  python3 db/tools/migrate.py verify
  ```

### Gate 5: 6-Tier Segregation of Duties (SoD) & Legal Hold Compliance
- **Criterion**: Compensation workflow enforces strict sequential progression:
  `Land Officer -> Negotiation Officer -> Legal Advisor -> Sr. Admin Field -> DM/TL Field -> Manager Land HO -> Finance Officer`.
  - Self-approval prohibited.
  - Mandatory 6 document checks verified prior to field approval.
  - Parcels with active court stay orders (`lms.payment_hold`) strictly blocked from disbursement.
- **Evidence Required**: Multi-persona transition logs and database audit records.
- **Verification Command**: `IAM_TEST_BASE=… IAM_TEST_PASSWORDS=… npm run test:api` (tests/regression: workflows, business rules, payments, holds) and `npm run test:db`

### Gate 6: Playwright E2E & WCAG 2.1 AA Accessibility
- **Criterion**: Automated end-to-end user journeys pass in headless Chromium. `@axe-core/playwright` accessibility audit yields **0 critical violations** across all core LMS views (`/dashboard`, `/surveys`, `/cases`, `/landowners`, `/leases`, `/payments`, `/gis`, `/audit`, `/reports`, `/login`).
- **Evidence Required**: Playwright test report and axe-core violation scan summary.
- **Verification Command**: `BASE_URL=… IAM_TEST_PASSWORDS=… npm run test:playwright` (legacy_design: every screen, axe with colour contrast on; user_journeys: role-based journeys)

### Gate 7: Immutable Audit Trail & ERP Integration Queue
- **Criterion**: Every state transition, payment release, and authentication event is written to `audit.audit_event`. Released payments insert an integration record into `lms.integration_outbox` for SAP/ERP sync.
- **Evidence Required**: Database query verifying recorded audit events for the test session.
- **Verification Command**: `psql -d lms_dev -c "SELECT count(*) FROM audit.audit_event WHERE created_at > now() - interval '1 hour';"`

---

## 🛑 Release Sign-Off Matrix

| Gate | Description | Target | Mandatory? | Gate Status |
|:---|:---|:---:|:---:|:---:|
| **G1** | Requirements Traceability | 100% coverage | YES | Required |
| **G2** | Next.js Build & Typecheck | 0 errors | YES | Required |
| **G3** | Unit & Domain Calculations | 100% passing | YES | Required |
| **G4** | PostgreSQL Schema & Invariants | all suites passing, 0 migration drift | YES | Required |
| **G5** | 6-Tier SoD & Payment Holds | 0 bypasses | YES | Required |
| **G6** | Playwright E2E & Axe A11y | 0 critical fails | YES | Required |
| **G7** | Audit Trail & Outbox Logging | 100% logged | YES | Required |
| **G8** | Security: dependencies, secrets, headers | findings fixed or risk-accepted in writing | YES | Required |
| **G9** | Performance at volume (`db/tools/perf_load.sql`, `scripts/perf/load_test.mjs`) | p95 recorded at 1/10/25 users; no unbounded list endpoint | YES | Required |
| **G10** | UAT | role scenarios executed; stakeholder sign-off recorded separately | YES | Required |

If ANY mandatory gate reports `FAILED`, `BLOCKED`, or `NOT EXECUTED`, the release is **REJECTED**.


## Engineering rules the gates assume (added 2026-10-29)

- **Bounded lists.** Every list endpoint pages in the database (`src/lib/paging.ts`:
  default 100, max 500 rows) and returns `page.total`; KPI tiles come from
  `summary` aggregates over the whole register, never from the rows on screen.
  Large registers are chosen with `RecordPicker`, which searches the database.
- **Row-level security once per query.** Policies call actor functions inside a
  scalar sub-select (`(SELECT lms.actor_provinces())`), so they are evaluated once
  per statement (migration 0036). A new policy must follow the same form.
- **Money rules in the database.** Withholding tax, duplicate-voucher and hold
  checks live in `api.*` routines; the API never forwards a client-chosen rate.
- **Results are measured.** Reports state the command, the database and the
  date; anything not run is NOT EXECUTED.
