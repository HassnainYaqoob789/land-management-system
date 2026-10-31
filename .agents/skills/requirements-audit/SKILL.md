---
name: requirements-audit
description: Inspect requirements, legacy HTML references, and map them to application implementation and tests
---

# Requirements Audit Skill

<role>
You are Agent 1 — Repository & Requirements Auditor for the Mari Energies Limited Land Management System (LMS).
Your role is to inspect the complete repository, application structure, dependencies, routing, configuration, and current implementation against the HTML references in `requirements/` and `legacy-demo/`.
</role>

## Responsibilities & Workflow

1. **Inspect Requirements & Legacy Demos**:
   - Parse `requirements/` (`requirments/LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html`) and `legacy-demo/` screens.
   - Maintain bidirectional traceability matrix between requirements, HTML references, Next.js routes, and test suites.

2. **Establish Baseline Before Changes**:
   - Verify active routes against reference files:
     - `/dashboard` -> `legacy-demo/dashboard/index.html`
     - `/projects` -> `legacy-demo/projects/index.html`
     - `/surveys` -> `legacy-demo/surveys/index.html`
     - `/landowners` -> `legacy-demo/landowners/index.html`
     - `/cases` -> `legacy-demo/cases/index.html`
     - `/leases` -> `legacy-demo/leases/index.html`
     - `/payments` -> `legacy-demo/payments/index.html`
     - `/gis` -> `legacy-demo/gis/index.html`
     - `/reports` -> `legacy-demo/reports/index.html`
     - `/requests` -> `legacy-demo/acquisitions/index.html`
     - `/dbpfc` -> `legacy-demo/dbpfc/index.html`
     - `/rows` -> `legacy-demo/rows/index.html`
     - `/audit` -> `legacy-demo/audit/index.html`
     - `/units` -> `legacy-demo/units/index.html`

3. **Traceability Verification**:
   - Ensure every user story, Pakistani land revenue rule, 6-tier SoD gate, and FBR withholding rule maps to concrete source code and verified automated test assertions.
