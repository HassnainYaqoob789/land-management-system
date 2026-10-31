# SPEC.md — Project Specification

> **Status**: `FINALIZED`
>
> ⚠️ **Planning Lock**: UNLOCKED. Requirements and boundaries are formally verified against Mari Energies Limited project documentation, reference datasets, and provincial land revenue frameworks.

---

## Vision

The **Land Management System (LMS)** is an enterprise, domain-tailored digital platform purpose-built for **Mari Energies Limited** (and peer Pakistani Exploration & Production energy operators, e.g., OGDCL, PPL) to administer the end-to-end lifecycle of land operations across all four Pakistani provinces: **Sindh (SND)**, **Balochistan (BAL)**, **Punjab (PNJ)**, and **Khyber Pakhtunkhwa (KPK)**.

The system digitizes and governs:
1. Concession, block, and wellsite exploration requests (e.g. Daharki D&PL).
2. Cadastral mapping, survey parcels, and verified landowner master data.
3. Statutory land acquisitions under the *Land Acquisition Act 1894* (Sections 4, 6, 9, 11).
4. Long-term surface well leases, annual rent escalations, and expiry renewals.
5. Right-of-Way (ROW) linear corridors for pipelines and flowlines.
6. Multi-provincial compensation disbursements (crop damage, tree cutting, land value, immovable structures, flare pit damages, and historical 50% past pending balance payments).
7. Sindh Government Land reservations and District Base Price Fixing Committee (DBPFC) price approvals and holds.
8. Interactive geospatial intelligence (GIS vector mapping, KML/KMZ pipeline and boundary ingestion).
9. Segregation of Duties (SoD) multi-tier approval governance, tamper-evident audit trails, and non-destructive record versioning.
10. Authoritative enterprise persistence via PostgreSQL 16 with in-database integrity controls, row-level security (RLS), and least-privilege role separation.
11. Production Full-Stack Technology Stack: Next.js App Router (Frontend), Node.js runtime (Backend API), and PostgreSQL 16 (Database System of Record). The legacy Python/HTML files serve strictly as reference prototypes.

---

## Goals

1. **Elimination of Fraud, Ghost Payments & Duplicate Claims**
   - Enforce Computerized National Identity Cards (CNIC: `XXXXX-XXXXXXX-X`) as the immutable master key for all landowners across blocks.
   - Enforce exact mathematical fractional share balancing (*Hissa-dari*): the sum of co-ownership shares in any parcel must total exactly **100.0%** before compensation can be approved or disbursed.
   - Enforce automated disbursement freezes on deceased landowners, mandating legal succession (*Wirasat / Intiqal*) mutations.

2. **Multi-Provincial Cadastral & Measurement Unit Engine**
   - Dynamically adapt administrative hierarchies and revenue terminology to the selected province:
     - **Sindh**: District → Taluka → Deh (Survey No. & Block No.). Units: Acre, Jireb (1/2 Acre), Ghunta (1/40 Acre).
     - **Balochistan**: District → Sub-Division → Tehsil → Sub-Tehsil / Qanungo Halka → Mouza (Khasra No.). Units: Acre, Rod (1/4 Acre), Pole (1/160 Acre).
     - **Punjab**: District → Tehsil → Qanungo Halka → Mouza (Khasra No.). Units: Acre, Kanal (1/8 Acre), Marla (1/160 Acre / 1/20 Kanal).
     - **Khyber Pakhtunkhwa**: District → Sub-Division → Tehsil → Mouza (Khasra No. / Survey No.). Units: Acre, Kanal (1/8 Acre), Bigha (1/2 Acre = 4 Kanals).
   - Maintain exact numeric conversions without floating-point precision loss.

3. **End-to-End Governance & Segregation of Duties (SoD)**
   - Enforce multi-tier role authorization for all financial compensation and lease approvals:
     $$\text{Field Officer (Creation)} \longrightarrow \text{Negotiation Lead} \longrightarrow \text{Legal Clearance} \longrightarrow \text{Sr. Admin (Field)} \longrightarrow \text{Manager Land (HO)} \longrightarrow \text{Finance (Voucher Release)}$$
   - Implement non-destructive record versioning: any approved change spawns a new version linked to the parent without altering historical state.
   - Maintain a tamper-evident, append-only audit trail capturing user identity, timestamp, IP context, action, and field-level delta.
   - Automate tax compliance: calculate Federal Board of Revenue (FBR) Withholding Tax (WHT) rates distinguishing between registered Filers (standard rate) and Non-Filers (2x penalty rate).

4. **Dual Build Architecture with Strict Content Security Policy**
   - Provide a zero-install, portable single-file distribution (`LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html`) for offline demonstration and field-level review.
   - Provide a modular multi-page application (`app/`) loading ~280 KB per page under a strict Content Security Policy (`script-src 'self'`, no `'unsafe-inline'`, no `eval()`), replacing inline event handlers with declarative `data-act` routing through a verified function allowlist registry.

5. **PostgreSQL Enterprise System of Record**
   - Provide an authoritative relational schema across 18 versioned SQL migrations enforcing primary keys, foreign keys, `CHECK` constraints, and exact `numeric(18,4)` types for currency, areas, and shares.
   - Implement stored procedures and functions for financial reconciliation, duplicate prevention, and workflow transitions.
   - Implement database triggers for immutable audit logging, version bumping, and share sum validation.
   - Implement Row-Level Security (RLS) for province-scoped data isolation.
   - Implement least-privilege database roles (`lms_owner`, `lms_migrator`, `lms_app`, `lms_readonly`, `lms_audit`).

6. **Enterprise Security & Compliance Readiness**
   - Align controls with OWASP Application Security Verification Standard (ASVS v4.0.3) Level 2.
   - Prepare technical evidence mapping to ISO/IEC 27001:2022 Annex A controls (ISMS).
   - Map technical safeguards to SOC 2 Trust Services Criteria (Security, Confidentiality, Availability, Processing Integrity).
   - Document Active Directory (AD) and Single Sign-On (SSO) integration architecture.

---

## Non-Goals (Out of Scope)

- **Direct Banking / Core Financial System Replacement**: LMS generates approved payment vouchers, withholding tax statements, and reconciliation logs; it does not directly operate bank clearing interfaces (e.g. SWIFT or 1LINK RTGS).
- **Public Open-Data Portal**: LMS is strictly an internal, authorized-access enterprise system; public access without authentication is prohibited.
- **Arbitrary Dynamic Code Execution**: No user or administrator may execute ad-hoc scripts or arbitrary client-supplied SQL in the system.
- **External CDN Dependency**: All core runtime libraries (MapLibre GL, Chart.js, jsPDF, SheetJS, JSZip) are vendored locally to guarantee offline operational capability and air-gapped security.

---

## Constraints

- **Regulatory & Statutory Compliance**:
  - Pakistani *Land Acquisition Act 1894* procedural stages (Sections 4, 6, 9, 11).
  - Provincial Land Revenue Acts (Sindh Land Revenue Act 1967, Punjab Land Revenue Act 1967, Balochistan Land Revenue Act 1967, KP Land Revenue Act 1967).
  - FBR Income Tax Ordinance 2001 (Section 150/152/236A Withholding Tax).
- **Zero Floating-Point Financials**:
  - All currency calculations (Pakistani Rupees PKR), land measurements (Square Feet / Acres / Kanals), and fractional ownership percentages must use exact decimal arithmetic (`numeric(18,4)` in PostgreSQL, integer paisas or decimal-safe math in JavaScript).
- **Dual Build Parity**:
  - The multi-page modular build (`app/`) and single-file build must read and write identical schema keys in `localStorage` to ensure full interoperability.

---

## Success Criteria

- [x] **Provincial Hierarchy Engine Verified**: Sindh (Taluka/Deh), Punjab (Tehsil/Qanungo/Mouza), Balochistan (Sub-Div/Tehsil/Mouza), KP (Tehsil/Mouza) correctly configured with native measurement units.
- [x] **CNIC & Hissa-dari Validation Active**: Strict CNIC uniqueness enforced; fractional co-ownership shares validated to sum to exactly 100.0%.
- [x] **Approval Governance Verified**: 6-tier workflow successfully transitions cases through Field Officer, Negotiation Lead, Legal Clearance, Sr. Admin, Manager Land, and Finance.
- [x] **Strict CSP & Event Dispatching**: Zero inline script tags; all 138 actions routed via `data-act` and registry allowlist.
- [x] **PostgreSQL 16 Relational Schema Implemented**: 18 migrations applied, stored procedures compiled, triggers active, views verified, RLS policies tested.
- [x] **Complete Compliance Documentation**: Architecture, ASVS traceability, ISO 27001 readiness, SOC 2 readiness, and database review documents published in `docs/`.

---

## User Stories

### As a Field Land Officer
- I want to register cadastral survey parcels, landowner CNICs, and ownership percentages (*Hissa-dari*) in the field.
- So that I can initiate verified compensation and lease requests with accurate provincial measurement units.

### As a Negotiation Lead
- I want to record landowner negotiation agreements, crop damages, and tree counts against approved rates.
- So that compensation amounts are automatically calculated and ready for legal scrutiny.

### As a Legal Clearance Officer
- I want to review title documents, succession certificates (*Wirasat*), and court disputes (*Stays / Litigations*).
- So that Mari Energies does not disburse payments to disputing parties or deceased owners.

### As Senior Administration & Manager Land (Head Office)
- I want to review project-wise land budgets, lease renewal schedules, and DBPFC Sindh government land pricing.
- So that land acquisitions and lease commitments comply with corporate governance and budget caps.

### As a Finance Officer
- I want to generate verified payment vouchers with automated FBR WHT deductions (Filer vs. Non-Filer) and prevent duplicate payment releases.
- So that financial disbursements reconcile 100% with underlying cases and collector awards.

---

## Technical Requirements

| ID | Requirement | Category | Priority | Source Reference |
|----|-------------|----------|----------|------------------|
| REQ-01 | Provincial Revenue Hierarchies (SND, BAL, PNJ, KPK) | Functional | Must-have | `requirments/lms_project_analysis.md`, PPTX |
| REQ-02 | Land Measurement Unit Converter (Acre/Kanal/Marla/Ghunta/Jireb/Pole) | Functional | Must-have | `requirments/Measurement Units.jpg` |
| REQ-03 | CNIC Master Key & Uniqueness Enforcement | Data Integrity | Must-have | `requirments/email.txt` Sec 1 & 3 |
| REQ-04 | Mathematical Co-Ownership Balance (Sum = 100.0%) | Data Integrity | Must-have | `requirments/email.txt` Sec 3 |
| REQ-05 | Deceased Landowner Guardrails & Succession Mutation | Workflow | Must-have | `requirments/lms_project_analysis.md` |
| REQ-06 | Statutory Land Acquisition Act 1894 (Sec 4, 6, 9, 11) | Regulatory | Must-have | `requirments/lms_project_analysis.md` |
| REQ-07 | Well Leases, Renewal Schedules & Annual Escalation | Functional | Must-have | `requirments/email.txt` Sec 3 |
| REQ-08 | Right-of-Way (ROW) Corridors & Flowlines | Geospatial | Must-have | `requirments/email.txt` Sec 3 |
| REQ-09 | Sindh Government Land & DBPFC Reservation & Holds | Financial/Gov | Must-have | `requirments/email.txt` Sec 4 |
| REQ-10 | Compensation Cases (Crop, Tree, Land, Structure, Flare Pit, 50% Balance) | Functional | Must-have | `requirments/Workflow references.zip` |
| REQ-11 | Multi-Tier Designation Approval Hierarchy (6 Tiers) | Security/Gov | Must-have | `requirments/email.txt` Sec 3 |
| REQ-12 | Non-Destructive Record Versioning | Audit | Must-have | `requirments/email.txt` Sec 2 |
| REQ-13 | Append-Only Immutable Audit Trail | Audit | Must-have | `requirments/prompt.md` Sec 4.3 |
| REQ-14 | FBR Tax Withholding (Filers vs. Non-Filers 2x Rate) | Financial | Must-have | `requirments/lms_project_analysis.md` |
| REQ-15 | Duplicate Payment Prevention & Reconciliation | Financial | Must-have | `requirments/prompt.md` Sec 4.6 |
| REQ-16 | MapLibre GL Vector Map Engine & KML/KMZ Ingestion | GIS | Must-have | `requirments/lms_project_analysis.md` |
| REQ-17 | Strict Content Security Policy (`script-src 'self'`) | AppSec | Must-have | `README.md` Line 45 |
| REQ-18 | Declarative `data-act` Event Dispatching & Allowlist | Architecture | Must-have | `app/assets/js/app/registry.js` |
| REQ-19 | PostgreSQL 16 Normalized Schema (18 Migrations) | Database | Must-have | `requirments/prompt.md` Sec 4.1 |
| REQ-20 | PostgreSQL Stored Procedures & Financial Routines | Database | Must-have | `requirments/prompt.md` Sec 4.2 |
| REQ-21 | PostgreSQL Triggers for Immutability & Cross-Table Checks | Database | Must-have | `requirments/prompt.md` Sec 4.3 |
| REQ-22 | Province-Scoped Row-Level Security (RLS) | Database | Must-have | `requirments/prompt.md` Sec 4.7 |
| REQ-23 | Least-Privilege Database Roles & Grants | Security | Must-have | `requirments/prompt.md` Sec 4.7 |
| REQ-24 | OWASP ASVS L2, ISO 27001 & SOC 2 Compliance Documentation | Compliance | Must-have | `requirments/prompt.md` Sec New Phase |

---

*Last updated: 2026-10-27*
