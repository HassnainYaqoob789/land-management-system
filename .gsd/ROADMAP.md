---
milestone: Mari Energies LMS Enterprise Release
version: 2.0.0
updated: 2026-10-28T00:25:00Z
---

# Roadmap — Land Management System (LMS)

> **Current Milestone:** Milestone 2 — Full-Stack Next.js + Node.js + PostgreSQL Production Implementation (v2.0.0)  
> **Current Phase:** Phase 8 — Reference Data Cleansing & Ingestion, Missing Business Workflows, and Enterprise Integrations  
> **Status:** active  
> **Tech Stack:** Frontend: Next.js 15 (App Router, Tailwind CSS), Backend: Node.js (API Routes), Database: PostgreSQL 16 (`lms_dev`)  
> **Target Production Go-Live:** 1 March 2027  

---

## Must-Haves (from SPEC & Business Baseline)

- [x] Four provincial revenue engines (Sindh, Balochistan, Punjab, KP) with native administrative units and land measurements.
- [x] Master CNIC validation and mathematical co-ownership fractional share balancing (sum = 100.0%).
- [x] 6-tier designation-based approval hierarchy with non-destructive record versioning and append-only audit trail.
- [x] Multi-page modular web build running under strict Content Security Policy (`script-src 'self'`) with declarative `data-act` routing.
- [x] PostgreSQL 16 relational database schema with 18 versioned migrations, exact `numeric(18,4)` precision, stored procedures, triggers, views, and RLS.
- [x] Security and compliance traceability reports for OWASP ASVS Level 2, ISO/IEC 27001:2022 ISMS, and SOC 2 Trust Services Criteria.
- [x] Automated test suite covering schema constraints, routines, triggers, financial reconciliation, and database access controls (561 tests passed).
- [x] Automated reference CSV dataset ingestion (380 landowners, 640 leases, 450 renewals, 67 projects, DPFC government land).
- [x] 4-tier land lease request initiation & approval workflow (Initiator &rarr; Director Ops &rarr; Regional Manager &rarr; DM/TL Land Affairs).
- [x] Lease renewal approval with reason-based Hold & Release management.
- [x] Enterprise Active Directory (ADFS / Entra ID) SSO staging simulator for all 10 corporate personas.
- [x] SAP ERP RFC outbox worker for automated BAPI GL document posting.
- [x] Automated OWASP ASVS L2 VAPT penetration testing suite.
- [x] Backup and restoration point-in-time recovery verification drill.

---

## Phases

### Phase 1: Provincial Revenue & Cadastral Engine + Multi-Page Frontend Shell
**Status:** ✅ Complete  
**Objective:** Deliver the multi-provincial administrative hierarchy master, measurement conversion engine, 30 uniform page shells, declarative `data-act` event routing, and strict CSP compliance.  
**Requirements:** REQ-01, REQ-02, REQ-17, REQ-18  

**Plans:**
- [x] Plan 1.1: Provincial Hierarchy Masters & Unit Conversion Engine (Sindh, Balochistan, Punjab, KP)
- [x] Plan 1.2: Deterministic Extraction, CSP Transformation & 30 Uniform Screen Shells (`app/`)
- [x] Plan 1.3: Declarative `data-act` Event Dispatcher & Function Allowlist Registry (`app/assets/js/app/registry.js`)

---

### Phase 2: Landowner & Cadastral Domain Modules
**Status:** ✅ Complete  
**Objective:** Implement landowner master registration, CNIC uniqueness validation, 100% co-ownership balance (*Hissa-dari*), deceased owner disbursement locks with succession mutations (*Wirasat / Intiqal*), and MapLibre GL GIS vector mapping with KML/KMZ upload.  
**Depends on:** Phase 1  
**Requirements:** REQ-03, REQ-04, REQ-05, REQ-16  

**Plans:**
- [x] Plan 2.1: Landowner Master Data, CNIC Validation & Fractional Share Balancing
- [x] Plan 2.2: Deceased Owner Guardrails & Inheritance Succession Workflow
- [x] Plan 2.3: Geospatial (GIS) Cadastral Mapping, Vector Layers & KML/KMZ Ingestion Engine

---

### Phase 3: Acquisition, Leases, ROW & Compensation Workflow Engine
**Status:** ✅ Complete  
**Objective:** Deliver statutory land acquisitions under the *Land Acquisition Act 1894*, surface well leases with escalation schedules, Right-of-Way (ROW) linear corridors, DBPFC Sindh government land pricing, and 6-tier designation-based approval hierarchies for crop, tree, flare pit, and 50% past pending balance payments.  
**Depends on:** Phase 2  
**Requirements:** REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-14  

**Plans:**
- [x] Plan 3.1: Statutory Land Acquisition Act 1894 Lifecycle (Sections 4, 6, 9, 11)
- [x] Plan 3.2: Surface Leases, Escalation Rules, Expiry Alerts & Lease Holds
- [x] Plan 3.3: Right-of-Way (ROW) Pipeline Corridors & Flowlines
- [x] Plan 3.4: Sindh Government Land Reservation & DBPFC Pricing Workflow
- [x] Plan 3.5: Multi-Tier Designation Approval Engine & 50% Past Pending Balance Cases

---

### Phase 4: PostgreSQL Database Architecture, Routines, Triggers & Integrity Controls
**Status:** ✅ Complete  
**Objective:** Implement PostgreSQL 16 as the authoritative system of record: 18 versioned migrations, exact decimal precision, stored procedures for financial calculations and duplicate prevention, automated triggers for audit immutability, reporting views, province-scoped Row-Level Security, and least-privilege database roles.  
**Depends on:** Phase 3  
**Requirements:** REQ-13, REQ-15, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23  

**Plans:**
- [x] Plan 4.1: Relational Schema & Exact Decimal Precision Constraints (`db/migrations/0001` - `0009`)
- [x] Plan 4.2: Stored Procedures & Financial Integrity Routines (`db/migrations/0010` - `0012`, `0018`)
- [x] Plan 4.3: Automated Triggers for Audit Immutability & Record Versioning (`db/migrations/0013`)
- [x] Plan 4.4: Operational Reporting Views & Aggregation Views (`db/migrations/0014`)
- [x] Plan 4.5: Province-Scoped Row-Level Security (RLS) & Role Grants (`db/migrations/0016`, `0017`)
- [x] Plan 4.6: Migration Runner (`db/tools/migrate.py`) & Automated Test Runner (`db/tools/run_tests.py`)
- [x] Plan 4.7: Live PostgreSQL Integration Verification & Database Engineering Report (`docs/DATABASE_ENGINEERING_REPORT.md`)

---

### Phase 5: Enterprise Security Architecture, OWASP ASVS, ISO 27001 & SOC 2 Readiness
**Status:** ✅ Complete  
**Objective:** Deliver production-grade security architecture, ASVS Level 2 verification traceability, ISO/IEC 27001 ISMS mapping, SOC 2 Trust Services Criteria mapping, and Active Directory / SSO enterprise roadmap.  
**Depends on:** Phase 4  
**Requirements:** REQ-13, REQ-17, REQ-22, REQ-23, REQ-24  

**Plans:**
- [x] Plan 5.1: Enterprise Security Architecture & Threat Model (`docs/security/SECURITY_ARCHITECTURE.md`)
- [x] Plan 5.2: OWASP ASVS v4.0.3 Level 2 Verification Traceability Matrix (`docs/compliance/OWASP_ASVS_TRACEABILITY.md`)
- [x] Plan 5.3: ISO/IEC 27001:2022 ISMS Annex A Controls Readiness Document (`docs/compliance/ISO27001_READINESS.md`)
- [x] Plan 5.4: SOC 2 Trust Services Criteria Controls Mapping (`docs/compliance/SOC2_READINESS.md`)
- [x] Plan 5.5: Database Security Review & Least-Privilege Role Split (`docs/DATABASE_SECURITY_REVIEW.md`)
- [x] Plan 5.6: Security Findings & Remediation Risk Register (`docs/SECURITY_FINDINGS.md`)

---

### Phase 6: Quality Assurance Gate, Empirical Verification & Go-Live UAT
**Status:** ✅ Complete  
**Objective:** Execute automated test suites (16 database tests with 482 assertions, frontend build tests, concurrency validation), perform load/performance benchmarking, establish Mari Energies UAT environment test scripts, and complete release gate sign-off.  
**Depends on:** Phase 5  
**Requirements:** All (Full System Verification)  

**Plans:**
- [x] Plan 6.1: Comprehensive Test Runner Verification (`db/tools/run_tests.py` - 482 passing assertions)
- [x] Plan 6.2: High-Volume Concurrency & Race Condition Load Testing (`db/tests/test_07_concurrency.py`)
- [x] Plan 6.3: Playwright E2E Browser Automation & WCAG 2.1 AA Accessibility Audits (22 passing tests)
- [x] Plan 6.4: Full Business Workflow End-to-End Test Harness (`scripts/test_e2e.js` - 35 passing steps)

---

### Phase 7: Production Next.js + Node.js + PostgreSQL Core Stack Implementation
**Status:** ✅ Complete  
**Objective:** Complete native migration of all 30 business screens, RESTful route handlers, connection pooling, and multi-persona session management into Next.js 15 App Router.  
**Depends on:** Phase 6  
**Requirements:** REQ-01 through REQ-23  

**Plans:**
- [x] Plan 7.1: Next.js App Router Structure & Connection Pool (`src/lib/db.ts`)
- [x] Plan 7.2: Server-Side REST Route Handlers (`src/app/api/`)
- [x] Plan 7.3: Enterprise User Interface with Rich Aesthetics & Navigation Shell
- [x] Plan 7.4: Multi-Persona Role Simulation & Cookie-Based Session Management

---

### Phase 8: Reference Data Ingestion, Missing Business Workflows & Enterprise Integrations
**Status:** ✅ Complete  
**Objective:** Address all gaps identified in `.gsd/GAP_ANALYSIS.md`: Ingest 380 landowners and 640 leases from reference CSVs into PostgreSQL, build the 4-tier Land Lease Request Initiation workflow (`Sample Approval Workflow.pdf`), add Lease Renewal reason-based Hold & Release controls, deploy the Active Directory SSO staging simulator, implement the SAP outbox worker, and execute the automated VAPT scanner and backup verification drill.  
**Depends on:** Phase 7  
**Requirements:** REQ-01 through REQ-24 + Business Guidance Slides 10–16  

**Plans:**
- [x] Plan 8.1: Cleanse and Ingest Reference CSV Datasets (380 Landowners, 640 Leases, 450 Renewals, DPFC) into `lms_dev`.
- [x] Plan 8.2: 4-Tier Land Lease Request Initiation & Approval Workflow (Initiator &rarr; Director Ops &rarr; Regional Manager &rarr; DM/TL Land).
- [x] Plan 8.3: Lease Renewal Approval & Reason-Based Hold/Release Controls (`src/app/leases/page.tsx` & `/api/leases/[id]/hold`).
- [x] Plan 8.4: Enterprise Active Directory (ADFS / Entra ID) SSO Staging Simulator & 1-Click Login.
- [x] Plan 8.5: SAP ERP RFC Outbox Background Worker (`scripts/sap_outbox_worker.ts`).
- [x] Plan 8.6: Automated VAPT Security Scanner (`tests/security/vapt_scanner.test.js`) & Point-in-Time Backup Drill.

---

### Phase 9: Executive Decision Intelligence, Advanced Analytics, Land Standardization & GIS Mapping
**Status:** ✅ Complete  
**Objective:** Deliver role-scoped executive dashboards (C-Level, Director, Finance, Operations), 15 decision-oriented analytical reports with CSV and printable statements, Slide 5 authoritative land measurement standardization engine, and interactive GIS cadastral workspace with KML/KMZ upload, Pakistan coordinate validation, visual overlay, and project-level dataset merge.  
**Depends on:** Phase 8  
**Requirements:** Master Implementation Prompt (Executive Decision Intelligence & GIS)  

**Plans:**
- [x] Plan 9.1: Database Engineering & Slide 5 Canonical Measurement Standardization (`db/migrations/0026_decision_intelligence_and_gis.sql` - 11 units, `lms.convert_area()`, `api.v_executive_kpis`, `api.v_project_portfolio`, `api.v_finance_aging`, `api.v_gis_coverage`, `lms.project_kml_import`, `lms.project_spatial_feature`, `lms.project_gis_merge`).
- [x] Plan 9.2: Executive Decision Intelligence Dashboard (`src/app/dashboard/page.tsx` - 4 Audience Switchers: C-Level, Director, Finance, Operations; Dynamic Target Unit Selector with live DB conversion; zero mocks).
- [x] Plan 9.3: 15 Decision-Oriented Analytical Reports (`src/app/reports/page.tsx` - Global Filter Toolbar, CSV Streaming, and Official Printable Statement with Mari Energies branding).
- [x] Plan 9.4: GIS Cadastral Workspace & KML/KMZ Merge Engine (`src/app/gis/page.tsx`, `src/lib/kml.ts`, `src/app/api/gis/kml/route.ts`, `src/app/api/gis/kml/merge/route.ts`).
- [x] Plan 9.5: Mari Energies Corporate Identity & Footprints (Official Mari Energies logo on Header, Login, Reports, Prints, Favicon; "Developed by Alisons Technology" footprints).
- [x] Plan 9.6: Automated Test Suites & Empirical Verification (`tests/unit/measurement_units.test.js`, `tests/integration/analytics_reports.test.js`, `tests/integration/gis_kml.test.js` - 36 automated tests passing).

---

## Progress Summary

| Phase | Description | Status | Plans | Complete |
|:---:|:---|:---:|:---:|:---:|
| **1** | Provincial Revenue & Frontend Shell | ✅ Complete | 3/3 | 100% |
| **2** | Landowner & Cadastral Domain Modules | ✅ Complete | 3/3 | 100% |
| **3** | Acquisition, Leases, ROW & Compensation | ✅ Complete | 5/5 | 100% |
| **4** | PostgreSQL Database Architecture & Integrity | ✅ Complete | 7/7 | 100% |
| **5** | Enterprise Security, ASVS, ISO 27001 & SOC 2 | ✅ Complete | 6/6 | 100% |
| **6** | QA Gate, Benchmarks & Go-Live UAT | ✅ Complete | 4/4 | 100% |
| **7** | Production Next.js Core Stack Implementation | ✅ Complete | 4/4 | 100% |
| **8** | Reference Data Ingestion & Enterprise Integrations | ✅ Complete | 6/6 | 100% |
| **9** | Executive Decision Intelligence & GIS Mapping | ✅ Complete | 6/6 | 100% |

---

## Timeline

| Phase | Started | Completed | Duration | Target Release |
|:---:|:---:|:---:|:---:|:---:|
| 1 | 2026-10-10 | 2026-10-15 | 5 days | v1.1.0 |
| 2 | 2026-10-15 | 2026-10-20 | 5 days | v1.3.0 |
| 3 | 2026-10-20 | 2026-10-24 | 4 days | v1.5.0 |
| 4 | 2026-10-25 | 2026-10-27 | 3 days | v1.6.0 |
| 5 | 2026-10-26 | 2026-10-27 | 2 days | v1.6.0 |
| 6 | 2026-10-27 | 2026-10-28 | 1 day | v1.7.0 |
| 7 | 2026-10-27 | 2026-10-28 | 1 day | v2.0.0 |
| 8 | 2026-10-28 | 2026-10-28 | 1 day | v2.1.0 |
| 9 | 2026-10-28 | 2026-10-28 | 1 day | v2.2.0 (Executive Intelligence & GIS Release) |

---

*Last updated: 2026-10-28*
