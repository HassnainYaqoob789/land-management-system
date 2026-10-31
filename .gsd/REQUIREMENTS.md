---
milestone: Mari Energies LMS Enterprise Release
updated: 2026-10-27T21:55:00Z
---

# Requirements — Land Management System (LMS)

## Overview

Comprehensive formal requirements derived from `requirments/lms_project_analysis.md`, `requirments/prompt.md`, `requirments/email.txt`, reference datasets, and provincial statutory frameworks for strict end-to-end traceability and coverage tracking.

---

## Functional Requirements

| ID | Requirement Description | Source | Phase | Status |
|:---|:---|:---|:---:|:---:|
| **REQ-01** | Multi-Provincial Administrative Hierarchy Master (Sindh: District/Taluka/Deh; Punjab: District/Tehsil/Qanungo/Mouza; Balochistan: District/Sub-Div/Tehsil/Mouza; KPK: District/Tehsil/Mouza). | SPEC Goal 2, SoR Sc 9–11 | 1 | Complete |
| **REQ-02** | Centralized Land Measurement Unit Conversion Engine (Acre, Kanal, Marla, Ghunta, Jireb, Bigha, Rod, Pole, Sq Feet, Sq Yards, Hectares). | SPEC Goal 2, Measurement Ref | 1 | Complete |
| **REQ-03** | Master Landowner Registry with strict unique constraint on CNIC (`XXXXX-XXXXXXX-X`) across all concession blocks. | SPEC Goal 1, Email Sec 1 | 2 | Complete |
| **REQ-04** | Fractional Co-Ownership Share Validation: mathematical enforcement that co-owner shares (*Hissa-dari*) on any survey parcel total exactly 100.0%. | SPEC Goal 1, Email Sec 3 | 2 | Complete |
| **REQ-05** | Deceased Landowner Guardrails: automatic disbursement freeze on deceased owners with mandatory succession (*Wirasat / Intiqal*) mutation workflow. | SPEC Goal 1, Analysis Sec 3 | 2 | Complete |
| **REQ-06** | Statutory Land Acquisition Act 1894 Lifecycle Tracking (Section 4 preliminary notice, Section 6 declaration, Section 9 claims, Section 11 award). | SPEC Goal 1, Analysis Sec 4 | 3 | Partial |
| **REQ-07** | Surface Well Leases: contract term management, annual escalation formulas, expiry alerts, and reason-based lease holds. | SPEC Goal 3, Email Sec 3 | 3 | Complete |
| **REQ-08** | Right-of-Way (ROW) Linear Corridors & Flowlines: pipeline width/length calculation, crop clearance, and permanent/temporary damage logs. | SPEC Goal 3, Email Sec 3 | 3 | Complete |
| **REQ-09** | Sindh Government Land Reservation & DBPFC (District Base Price Fixing Committee) pricing approvals, payment holds, and DC releases. | SPEC Goal 3, Email Sec 4 | 3 | Complete |
| **REQ-10** | Comprehensive Compensation Case Engine covering Crop damages, Tree felling, Land value, Structures, Flare Pits, and 50% Past Pending Balances. | SPEC Goal 3, Workflow Refs | 3 | Complete |
| **REQ-11** | Segregation of Duties (SoD) 6-Tier Designation Approval Hierarchy: Field Officer → Negotiation Lead → Legal → Sr. Admin → Manager Land → Finance. | SPEC Goal 3, Email Sec 3 | 3 | Complete |
| **REQ-12** | Non-Destructive Record Versioning: all approved or submitted modifications spawn a new version linked to parent; historical data is never overwritten. | SPEC Goal 3, Email Sec 2 | 3 | Complete |
| **REQ-13** | Tamper-Evident Append-Only Audit Trail logging user ID, timestamp, IP context, stage transitions, and field-level diffs. | SPEC Goal 3, Prompt Sec 4.3 | 4 | Complete |
| **REQ-14** | Automated FBR Withholding Tax (WHT) Engine: distinguishing between verified Filers (standard rate) and Non-Filers (2x penalty withholding rate). | SPEC Goal 3, Analysis Sec 3 | 3 | Complete |
| **REQ-15** | Duplicate Payment Prevention: unique business keys, concurrency row locking, and financial liability reconciliation routines. | SPEC Goal 5, Prompt Sec 4.6 | 4 | Complete |
| **REQ-16** | Geospatial Cadastral Engine (MapLibre GL): vector maps, satellite imagery, KMZ/KML ingestion, parcel boundary visual correlation. | SPEC Goal 4, Analysis Sec 3 | 2 | Complete |
| **REQ-17** | Strict Content Security Policy (`script-src 'self'`) eliminating inline event handlers and eval. | SPEC Goal 4, README Line 45 | 1 | Superseded → Complete |
| **REQ-18** | Declarative `data-act` Event Routing Engine via static allowlist registry (`app/assets/js/app/registry.js`). | SPEC Goal 4, README Line 90 | 1 | Superseded |
| **REQ-19** | Authoritative PostgreSQL 16 Relational Schema with 18 versioned, forward-only migrations. | SPEC Goal 5, Prompt Sec 4.1 | 4 | Complete |
| **REQ-20** | PostgreSQL Stored Procedures & Routines for share validation, unit conversion, compensation transitions, and financial reconciliation. | SPEC Goal 5, Prompt Sec 4.2 | 4 | Complete |
| **REQ-21** | Database Triggers for append-only audit enforcement, record version bumping, and cross-table financial consistency. | SPEC Goal 5, Prompt Sec 4.3 | 4 | Complete |
| **REQ-22** | Province-Scoped Row-Level Security (RLS) policies for strict administrative data isolation. | SPEC Goal 5, Prompt Sec 4.7 | 4 | Complete |
| **REQ-23** | Least-Privilege Database Roles (`lms_owner`, `lms_migrator`, `lms_app`, `lms_readonly`, `lms_audit`). | SPEC Goal 5, Prompt Sec 4.7 | 4 | Complete |
| **REQ-24** | Enterprise Compliance Traceability (OWASP ASVS v4.0.3 L2, ISO 27001:2022 ISMS, SOC 2 Trust Services Criteria). | SPEC Goal 6, Prompt Sec New Phase | 5 | Complete |

---

## Non-Functional Requirements

| ID | Requirement Description | Category | Phase | Status |
|:---|:---|:---|:---:|:---:|
| **NFR-01** | High Performance Page Weight: initial modular page payload must remain ≤ 280 KB before dynamic on-demand library loading. | Performance | 1 | Complete |
| **NFR-02** | Zero Floating-Point Financials: exact `numeric(18,4)` representation across all database calculations, monetary sums, areas, and shares. | Data Integrity | 4 | Complete |
| **NFR-03** | Zero Server-Side Demo Dependency: standalone offline operation supported via browser `localStorage` and single-file portable build. | Portability | 1 | Not applicable |
| **NFR-04** | Air-Gapped Security: zero external CDN scripts; all vendor libraries (Chart.js, MapLibre GL, jsPDF, XLSX, JSZip) vendored locally. | Security | 1 | Partial |
| **NFR-05** | Database Query Latency: sub-100ms response on critical operational queries through partial, composite, and GIN indexing. | Performance | 4 | Partial |
| **NFR-06** | Session Isolation: multi-tab role simulation using `sessionStorage` for user identities while maintaining shared `localStorage` records. | Usability | 1 | Superseded |
| **NFR-07** | Non-Destructive Migrations: forward-only versioned migrations wrapped in atomic transactions with checksum drift detection. | Reliability | 4 | Complete |
| **NFR-08** | Audit Log Immutability: database-level triggers blocking `UPDATE` and `DELETE` statements on audit tables by runtime application roles. | Security | 4 | Complete |
| **NFR-09** | Responsive Design: mobile and tablet touch-accessible UI across all 30 screens with dedicated print stylesheets for official revenue forms. | UX / A11y | 1 | Complete |
| **NFR-10** | Enterprise SSO Integration Architecture: Microsoft Active Directory / Entra ID SAML 2.0 / OIDC federation roadmap. | Architecture | 5 | Not implemented |

---

## Constraints

| ID | Constraint Description | Source | Impact |
|:---|:---|:---|:---|
| **CON-01** | Land Acquisition Act 1894 Statutory Workflow | Statutory / Legal | Strict sequential dependencies across Sections 4, 6, 9, 11 |
| **CON-02** | Four Heterogeneous Provincial Land Revenue Systems | Provincial Governance | Divergent administrative levels, terminology, and cadastral keys |
| **CON-03** | FBR Withholding Tax Regulations (Filers vs. Non-Filers) | Federal Tax Law | Dynamic WHT rates and mandatory withholding tax accounting |
| **CON-04** | Dual Build Synchronization (Single File vs. Modular Web App) | Operational Reality | Shared storage schema; single source of truth extraction pipeline |
| **CON-05** | Strict Content Security Policy (No 'unsafe-inline', No 'unsafe-eval') | Enterprise Security | Precludes all inline styles and script execution |

---

## Traceability Matrix (verified 2026-10-29)

Supersedes the earlier matrix, which pointed at the static prototype (`app/`,
now `legacy-demo/`) rather than the application. Every row names the code that
implements the requirement in the Next.js + PostgreSQL build and the test that
was run against it on 2026-10-29 (results: `docs/reports/RELEASE_ASSESSMENT_2026-10-29.md`).

| Req | Status | Implementation | Verified by |
|:---|:---|:---|:---|
| REQ-01 Provincial hierarchy | Complete | `0002_reference_and_org.sql`, `/api/units`, `/province` | db test_01; legacy_design (Province screen) |
| REQ-02 Unit conversion | Complete | `lms.convert_area` (0010, 0030), `/api/units`, `/units` | tests/unit/measurement_units; business_rules "unit catalogue" |
| REQ-03 CNIC master key | Complete | `landowner_cnic_key`, `isValidCNIC`, `/api/landowners` | db test_01; tests/unit/domain |
| REQ-04 Shares total 100% | Complete | deferred share-total triggers (0013), CaseForm / ShareBalancer | db test_13; workflows "compensation cases" (90% refused) |
| REQ-05 Deceased owner lock | Complete | 0007 triggers, `api.apply_mutation` | business_rules "deceased landowner"; workflows "mutation" |
| REQ-06 LAA 1894 lifecycle | **Partial** | acquisition mode "LAA 1894 Acquisition"; legal case types Sec. 18 / 30 | workflows "acquisition". Section 4/6/9/11 milestones are named in the analysis document but not modelled in the reference HTML or the schema — **needs a business decision** |
| REQ-07 Leases, escalation, alerts, holds | Complete | `/api/leases`, lease hold/renew routes, `v_lease_expiry_alert` | business_rules "lease on hold"; legacy_design (Leases) |
| REQ-08 ROW corridors | Complete | `/api/rows`, length × width area | workflows "ROW" |
| REQ-09 DBPFC | Complete | `/api/dbpfc`, rate history (0033) | workflows "DBPFC" |
| REQ-10 Compensation case engine | Complete | `CaseForm`, `writeCaseLines`, `api.recalculate_case_totals`, report r6 | workflows "compensation cases"; user_journeys case journey |
| REQ-11 SoD approval hierarchy | Complete | `api.advance_workflow`, `workflow_step_group`, `api.set_step_groups` (0034) | workflows (one person per step), business_rules SoD, user_journeys (preparer refused) |
| REQ-12 Record versioning | Complete | `audit.record_version`, `api.v_record_version_history` (0032) | db test_03 |
| REQ-13 Append-only audit | Complete | `audit.audit_event`, `audit.auth_event` (now incl. report exports) | db test_08; business_rules "export is recorded" |
| REQ-14 WHT filer / non-filer | **Complete (2026-10-29)** | 0035/0037 `api.request_payment` | db test_04; workflows "withholding tax" |
| REQ-15 Duplicate payment prevention | Complete | `payment_no_duplicate_live_uq`, idempotency keys | db test_04, test_07; workflows payments |
| REQ-16 GIS, KML/KMZ, imagery | Complete | `/gis` (OSM streets + Esri satellite, added 2026-10-29), `src/lib/kml.ts` (KML/KMZ, XXE refused) | tests/integration/gis_kml; business_rules "KML features" |
| REQ-17 Strict CSP | Complete (new form) | nonce CSP, `src/middleware.ts` / `src/lib/csp.ts` | security_headers.test; Playwright screen sweep fails on CSP violations |
| REQ-18 `data-act` routing | Superseded | applied to the static prototype; the React application has no inline handlers | — |
| REQ-19 Versioned migrations | Complete | 38 forward-only migrations, checksum drift check | `migrate.py verify` (0 drift on lms_dev, lms_iam_test, lms_perf) |
| REQ-20 Routines | Complete | `api.*` routines | db test_02, test_04 |
| REQ-21 Triggers | Complete | 0013 | db test_03 |
| REQ-22 Province RLS | Complete | 0016, evaluated once per statement since 0036 | db test_05, test_06; documents test (404 outside province) |
| REQ-23 Least-privilege roles | Complete | bootstrap roles, 0017/0029 grants | db test_10 |
| REQ-24 Compliance traceability | Complete (documents) | `docs/compliance/OWASP_ASVS_TRACEABILITY.md`, ISO/SOC2 readiness | document review only |
| NFR-01 Page weight | Complete | first-load JS 103–120 kB per route (`next build`) | build output |
| NFR-02 Exact money | Complete | `numeric` domains, generated WHT/net columns | db test_04 (rounding at the paisa) |
| NFR-03 Offline single file | Not applicable | a property of the static prototype | — |
| NFR-04 No external CDN | Partial | all scripts self-hosted (CSP `'self'` + nonce); map tiles come from OSM / Esri | security_headers.test |
| NFR-05 Query latency < 100 ms | Partial | measured at volume: single-user list APIs 50–370 ms, KPIs ~560 ms (see release assessment) | scripts/perf/load_test.mjs |
| NFR-06 Session-storage role simulation | Superseded | real accounts and sessions (IAM) | tests/iam |
| NFR-07 Safe migrations | Complete | transactional, checksummed | db test_16 |
| NFR-08 Audit immutability | Complete | triggers refuse UPDATE/DELETE | db test_08 |
| NFR-09 Responsive and print | Complete | legacy design system | legacy_design (desktop + mobile), axe |
| NFR-10 SSO (AD / Entra ID) | **Not implemented** | simulator disabled in production (APP-07); LDAP/OIDC/WebAuthn not built | auth.test (simulator refused) |
