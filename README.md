# Mari Energies — Enterprise Land Management System (LMS)

A fully integrated, production-grade Land Management System (LMS) engineered for upstream Exploration & Production (E&P) operations across all four Pakistani provincial jurisdictions (**Sindh, Balochistan, Punjab, and Khyber Pakhtunkhwa**).

Built strictly using the mandatory technology stack:
- **Frontend**: Next.js 15 (React 19, TypeScript, Tailwind CSS, App Router)
- **Backend**: Node.js (Route Handlers in `src/app/api/...` with transactional context and parameterized queries)
- **Database**: PostgreSQL 16 (`lms_dev`, 47 migrations (0001–0048; number 0045 was never used), province-scoped Row-Level Security, in-database financial integrity, 23 DB test files, ~690 assertions)

---

## 🌟 Key Functional Capabilities

1. **Multi-Provincial Revenue Hierarchies**
   - Native support for provincial revenue structures:
     - **Sindh**: Division &rarr; District &rarr; Taluka &rarr; Tappa &rarr; Deh &rarr; Survey/Khasra
     - **Balochistan**: Division &rarr; District &rarr; Tehsil &rarr; Qanungo Circle &rarr; Patwar Circle &rarr; Mauza &rarr; Khasra
     - **Punjab & KP**: Division &rarr; District &rarr; Tehsil &rarr; Qanungo Circle &rarr; Patwar Circle &rarr; Mauza &rarr; Khasra
   - Provincial area conversions: Sq. Yards, Marla, Kanal, Acres, Jareeb, Murabba, and Hectares.

2. **Cadastral Registry & 100.0% Co-Ownership Share Balancer**
   - Precise parcel registry with strict mathematical invariants: the sum of ownership shares across all co-owners of any survey parcel must sum to exactly **100.0%**.
   - Interactive share balancer UI (`src/components/ui/ShareBalancer.tsx`) enforcing live validation before submission.

3. **Master Landowners & NADRA CNIC Validation**
   - Strict format validation (`XXXXX-XXXXXXX-X`) and master CNIC uniqueness.
   - Deceased owner succession locks preventing direct compensation execution without probate or legal legal-heir mutation.
   - Active payment hold tracking for ongoing court cases and stay orders.

4. **6-Tier Segregation of Duties (SoD) Approval Workflow**
   - Compensation cases follow an auditable, sequential 6-tier pipeline:
     1. **Land Officer (Field)** (`lofield`): Case preparation, field joint surveys, and document checklist verification.
     2. **Negotiation Officer** (`nego`): Rates negotiation with landowners.
     3. **Legal Advisor** (`legal`): Title deed verification, non-encumbrance check, and legal search.
     4. **Sr. Administrator (Field)** (`sradmin`): Field administration verification.
     5. **DM / Team Lead (Field)** (`dmfield`): Field operational approval.
     6. **Manager Land (HO)** (`mgrho`): Head Office executive approval.
     7. **Finance Officer** (`finance`): Pre-disbursement audit, payment voucher issuance, crossed cheque release (`CHQ-...`), and ERP outbox event generation.

5. **Financial Engine & Compliance Controls**
   - **FBR Withholding Tax (WHT)** calculation (Active Taxpayer Filers vs. Punitive Non-Filer rate).
   - **Legal Stay Order Holds**: Automatic payment hold guards preventing disbursement on contested parcels or disputed titles.
   - **Budget Safeguards**: Real-time project budget balance validation preventing over-commitment.
   - **Duplicate Payment Prevention**: Cryptographic request hashing and database idempotency keys (`lms.idempotency_key`).

6. **Cadastral GIS Vector Map**
   - Vector GeoJSON endpoint (`/api/gis`) delivering parcel boundaries, well locations, gathering stations, and pipeline Rights-of-Way (ROW).
   - Leaflet / MapLibre compatible spatial rendering with parcel attribute inspection.

7. **Tamper-Evident Immutable Audit Trail**
   - Every mutation, stage advance, login, and cheque disbursement is recorded into `audit.audit_event` with actor identity, timestamp, IP, and state diffs.

---

## 🏛️ System Architecture

```text
               ┌────────────────────────────────────────────────────────┐
               │              Next.js 15 Client Frontend                │
               │  React 19 · TypeScript · Tailwind CSS · App Router     │
               │  Shell · RoleSwitcher · ShareBalancer · WorkflowModal  │
               └───────────────────────────┬────────────────────────────┘
                                           │ HTTP-Only Session Cookies
                                           ▼
               ┌────────────────────────────────────────────────────────┐
               │                 Node.js Backend Tier                   │
               │             src/app/api/* Route Handlers               │
               │  Auth · Cases · Surveys · Leases · Payments · GIS      │
               └───────────────────────────┬────────────────────────────┘
                                           │ Transactional pg pool
                                           │ api.set_actor(user_id)
                                           ▼
               ┌────────────────────────────────────────────────────────┐
               │                 PostgreSQL 16 Engine                   │
               │   Schema: lms, api, audit, geo, ext (PostGIS)          │
               │   Row-Level Security (RLS) · 100% Share Balancer       │
               │   Sequences · Idempotency Keys · 6-Tier SoD Guards     │
               │   Immutable Audit Trail · ERP Outbox Queue             │
               └────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: v18.18+ or v20+
- **npm**: v9+
- **PostgreSQL**: 16 with PostGIS extension (running on port 5432)

### 1. Database Initialization
```bash
# Connect as postgres superuser and create roles
psql -d postgres -f db/bootstrap/01_roles.sql

# Rebuild schema and load realistic Pakistani E&P seed data
db/tools/rebuild.sh lms_dev seed

# Optional: Run in-database verification test suite (23 files, ~690 assertions)
python3 db/tools/run_tests.py
```

### 2. Environment Configuration
Create `.env.local` (git-ignored; never commit it). Use a connection for the
least-privileged runtime role `lms_app` — not `lms_owner` — and take any
password from your secret store, not from documentation:
```ini
DATABASE_URL=postgresql://lms_app@/lms_dev?host=/tmp     # socket auth, or a password from your vault
APP_ORIGIN=http://localhost:3030                         # the exact origin users browse to (CSRF/Origin checks)
APP_ALLOWED_ORIGINS=                                     # optional, comma-separated extra origins (e.g. http://127.0.0.1:3030)
DOCUMENT_STORE_DIR=/srv/lms/documents                    # required in production: uploaded files, content-addressed
IAM_MASTER_KEYS=<generated>                              # see docs/security/SECURITY_ARCHITECTURE.md
IAM_HMAC_KEY=<generated>
```
Accounts get passwords through `npx tsx scripts/iam/bootstrap.ts --username <name>`;
there are no default passwords.

### 3. Build & Run Application
```bash
# Install dependencies
npm install

# Compile Next.js production build
npm run build

# Start production server
PORT=3030 npm start
```
The application will be live at **`http://localhost:3030`**.

---

## 🛠️ Reusable Agent Skills Inventory

Nine task-specific agent skills are established in `.agents/skills/` to drive autonomous, high-quality engineering across the full project lifecycle:

| Skill | Directory | Purpose | Activation Trigger |
|:---|:---|:---|:---|
| **1. Requirements Traceability** | [`.agents/skills/lms-requirements-traceability/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/lms-requirements-traceability/) | Maps requirements (REQ-01..24) to files, schemas, and test cases with bidirectional verification. | Triggered on phase inception, scope changes, and requirement audits. |
| **2. GSD Orchestration** | [`.agents/skills/gsd-orchestration/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/gsd-orchestration/) | Orchestrates wave-based task execution, dependency resolution, and atomic git commit management. | Triggered on `/execute`, phase planning, and state transitions. |
| **3. Next.js Full-Stack Dev** | [`.agents/skills/nextjs-fullstack-dev/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/nextjs-fullstack-dev/) | Implements Next.js 15 App Router pages, React 19 UI, and Node.js REST Route Handlers. | Triggered on frontend UI development, API routes, and client state. |
| **4. PostgreSQL Data Integrity** | [`.agents/skills/postgres-data-integrity/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/postgres-data-integrity/) | Designs migrations, RLS policies, 100% share balancing, and transactional concurrency. | Triggered on database schema edits, migrations, and query tuning. |
| **5. Auth, RBAC & Security** | [`.agents/skills/lms-auth-rbac-security/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/lms-auth-rbac-security/) | Implements Argon2id authentication, HTTP-only session cookies, 6-tier SoD, and OWASP ASVS L2. | Triggered on authentication, authorization guards, and security audits. |
| **6. Code Review & Refactoring** | [`.agents/skills/code-review-refactoring/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/code-review-refactoring/) | Performs automated linting, typing, parameterization, dead code elimination, and refactoring. | Triggered before commits, PR reviews, and code quality audits. |
| **7. QA & Test Engineering** | [`.agents/skills/qa-test-engineering/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/qa-test-engineering/) | Generates and executes unit, integration, regression, and negative boundary test suites. | Triggered on feature completion, bug fixes, and regression gates. |
| **8. Realistic Workflow UAT** | [`.agents/skills/lms-workflow-uat/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/lms-workflow-uat/) | Executes realistic multi-persona business journeys across all 10 E&P user personas. | Triggered on milestone completion and user acceptance testing. |
| **9. Playwright & A11y Automation** | [`.agents/skills/playwright-a11y-automation/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agents/skills/playwright-a11y-automation/) | Runs Playwright E2E browser tests and `@axe-core/playwright` WCAG 2.1 AA accessibility checks. | Triggered on UI changes, cross-browser audits, and release gates. |

---

## 🔄 GSD Workflow Integration

The agent skills are integrated directly into the GSD workflow engine ([`.agent/workflows/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.agent/workflows/) and [`.gsd/templates/`](file:///Users/omair/Downloads/03%20Vibe-Coded%20Apps/lms/.gsd/templates/)):

```text
[ Requirements ] ──> lms-requirements-traceability
       │
       ▼
[   Planning   ] ──> gsd-orchestration + postgres-data-integrity
       │
       ▼
[Implementation] ──> nextjs-fullstack-dev + lms-auth-rbac-security
       │
       ▼
[ Code Review  ] ──> code-review-refactoring
       │
       ▼
[   Testing    ] ──> qa-test-engineering + playwright-a11y-automation
       │
       ▼
[  Validation  ] ──> lms-workflow-uat
       │
       ▼
[Release Gates ] ──> Evidence-based evaluation (.gsd/RELEASE_GATES.md)
```

- **`/plan`**: Maps functional requirements to tasks and designates required skills in `PLAN.md`.
- **`/execute`**: Invokes domain skills in sequential waves with atomic verification checkpoints.
- **`/verify`**: Enforces all 7 release criteria before generating `VERIFICATION.md`.
- **`/audit-milestone`**: Validates milestone deliverables against empirical release evidence.

---

## 🧪 Testing and Release Gates

Run against a production build (`npm run build && npm start`) and the test
database. Signed-in suites read fixture passwords from a JSON file named by
`IAM_TEST_PASSWORDS` (generated with `scripts/iam/bootstrap.ts`; never committed).

| Suite | Command | What it checks |
|:---|:---|:---|
| Type check / lint / build | `npm run typecheck`, `npm run lint`, `npm run build` | compile-time correctness |
| Domain units | `npm run test:unit` | share balancing, unit conversion, CNIC, WHT helpers |
| KML parsing | `npm run test:integration` | KML/KMZ parsing, area, XXE refusal |
| Database | `npm run test:db` | 23 DB test files: constraints, RLS, triggers, SoD, idempotency, audit, WHT policy |
| API, IAM and business rules | `IAM_TEST_BASE=… IAM_TEST_PASSWORDS=… npm run test:api` | sign-in, MFA, sessions, CSRF, permissions, every workflow end to end, payments, holds, documents, exports, security headers |
| Browser | `BASE_URL=… IAM_TEST_PASSWORDS=… npm run test:playwright` | every screen in the reference design, axe WCAG 2.1 AA (contrast on), role-based user journeys |
| Load | `BASE=… PERF_PASSWORDS=… node scripts/perf/load_test.mjs <concurrency> <requests>` | latency at volume (`db/tools/perf_load.sql` fixture) |

Gate definitions: [`.gsd/RELEASE_GATES.md`](.gsd/RELEASE_GATES.md). The latest
full run, with dates, conditions, results and open items:
[`docs/reports/RELEASE_ASSESSMENT_2026-10-29.md`](docs/reports/RELEASE_ASSESSMENT_2026-10-29.md).
Suites written for the pre-authentication build are kept, unrun, in `tests/_archive/`.

---

## 👥 Seed User Personas

The demo seed creates these accounts without a usable password; set one per
account with `scripts/iam/bootstrap.ts`. (`legacy-demo/` is the static design
reference: it has its own built-in demo logins, no server and no real data.)

| Username | Designation | Jurisdiction | Approval position |
|:---|:---|:---|:---|
| `admin` | Land Information Systems Head | All | Administrator |
| `lofield` | Land Officer (Field) | Sindh | Prepares records |
| `nego` | Revenue & Negotiation Officer | Sindh | Negotiation Group |
| `legal` | Legal Counsel | All | Legal Advisor |
| `sradmin` | Sr. Administrator (Field) | Sindh | Sr. Administrator LMS (Field) |
| `dmfield` | DM / Team Lead (Field) | Sindh | DM / Team Lead (Field) |
| `mland` | Manager Land (Head Office) | All | Manager Land (HO) |
| `finance` | Finance Officer | All | Finance Officer |
| `viewer` | Audit Observer | All | Read-only |

---

## 📁 Repository Directory Structure

```text
├── .env.local                   # Environment configuration (DATABASE_URL, PORT)
├── next.config.ts               # Next.js configuration
├── package.json                 # Node dependencies (Next 15, React 19, pg, @node-rs/argon2, otplib)
├── tailwind.config.ts           # Design tokens, color system, and layout utilities
├── tsconfig.json                # TypeScript compiler configuration
├── db/
│   ├── bootstrap/               # 01_roles.sql, 02_schema.sql, 03_leakproof.sql
│   ├── migrations/              # 47 forward-only migrations (0001–0048, no 0045)
│   ├── seed/                    # Pakistani E&P reference seed datasets
│   ├── tests/                   # 23 DB test files (~690 assertions)
│   └── tools/                   # rebuild.sh, migrate.py, run_tests.py, perf.py
├── docs/                        # Security, ISO27001, SOC2, and architecture audits
├── legacy-demo/                 # Archived static HTML & Python demo files
├── scripts/
│   ├── iam/bootstrap.ts         # Account bootstrap (passwords from the environment)
│   └── test_e2e.js              # Complete 35-assertion automated E2E test runner
└── src/
    ├── app/                     # Next.js App Router
    │   ├── api/                 # REST Route Handlers (auth, cases, surveys, payments, gis, audit, etc.)
    │   ├── audit/               # Immutable Audit Log viewer
    │   ├── cases/               # 6-Tier Compensation Cases pipeline
    │   ├── dashboard/           # Multi-provincial KPIs and executive analytics
    │   ├── dbpfc/               # District Base Price Fixing Committee portal
    │   ├── gis/                 # Vector Cadastral GIS map viewer
    │   ├── landowners/          # Master Landowner and CNIC management
    │   ├── leases/              # Surface land agreements & escalation tracker
    │   ├── login/               # Secure authentication portal
    │   ├── payments/            # Finance vouchers, FBR tax, and cheque disbursement
    │   ├── projects/            # E&P concessions & blocks
    │   ├── reports/             # Compliance, liability, and revenue reports
    │   ├── rows/                # Pipeline corridors & Right-of-Way
    │   ├── surveys/             # Cadastral parcels & 100% share balancer
    │   ├── globals.css          # Design system CSS styles
    │   ├── layout.tsx           # Root layout with fonts and providers
    │   └── page.tsx             # Root redirector
    ├── components/
    │   ├── layout/              # Shell, Header, Sidebar
    │   └── ui/                  # RoleSwitcherModal, ShareBalancer, WorkflowStepper
    └── lib/
        ├── auth.ts              # Session cookies, JWT/actor resolution
        ├── db.ts                # PostgreSQL connection pool and withTransaction helper
        └── domain.ts            # Provincial hierarchies, formatting, and mathematical share balancing
```

---

## 🔒 Security & Compliance Assurance

- **OWASP ASVS 4.0.3 L2 Compliance**: Parameterized SQL queries preventing injection, HTTP-only SameSite cookies, Argon2id password hashing, nonce-based Content-Security-Policy.
- **Strict Row-Level Security (RLS)**: Provincial data isolation ensures regional field officers cannot view or mutate parcels outside their authorized jurisdiction.
- **Separation of Duties (SoD)**: The system prevents self-approval, enforces distinct roles at each stage, and enforces document checklist completion before field approval.
- **Legal Hold Protection**: Pre-disbursement checks block payments on parcels subject to active court litigation or stay orders.

## Demo environment

A separate demonstration database with the fictional demo seed and sign-in
accounts listed on the login page:

```bash
npm run demo:setup          # rebuilds lms_demo only (refuses any other name), sets a fresh
                            # random password per demo account → .data/demo-credentials.json
DATABASE_URL="postgresql://lms_app@/lms_demo?host=/tmp" APP_ORIGIN=http://localhost:3050 \
LMS_DEMO_MODE=on LMS_DEMO_CREDENTIALS_FILE="$PWD/.data/demo-credentials.json" npx next start -p 3050
```

The login page shows the accounts (with a "Use" button) only when the server has
`LMS_DEMO_MODE=on`, the credentials file, and is connected to the database the
file was made for; otherwise `/api/auth/demo-accounts` answers `{ enabled: false }`.
Never set `LMS_DEMO_MODE` in production. The demo database has the MFA prompts
switched off (demo only, logged as a policy event); every other environment keeps
the MFA policy. Each account sees only what its role and provinces allow
(row-level security), e.g. the Sindh field officer sees Sindh records only.
