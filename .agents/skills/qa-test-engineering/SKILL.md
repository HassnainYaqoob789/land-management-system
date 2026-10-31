---
name: qa-test-engineering
description: Multi-layered QA test engineering covering unit tests, API integration tests, negative boundary scenarios, and regression verification
---

# QA Test Engineering Skill

<role>
You are a Principal Test Automation Architect and Quality Assurance Specialist.
Your role is to design, implement, and maintain comprehensive test suites across unit, integration, API, regression, and database layers, ensuring robust negative testing and zero false positives.
</role>

---

## 1. Purpose & Scope

Ensure every tier of the LMS operates with verified mathematical accuracy and data integrity:
- **Unit Testing**: Domain calculations (100.0% share balancing, area unit conversions, FBR WHT calculations, CNIC NADRA regex).
- **API Integration Testing**: Route handlers, session cookies, input validation, negative scenarios (invalid payload, missing fields), unauthorized access attempts.
- **Database Schema Testing**: In-database invariants, foreign keys, sequence generation, payment holds, budget balances.
- **Regression Testing**: Ensuring that changes in one module do not break existing compensation cases, surveys, or payment workflows.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Adding or modifying business logic in `src/lib/domain.ts` or `src/app/api/`.
- Creating new unit tests (`tests/unit/`) or integration tests (`tests/integration/`).
- Verifying boundary conditions (0% share, 100.01% share, negative amount, deceased landowner).
- Running pre-merge or pre-release verification gates.

---

## 3. Prerequisites

1. Node.js built-in test runner (`node --test`) or custom test scripts.
2. PostgreSQL test database `lms_dev`.
3. Running application server on port 3030 (`http://localhost:3030`).
4. End-to-end test runner `scripts/test_e2e.js`.

---

## 4. Execution Procedure

### Step 1: Unit Test Implementation (`tests/unit/`)
Test pure business logic functions with comprehensive boundary matrices:
1. **Share Balancer**:
   - Exactly 100.0% &rarr; Valid
   - Sum = 99.9% &rarr; Invalid (shortfall 0.1%)
   - Sum = 100.1% &rarr; Invalid (excess 0.1%)
   - Multi-owner fractional shares (e.g. 33.3333%, 33.3333%, 33.3334%).
2. **Pakistani Area Conversions**:
   - 1 Acre = 8 Kanals = 160 Marlas = 4,840 Sq. Yards.
   - 1 Murabba = 25 Acres.
   - 1 Jareeb = 0.5 Acres.
3. **CNIC Validation**:
   - Standard format: `45501-1234567-1` &rarr; Valid
   - Missing dashes: `4550112345671` &rarr; Invalid
   - Alpha characters: `45501-123456A-1` &rarr; Invalid
4. **FBR Withholding Tax**:
   - Active Filer: 10% standard rate.
   - Non-Filer: 20% punitive 2x rate.

### Step 2: API Integration Testing (`tests/integration/`)
1. **Positive Flows**:
   - Valid session cookie &rarr; 200 OK.
   - Valid payload &rarr; Record created in PostgreSQL.
2. **Negative & Boundary Flows**:
   - Missing session cookie &rarr; 401 Unauthorized.
   - Unauthorized role advancing workflow stage &rarr; 403 Forbidden.
   - Case creation on deceased landowner without succession &rarr; 400 Bad Request.
   - Payment release on parcel under legal stay order hold &rarr; 400 Bad Request.

### Step 3: Test Execution
Run test commands and capture full results:
```bash
# Run unit test suite
npm run test:unit

# Run integration test suite
npm run test:integration

# Run database schema tests
python3 db/tools/run_tests.py

# Run complete end-to-end test runner
npm run test:e2e
```

---

## 5. Expected Deliverables

- Comprehensive test files under `tests/unit/` and `tests/integration/`.
- Zero test assertion failures or unhandled rejections.
- Test execution logs documented in `VERIFICATION.md`.

---

## 6. Validation Steps

```bash
# Run all automated tests
npm run test:all
```

---

## 7. Failure Handling

- If a test fails, do NOT disable or weaken the assertion.
- Investigate the root cause (schema constraint, route handler logic, or test data).
- Fix the underlying defect and re-execute the full suite until 100% green.
