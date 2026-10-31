---
phase: 6
researched_at: 2026-10-27
discovery_level: 2
---

# Phase 6 Research — Quality Assurance Gate & UAT Methodology

## Objective
Establish empirical verification procedures, performance and load test methodologies, and User Acceptance Testing (UAT) sign-off criteria for the Mari Energies LMS demonstration and deployment readiness.

## Key Decisions

### Decision 1: Test Runner Architecture
**Question:** How should test suites be executed in both automated CI environments and local workstations?  
**Decision:** Standard library Python script `db/tools/run_tests.py` orchestrating raw SQL scripts (`db/tests/*.sql`) via standard `psql` subprocess calls. This eliminates driver dependencies and guarantees that tests run against native PostgreSQL server environments.  
**Confidence:** High (Clean, zero-dependency test runner).

### Decision 2: Concurrency & Race Condition Verification
**Question:** How to prove that duplicate releases cannot occur under simultaneous user submission?  
**Decision:** Multi-threaded Python test harness (`db/tests/test_07_concurrency.py`) firing concurrent parallel threads attempting to release the same voucher or transition the same case simultaneously. Verification checks that exactly one transaction succeeds and the remainder receive appropriate serialization or duplicate key errors.  
**Confidence:** High (Empirical proof of financial safety).

### Decision 3: UAT Environment Separation
**Question:** How should UAT be structured for Mari Energies stakeholders?  
**Decision:** Deploy an isolated UAT staging environment with realistic fictional multi-provincial seed data (`db/seed/seed_demo.sql` and `seed_demo_transactions.sql`). Maintain complete segregation from any operational networks until formal UAT sign-off.  
**Confidence:** High (Standard enterprise rollout best practice).
