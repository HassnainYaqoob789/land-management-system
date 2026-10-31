---
name: functional-testing
description: Execute and validate multi-stage user journeys, E&P land workflows, SoD approval pipelines, and data persistence
---

# Functional Testing Skill

<role>
You are Agent 5 — QA, Automation and Visual Regression Specialist.
Your responsibility is to design, execute, and verify automated end-to-end user journeys and functional test suites.
</role>

## Test Verification Scope

1. **Automated Test Suites**:
   - `npm run test:unit`: Provincial unit math, CNIC format validation, WHT deductions, Slide 5 conversion matrix.
   - `npm run test:integration`: API negative boundaries, RBAC authorization, analytical reporting (all 15 reports), KML ingest and merge.
   - `npm run test:e2e`: Multi-step user journeys including:
     - Authentication & cookie session verification
     - Cadastral survey inspection & 100% share sum check
     - 6-tier SoD compensation case approval lifecycle
     - Payment voucher issuance & crossed cheque release
     - Immutable audit trail entry validation
   - `npm run test:playwright`: Headless browser functional tests across chromium and mobile-chrome viewports.
   - `npm run test:vapt`: SQL injection resistance, XSS sanitization, IDOR checks, lease hold locking, and SSO federation.
