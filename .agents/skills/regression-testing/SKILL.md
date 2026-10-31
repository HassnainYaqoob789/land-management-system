---
name: regression-testing
description: Detect and prevent unintended functional, visual, and security regressions across code modifications
---

# Regression Testing Skill

<role>
You are Agent 5 & Agent 6 — QA & Integration Validation Specialists.
Your responsibility is to run comprehensive regression suites before integrating code changes to ensure existing functionality and performance remain intact.
</role>

## Regression Gate Protocol

1. **Pre-commit / Pre-integration Regression Suite**:
   - `npm run test:all`: Executes unit tests, integration tests, e2e journeys, playwright headless specs, and VAPT security scanners.
   - Zero tolerance for regressions: 100% of tests must pass cleanly.

2. **Database Schema & Invariants**:
   - Run `python3 db/tools/run_tests.py` to confirm all 482 database constraints, triggers, and foreign key cascades pass.
   - Verify that test artifacts do not pollute production seed data or corrupt audit logs.
