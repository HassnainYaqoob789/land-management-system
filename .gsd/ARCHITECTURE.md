# Architecture — Land Management System (LMS)

> Authoritative System Architecture for Mari Energies Limited E&P Land Management System (v1.6.0)

---

## Overview

The **Land Management System (LMS)** employs a resilient, hybrid architecture designed for both high-assurance enterprise operation and zero-dependency field demonstration:
1. **Presentation & Application Layer**: High-performance multi-page web architecture (~280 KB/page) enforcing strict Content Security Policy (`script-src 'self'`), event delegation via declarative `data-act` attributes, and localized client-side simulation.
2. **Authoritative Persistence Layer**: Production-grade PostgreSQL 16 database enforcing rigorous constraints, stored procedures for financial math and duplicate prevention, automated triggers for immutable auditing, province-scoped Row-Level Security (RLS), and least-privilege database roles.
3. **Geospatial & Ingestion Subsystem**: Offline-capable MapLibre GL vector engine rendering cadastral boundaries and dynamically extracting KML/KMZ pipelines and wellsite concession polygons.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT BROWSERS                                      │
│               Field Officers | Negotiation Leads | Legal | Admin | Finance              │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PRESENTATION & SHELL LAYER (app/)                               │
│  - 30 Uniform Screen Directories (/dashboard, /cases, /leases, /gis, /surveys...)      │
│  - CSS Design Tokens, Components, Responsive, Print Layouts                            │
│  - Strict Content Security Policy (No 'unsafe-inline', No 'eval')                      │
└─────────────────────┬───────────────────────────────────────────┬──────────────────────┘
                      │                                           │
                      ▼                                           ▼
┌───────────────────────────────────────────┐ ┌──────────────────────────────────────────┐
│         CORE RUNTIME ENGINES              │ │        GEOSPATIAL SUBSYSTEM (GIS)        │
│  - spec.js   (16 Domain Module Specs)     │ │  - MapLibre GL Vector Engine (Offline)   │
│  - engine.js (State, Roles, Workflows)    │ │  - JSZip KMZ/KML Decompressor & Parser   │
│  - calc.js   (Area Math, WHT, Leases)     │ │  - Interactive Concession/Survey Overlays │
│  - actions.js & registry.js (Allowlist)   │ └──────────────────────────────────────────┘
└─────────────────────┬─────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                    ENTERPRISE PERSISTENCE: POSTGRESQL 16 (db/)                         │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐  │
│  │   Normalized Schema     │  │ Stored Procedures & Fn  │  │ Automated Triggers     │  │
│  │ - 18 Version Migrations │  │ - Unit Conversion Math  │  │ - Immutability Guard   │  │
│  │ - 100% Share Constraint │  │ - Financial Settlements │  │ - Version Bumping      │  │
│  │ - Strict CNIC Uniqueness│  │ - Duplicate Prevention  │  │ - Delta Audit Logging  │  │
│  └─────────────────────────┘  └─────────────────────────┘  └────────────────────────┘  │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌────────────────────────┐  │
│  │ Province-Scoped RLS     │  │ Reporting Views         │  │ Least-Privilege Roles  │  │
│  │ - SND, BAL, PNJ, KPK    │  │ - Landowner Summaries   │  │ - lms_app, lms_owner   │  │
│  │ - Designation Filtering │  │ - Lease Expiry Calendar │  │ - lms_migrator         │  │
│  │ - Multi-Tenant Security │  │ - Pending Liabilities   │  │ - lms_readonly, audit  │  │
│  └─────────────────────────┘  └─────────────────────────┘  └────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Presentation & Shell Layer (`app/`)
- **Purpose**: Delivers 30 responsive, accessible web screens with uniform layout, breadcrumbs, user switcher, and navigation.
- **Location**: `app/`
- **Pattern**: Static Multi-Page Application (MPA) generated deterministically via `build/generate_pages.py`.
- **Key Files**:
  - `app/index.html`: Authentication, role switcher, and demo bootstrap.
  - `app/assets/css/tokens.css`: Color palettes, elevations, spacing variables.
  - `app/assets/css/components.css`: Cards, data tables, badges, modals, form controls.
  - `app/assets/js/app/shell.js`: Client-side chrome, navigation drawer, breadcrumbs, footer.
  - `app/assets/js/app/actions.js`: Central event delegation routing `click`, `change`, `input` events.
  - `app/assets/js/app/registry.js`: Safe allowlist of 119 callable business action handlers.

### 2. Core Domain Engines (`app/assets/js/core/`)
- **Purpose**: Encapsulates all domain metadata, formulas, administrative structures, and state transitions.
- **Location**: `app/assets/js/core/`
- **Pattern**: Functional engine and domain specification.
- **Key Files**:
  - `spec.js`: Schema declarations, column rendering, forms, and validation for 16 domain entities (`units`, `projects`, `surveys`, `landowners`, `acquisitions`, `cases`, `leases`, `rows`, `payments`, `dbpfc`, `budgets`, `grievances`, `encroachments`, `legal`, `mutations`, `users`).
  - `engine.js`: In-memory state manager (`S`), multi-tier workflow engine (`wfAdvance`, `wfReturn`, `wfEscalate`), role authorization rules, and modal controllers.
  - `calc.js`: Provincial land measurement conversion formulas (Sindh, Balochistan, Punjab, KP), Withholding Tax (WHT) calculations (Filers vs. Non-Filers), lease rent escalation, and parcel area aggregations.

### 3. Geospatial Subsystem (`app/assets/js/ui/gis.js`, `app/assets/js/app/gis-map.js`)
- **Purpose**: Interactive cadastral mapping and spatial boundary correlation.
- **Location**: `app/assets/js/ui/gis.js`, `app/assets/js/app/gis-map.js`
- **Libraries**: Vendored MapLibre GL v3.6.2 and JSZip v3.10.1.
- **Capabilities**:
  - Offline vector base maps with switchable satellite imagery.
  - Direct decompression and rendering of `.kmz` and `.kml` boundary files for concession blocks, flowlines, and well locations.
  - Spatial parcel linking with real-time dispute and lease expiration indicators.

### 4. Authoritative PostgreSQL Database Subsystem (`db/`)
- **Purpose**: Authoritative enterprise record-keeping, data integrity enforcement, concurrency control, and auditability.
- **Location**: `db/`
- **Migrations**: 18 version-controlled forward-only SQL migrations (`db/migrations/0001` through `0018`).
- **Core Schemas & Tables**:
  - `lms_ref`: `province`, `admin_unit`, `designation`, `measurement_unit`, `conversion_rate`.
  - `lms_org`: `app_user`, `user_role`, `approval_hierarchy`.
  - `lms_cadastre`: `project`, `survey_parcel`, `landowner`, `parcel_ownership` (with 100% sum constraint).
  - `lms_land`: `acquisition_case`, `lease_agreement`, `row_corridor`, `dbpfc_case`.
  - `lms_finance`: `compensation_case`, `payment_voucher`, `payment_line`, `budget_head`.
  - `lms_legal`: `title_mutation`, `grievance_record`, `litigation_case`.
  - `lms_audit`: `audit_log` (immutable), `record_version`, `document_attachment`.
- **Routines & Triggers**:
  - Stored procedures for payment release, duplicate prevention, and balance reconciliation.
  - Triggers for immutable audit logs, version bumping, and fractional share balancing.
  - Province-scoped Row-Level Security (RLS) policies.

### 5. Deterministic Build Pipeline (`build/`)
- **Purpose**: Rebuilds vendor libraries, multi-page modules, CSP transforms, and screen pages from canonical sources.
- **Location**: `build/`
- **Files**:
  - `build.sh`: Master build execution script.
  - `extract_vendor.py`: Extracts byte-for-byte copies of vendored libraries from the single-file archive.
  - `transform_app.py`: Validates and extracts application code, stripping inline styles and converting inline handlers to `data-act`.
  - `generate_pages.py`: Generates all 30 HTML page directories from a unified template.

---

## Data Flow

### 1. Landowner Registration & Co-Ownership Balancing
```
[Field Officer]
      │
      ▼
1. Enter Landowner (CNIC: XXXXX-XXXXXXX-X, FBR Status)
      │
      ▼
2. Attach Landowner to Cadastral Survey Parcel
      │
      ▼
3. Assign Fractional Share Percentage (Hissa-dari)
      │
      ▼
4. Validation Check: Sum(Shares for Parcel) == 100.0%
      ├─► [NO]  ─► Validation Error: "Total shares must equal exactly 100%"
      └─► [YES] ─► Record Persisted & Locked for Acquisition/Compensation
```

### 2. Compensation Workflow & Payment Release
```
[Field Land Officer]   Initiates Compensation Case (Crop/Tree/Flare Pit/50% Past Pending)
      │
      ▼
[Negotiation Lead]     Verifies Landowner Agreement & Calculated Rates
      │
      ▼
[Legal Clearance]      Verifies Land Title, Intiqal / Succession & Absence of Court Stays
      │
      ▼
[Senior Admin (Field)] Reviews Local Administrative Endorsements
      │
      ▼
[Manager Land (HO)]    Grants Corporate Executive Approval against Land Budget
      │
      ▼
[Finance Department]   Executes Payment Voucher Release
                       - Calculates FBR WHT (Filer standard rate vs Non-Filer 2x)
                       - Enforces Duplicate-Payment Prevention Check
                       - Spawns Immutable Audit Log & Incrementing Record Version
```

---

## Technical Debt & Ongoing Hardening

- [x] Eliminate inline event handlers and inline styles in multi-page application (Completed in `build/transform_app.py`).
- [x] Replace floating-point numeric operations with exact decimal arithmetic across database and frontend math.
- [x] Enforce database-level immutability triggers on audit tables.
- [ ] Connect multi-page client runtime to live PostgreSQL REST/GraphQL API gateway (currently simulated client-side via `localStorage`).
- [ ] Configure SAML 2.0 / OpenID Connect provider for enterprise Active Directory SSO integration.

---

## Conventions

### Naming Conventions:
- **Files**: Lowercase with hyphens or underscores (`spec.js`, `0001_foundation.sql`).
- **HTML Action Elements**: `data-act="functionName" data-a1="arg1" data-a2="arg2" data-close="modalId"`.
- **Database Tables**: Schema-qualified snake_case (`lms_cadastre.survey_parcel`, `lms_finance.compensation_case`).
- **Primary Keys**: UUID v4 (`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`).
- **Monetary & Area Columns**: `numeric(18,4)` for absolute precision.

### Architecture Rules:
- **No Inline JavaScript**: All UI interactions must route through `data-act` and `app/assets/js/app/registry.js`.
- **Zero Floating-Point Financials**: Never use `float` or `double precision` for currency, shares, or land areas.
- **Append-Only Auditing**: Never execute `UPDATE` or `DELETE` against audit tables; all changes produce new versions.

---

*Last updated: 2026-10-27*
