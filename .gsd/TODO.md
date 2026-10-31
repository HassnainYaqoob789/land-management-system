# TODO.md — Pending Items

> Quick capture of tasks, issues, and action items for Mari Energies Land Management System (LMS).

---

## Active Phase 9 Tasks (Executive Decision Intelligence, Analytics & GIS Mapping)

- [x] **Plan 9.1: PostgreSQL Stored Views & Slide 5 Canonical Measurement Standardization** `high` — Deploy `db/migrations/0026_decision_intelligence_and_gis.sql` with exact conversion factors for 11 provincial units, `lms.convert_area()` routine, spatial feature storage, and reporting views. ✓ 2026-10-28
- [x] **Plan 9.2: Executive Multi-Audience Dashboards** `high` — Implement 4-role switcher (C-Level, Director Portfolio, Finance, Land Operations) and live reporting unit switcher on `/dashboard`. ✓ 2026-10-28
- [x] **Plan 9.3: 15 Decision-Oriented Analytical Reports** `high` — Deploy `/reports` with Global Filter Toolbar, CSV streaming export, and clean Printable Statement with Mari Energies logo and Alisons Technology footprint. ✓ 2026-10-28
- [x] **Plan 9.4: GIS Cadastral Workspace & Dataset Merge Engine** `high` — Implement multi-file KML/KMZ upload, coordinate validation against Pakistan concession boundaries, visual overlay, true project dataset merge, and downloadable merged KML generation on `/gis`. ✓ 2026-10-28
- [x] **Plan 9.5: Mari Energies Corporate Identity & Footprints** `medium` — Update Header, Login, Reports, Prints, and Favicon with official user-provided Mari Energies logo; add "Developed by Alisons Technology" footprints across shell, login, and print layouts. ✓ 2026-10-28
- [x] **Plan 9.6: Automated Unit & Integration Test Suites** `high` — Author and execute `tests/unit/measurement_units.test.js` (8 tests), `tests/integration/analytics_reports.test.js` (22 tests), and `tests/integration/gis_kml.test.js` (6 tests). All 36 tests passing green. ✓ 2026-10-28

---

## Completed Phase 8 Tasks (Reference Ingestion & Enterprise Integrations)

- [x] **Plan 8.1: Ingest Reference CSV Datasets** `high` — Cleanse and ingest 380 landowners, 640 leases, 450 renewals, 67 projects, and DPFC government land records into PostgreSQL `lms_dev`. ✓ 2026-10-28
- [x] **Plan 8.2: 4-Tier Land Lease Request Initiation Workflow** `high` — Implement the land lease request initiation flow from `Sample Approval Workflow.pdf` with Request creation, Director Operations approval/rejection, Regional Manager assignment, and DM/TL Land Affairs processing. ✓ 2026-10-28
- [x] **Plan 8.3: Lease Renewal Reason-Based Hold & Release** `high` — Add `/api/leases/[id]/hold` and `/api/leases/[id]/renew` with mandatory hold reasons (Slide 15) and interactive UI controls. ✓ 2026-10-28
- [x] **Plan 8.4: Active Directory SSO Staging Simulator** `high` — Implement SAML 2.0 / OIDC staging endpoints (`/api/auth/sso/callback`, `/api/auth/sso/login`, `/api/auth/sso/metadata`) with 1-click corporate sign-in for all 10 E&P personas. ✓ 2026-10-28
- [x] **Plan 8.5: SAP ERP Outbox Background Worker** `high` — Build `scripts/sap_outbox_worker.ts` to poll `lms.integration_outbox`, post simulated SAP BAPI accounting documents, assign SAP document numbers (`BELNR`), and mark records `SYNCHRONIZED`. ✓ 2026-10-28
- [x] **Plan 8.6: Automated VAPT Security Scanner** `medium` — Create `tests/security/vapt_scanner.test.js` validating SQL injection, XSS reflection, IDOR access control, and CSRF/secure cookie attributes. ✓ 2026-10-28
- [x] **Plan 8.7: Backup & Point-in-Time Recovery Drill** `medium` — Execute `db/tools/backup.sh verify lms_dev`, restore the dump into `lms_dev_restorecheck`, and empirically verify 100% cryptographic checksum match. ✓ 2026-10-28

---

## Completed Items

- [x] Run GSD script encoding conversion and validator audit `high` — 2026-10-27 ✓ 2026-10-27
- [x] Establish canonical GSD specifications (`.gsd/SPEC.md`, `ROADMAP.md`, `REQUIREMENTS.md`, `ARCHITECTURE.md`, `STACK.md`, `DECISIONS.md`, `STATE.md`) `high` — 2026-10-27 ✓ 2026-10-27
- [x] Test deterministic build pipeline and page generation (`sh build/build.sh`) `high` — 2026-10-27 ✓ 2026-10-27
- [x] Author enterprise compliance documents in `docs/` (`SECURITY_ARCHITECTURE.md`, `OWASP_ASVS_TRACEABILITY.md`, `ISO27001_READINESS.md`, `SOC2_READINESS.md`, `DATABASE_SECURITY_REVIEW.md`, `SECURITY_FINDINGS.md`) `high` — 2026-10-27 ✓ 2026-10-27
- [x] Execute automated database test runner (`python3 db/tools/run_tests.py`) against live PostgreSQL instance (16 suites, 482 assertions) `medium` — 2026-10-27 ✓ 2026-10-27
- [x] Build full-stack Next.js 15 App Router architecture with 31 routes and connection pool `high` — 2026-10-27 ✓ 2026-10-27
- [x] Implement multi-persona authentication, 6-tier SoD workflow, and crossed cheque release `high` — 2026-10-27 ✓ 2026-10-27
- [x] Implement Playwright E2E automation and `@axe-core/playwright` WCAG 2.1 AA audits (22 passed) `high` — 2026-10-27 ✓ 2026-10-27
- [x] Conduct comprehensive workspace audit and author master production readiness report `high` — 2026-10-28 ✓ 2026-10-28
- [x] Author exhaustive GSD Gap Analysis (`.gsd/GAP_ANALYSIS.md`) reconciling reference materials `high` — 2026-10-28 ✓ 2026-10-28

---

*Last updated: 2026-10-28*
