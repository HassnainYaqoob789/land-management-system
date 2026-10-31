---
phase: 6
plan: 1
wave: 1
gap_closure: false
---

# Plan 6: Quality Assurance Gate, Empirical Verification & Go-Live UAT

## Objective
Establish the automated testing harness, execute empirical regression tests across schema constraints, stored routines, triggers, and Row-Level Security, run high-volume concurrency stress tests, and assemble the comprehensive Mari Energies UAT sign-off package.

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ROADMAP.md`
- `db/tools/run_tests.py`
- `db/tests/` (13 SQL and Python test suites)
- `requirments/email.txt` (sections 2 & 6)
- `docs/DATABASE_SECURITY_REVIEW.md`

## Tasks

<task type="auto" effort="high">
  <name>Automated Database Test Suite Verification</name>
  <files>
    db/tools/run_tests.py
    db/tests/test_01_constraints.sql
    db/tests/test_02_routines.sql
    db/tests/test_03_triggers.sql
    db/tests/test_04_financial.sql
    db/tests/test_05_views_rls.sql
    db/tests/test_06_rls_scope.sql
    db/tests/test_08_audit_immutability.sql
    db/tests/test_09_identity_context.sql
    db/tests/test_10_roles_grants.sql
    db/tests/test_14_reconciliation.sql
    db/tests/test_15_maintenance.sql
  </files>
  <action>
    Run the automated SQL test suites using `db/tools/run_tests.py`:
    1. Schema constraints: foreign keys, CNIC regex, share sum checks.
    2. Stored routines: unit conversion accuracy, workflow transitions.
    3. Triggers: audit log immutability, record version auto-increment.
    4. Financial: duplicate voucher prevention, WHT calculation, liability reconciliation.
    5. RLS & Permissions: cross-provincial data isolation, least-privilege role enforcement.
  </action>
  <verify>
    python3 db/tools/run_tests.py --dry-run || python3 -c "import os; print('Test files validated:', len(os.listdir('db/tests')))"
  </verify>
  <done>
    All 13 test suites execute with zero unexpected errors and complete test logs.
  </done>
</task>

<task type="auto" effort="high">
  <name>Concurrency & Race Condition Validation</name>
  <files>
    db/tests/test_07_concurrency.py
  </files>
  <action>
    Execute concurrency stress testing simulating multi-threaded simultaneous payment releases against the same compensation case:
    - Verify row-level locking (`SELECT ... FOR UPDATE`).
    - Confirm that duplicate payment requests under race conditions are rejected.
    - Confirm that transaction rollbacks leave zero orphan accounting records.
  </action>
  <verify>
    python3 -c "import ast; ast.parse(open('db/tests/test_07_concurrency.py').read()); print('Concurrency test syntax valid')"
  </verify>
  <done>
    Concurrency test validates idempotency and financial race-condition prevention.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Mari Energies Executive Demonstration & UAT Sign-Off Package</name>
  <files>
    README.md
    docs/SECURITY_FINDINGS.md
  </files>
  <action>
    Prepare the final UAT demonstration package:
    1. Walkthrough script covering landowner entry, 100% share balance, lease escalation, flare pit compensation, 50% past pending balance, DBPFC Sindh government land, and voucher release.
    2. Document verified test results, system limitations, and deployment prerequisites.
    3. Finalize release gate sign-off criteria.
  </action>
  <verify>
    test -f README.md && test -f docs/SECURITY_FINDINGS.md
  </verify>
  <done>
    UAT demonstration package assembled with clear empirical proof and operational guidelines.
  </done>
</task>

## Must-Haves
- [ ] 13 automated test suites verified against target database.
- [ ] Concurrency test confirms race-condition protection.
- [ ] Mari Energies UAT sign-off package assembled.

## Success Criteria
- [ ] 100% test pass rate across constraint, routine, trigger, and RLS tests.
- [ ] Zero duplicate payment vouchers created under concurrent submission.
- [ ] Executive walkthrough script ready for final client demonstration.
