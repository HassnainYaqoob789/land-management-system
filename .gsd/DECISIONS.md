# DECISIONS.md — Architecture Decision Records

> **Purpose**: Log significant technical and architectural decisions, their rationale, and consequences for the Mari Energies Land Management System.

---

## Decisions

### [DECISION-001] Dual Build Paradigm: Single-File Demo & Modular Multi-Page App

**Date**: 2026-10-10  
**Status**: Accepted  

#### Context
Field land officers and executive management need to demonstrate and inspect LMS offline in remote concession areas without local web servers or internet access. Simultaneously, production deployment requires strict Content Security Policy (CSP), high performance (~280 KB/page load instead of 2.1 MB), and maintainable modular code.

#### Decision
Maintain two synchronized distributions from a single source of truth:
1. Portable single-file demo (`LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html`) for zero-install offline demos.
2. Modular multi-page application (`app/`) with clean URLs and separate CSS/JS modules.

Both distributions read and write identical schema structures in browser `localStorage`, ensuring data sharing and demo continuity.

#### Rationale
Avoids complex client installation hurdles while guaranteeing an enterprise-grade, CSP-compliant multi-page architecture for web deployment.

#### Consequences
Build pipeline (`build/build.sh`) must remain deterministic, extracting vendor libraries and compiling screen shells automatically.

---

### [DECISION-002] Declarative `data-act` Event Dispatching with Registry Allowlist

**Date**: 2026-10-12  
**Status**: Accepted  

#### Context
The single-file prototype contained 137 inline `onclick` handlers and hundreds of inline `style` attributes. This violates modern enterprise Content Security Policy (disallowing `'unsafe-inline'`) and creates severe XSS attack vectors.

#### Decision
Eliminate all inline handlers. Implement a centralized event delegation router in `app/assets/js/app/actions.js` listening for `click`, `change`, and `input` events on elements with `data-act="functionName"`. Dispatching is restricted strictly to an audited allowlist of 119 functions in `app/assets/js/app/registry.js`.

#### Rationale
Enables running the multi-page application under `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'`. Prevents unauthorized script execution.

#### Consequences
Any newly added UI action must be explicitly registered in `registry.js`.

---

### [DECISION-003] Provincial Revenue Systems & Exact Fractional *Hissa-dari* Math

**Date**: 2026-10-15  
**Status**: Accepted  

#### Context
Land revenue administration differs fundamentally across Sindh, Balochistan, Punjab, and KP (e.g. Acre/Jireb/Ghunta vs. Acre/Kanal/Marla). In addition, compensation disputes frequently arise when co-ownership percentages (*Hissa-dari*) do not total 100%, leading to fraudulent claims or duplicate disbursements.

#### Decision
1. Dynamically adapt administrative levels and measurement units based on the selected province.
2. Enforce mathematical validation that the sum of all co-owner shares in any cadastral parcel equals exactly **100.0%** before any compensation case or lease agreement can be approved.
3. Use exact decimal math (`numeric(18,4)` in PostgreSQL and decimal-safe handling in JS) to eliminate floating-point rounding errors.

#### Rationale
Prevents financial leakage, guarantees legal compliance with provincial land revenue records, and eliminates disputes over unallocated parcel fractions.

#### Consequences
Users cannot submit compensation cases for partially allocated parcels; 100% allocation is strictly required.

---

### [DECISION-004] Non-Destructive Record Versioning & Tamper-Evident Audit Trail

**Date**: 2026-10-18  
**Status**: Accepted  

#### Context
Regulatory audits, legal inquiries, and corporate governance require a complete, unalterable history of all land transactions, agreements, compensation payments, and approvals.

#### Decision
1. Implement non-destructive record versioning: every approved modification spawns a new record version linked to the parent record without overwriting historical data.
2. Implement an append-only audit trail capturing user identity, timestamp, IP context, stage transition, and field-level delta.
3. In PostgreSQL, enforce immutability triggers that abort any `UPDATE` or `DELETE` operations on audit tables by runtime application roles.

#### Rationale
Guarantees evidentiary integrity for court disputes, anti-corruption inquiries, and external SOC 2 examinations.

#### Consequences
Storage footprint increases linearly with changes; historical record viewing requires version traversal UI.

---

### [DECISION-005] 6-Tier Segregation of Duties (SoD) Approval Hierarchy

**Date**: 2026-10-20  
**Status**: Accepted  

#### Context
Single-user approvals in land compensation create extreme fraud risks, including phantom landowner payments and inflated crop/tree compensation rates.

#### Decision
Enforce a rigid, designation-based 6-tier sequential approval workflow:
$$\text{Field Officer (Creation)} \longrightarrow \text{Negotiation Lead} \longrightarrow \text{Legal Clearance} \longrightarrow \text{Sr. Admin (Field)} \longrightarrow \text{Manager Land (HO)} \longrightarrow \text{Finance (Voucher Release)}$$
Each stage enforces strict designation checks, mandatory remarks on return/escalation, and validation against project land budgets.

#### Rationale
Ensures no single actor can create and disburse funds. Implements full checks and balances across operational, legal, administrative, executive, and financial functions.

#### Consequences
Transactions require multi-party coordination; workflow escalation rules are implemented to avoid approval bottlenecks.

---

### [DECISION-006] PostgreSQL 16 as Enterprise Authoritative System of Record

**Date**: 2026-10-24  
**Status**: Accepted  

#### Context
While client-side `localStorage` provides excellent agility for demonstrations, production operations demand multi-user concurrency, ACID transactions, data consistency, and enterprise durability.

#### Decision
Design and implement PostgreSQL 16 as the authoritative system of record across 18 versioned, forward-only migrations. Enforce constraints, business rules, and financial balances directly in the database using foreign keys, check constraints, stored procedures, triggers, and views.

#### Rationale
The database acts as an independently secured barrier protecting corporate assets, even if an upstream application service is compromised or misconfigured.

#### Consequences
Requires database migration management (`db/tools/migrate.py`) and disciplined version control for all database routines.

---

### [DECISION-007] Province-Scoped Row-Level Security (RLS) & Least-Privilege Role Split

**Date**: 2026-10-25  
**Status**: Accepted  

#### Context
Mari Energies operations span four provinces with independent field offices. Field staff in Sindh must not access or modify land records in Balochistan or Punjab unless authorized. Furthermore, running applications as a database superuser creates critical security vulnerabilities.

#### Decision
1. Configure Row-Level Security (RLS) policies filtering records based on `app_user.province` context.
2. Split database privileges into distinct functional roles:
   - `lms_owner`: Schema owner (DDL, migrations).
   - `lms_migrator`: Executes forward migrations.
   - `lms_app`: Runtime DML (`SELECT`, `INSERT`, `UPDATE`) with no DDL rights and blocked audit modification.
   - `lms_readonly`: Read-only reporting access.
   - `lms_audit`: Dedicated auditor review role.

#### Rationale
Adheres to zero-trust principles and least privilege; eliminates cross-provincial data leakage and privilege escalation.

#### Consequences
Application connection pools must establish authenticated user context on checkout.

---

### [DECISION-008] Air-Gapped Zero-CDN Vendor Dependency

**Date**: 2026-10-26  
**Status**: Accepted  

#### Context
Energy infrastructure systems operate in remote locations with intermittent connectivity and must comply with critical infrastructure cybersecurity standards prohibiting reliance on external third-party CDN assets.

#### Decision
Vendor all third-party libraries locally within `app/assets/js/vendor/` and `app/assets/css/vendor/` (MapLibre GL, Chart.js, jsPDF, SheetJS, JSZip).

#### Rationale
Guarantees 100% offline operational capability, protects against supply-chain attacks via compromised CDNs, and satisfies corporate cybersecurity procurement mandates.

#### Consequences
Vendored library upgrades must be performed through reviewed build scripts.

---

### [DECISION-009] Integrated Reusable Skill-Driven GSD Engineering Process & Multi-Layer Release Gates

**Date**: 2026-10-28  
**Status**: Accepted  

#### Context
Complex enterprise land management requirements demand rigorous, repeatable engineering governance spanning domain calculations, data integrity, security controls, accessibility, and financial reconciliations.

#### Decision
Establish 9 task-specific reusable agent skills in `.agents/skills/` and formalize 7 empirical release gates in `.gsd/RELEASE_GATES.md`. Release readiness requires 100% green execution across the automated testing pyramid (unit, security integration, business E2E, Playwright accessibility, and PostgreSQL schema invariants).

#### Rationale
Eliminates hallucinated completion claims and ensures every functional capability is backed by verifiable code and database proof.

#### Consequences
Builds cannot be declared production-ready without passing all 7 gates.

---

### [DECISION-010] Reference CSV Data Cleansing & Automated Ingestion Pipeline

**Date**: 2026-10-28  
**Status**: Accepted  

#### Context
The supplied reference CSV package contains 412 real landowners, 648 leases, renewals, and DPFC government land records. However, raw data contains inconsistencies: synthetic duplicate CNICs, 1-day identical lease start/end dates, and unaggregated damage categories.

#### Decision
Implement an automated TypeScript/SQL data cleansing and ingestion engine (`scripts/ingest_reference_data.ts`). Normalize landowners to unique NADRA CNICs, enforce start/end date constraints on leases, compute projected annual escalations, and populate the authoritative PostgreSQL database.

#### Rationale
Allows testing, reporting, and operational demonstration against the full volume of real client data rather than small synthetic fixtures.

#### Consequences
Data anomalies must be flagged in reconciliation exception tables for business review.

---

### [DECISION-011] Enterprise Active Directory (ADFS / Entra ID) SSO Staging Simulator

**Date**: 2026-10-28  
**Status**: Accepted  

#### Context
Mari Energies corporate IT requires Single Sign-On via Active Directory (ADFS / Microsoft Entra ID). However, corporate tenant credentials and federation metadata are typically unavailable during vendor demonstration and early UAT environments.

#### Decision
Provide a dual-mode SSO architecture:
1. Production SAML 2.0 / OIDC connector reading environment variables (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`).
2. Integrated SSO Staging Simulator on the login page allowing reviewers to select any of the 10 E&P user personas and execute a simulated SAML assertion callback with instant authenticated session generation.

#### Rationale
Enables immediate end-to-end evaluation of corporate authentication workflows without waiting for external IT infrastructure provisioning.

#### Consequences
Simulator must be deactivated in production via `SSO_SIMULATOR_ENABLED=false`.

---

### [DECISION-012] SAP ERP Integration Outbox Worker & Idempotent BAPI Document Posting

**Date**: 2026-10-28  
**Status**: Accepted  

#### Context
Financial disbursements must synchronize with Mari Energies SAP ERP General Ledger. Direct synchronous API calls to SAP during user requests introduce network latency, failure points, and double-posting risks.

#### Decision
Implement the Transactional Outbox pattern:
1. When Manager Land authorizes a payment release, an event payload is written atomically to `lms.integration_outbox` within the database transaction.
2. An asynchronous background worker (`scripts/sap_outbox_worker.ts`) polls the outbox, posts BAPI accounting documents (`BAPI_ACC_DOCUMENT_POST`), captures SAP document numbers (`BELNR`, `BUKRS`, `GJAHR`), and marks the record `SYNCHRONIZED`.

#### Rationale
Guarantees at-least-once delivery, eliminates payment lost-updates, and isolates LMS application uptime from SAP maintenance windows.

#### Consequences
Requires a resilient background runner or scheduled cron process.

---

*Last updated: 2026-10-28*
