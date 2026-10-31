---
phase: 7
plan: 1
wave: 1
gap_closure: false
---

# Plan 7: Production Full-Stack Next.js + Node.js + PostgreSQL Implementation

## Objective
Build, integrate, and verify the production-grade Land Management System natively in the mandatory technology stack:
- **Frontend**: Next.js (App Router, TypeScript, Tailwind CSS, rich aesthetic design)
- **Backend**: Node.js (Next.js server-side API routes & server actions, connection pooling via `pg`)
- **Database**: PostgreSQL 16 (authoritative system of record `lms_dev`, 113 tables/views, stored routines, triggers, RLS)

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ROADMAP.md`
- `requirments/lms_project_analysis.md`
- `requirments/email.txt`
- `requirments/prompt.md`
- `db/migrations/` (18 schema migrations)
- `db/seed/` (seed datasets)

## Tasks

<task type="auto" effort="high">
  <name>Scaffold Next.js Full-Stack Application & Configure Dependencies</name>
  <files>
    package.json
    tsconfig.json
    next.config.ts
    src/lib/db.ts
    .env.local
  </files>
  <action>
    1. Preserve legacy HTML demo in `legacy-demo/` for reference.
    2. Initialize Next.js project with App Router, TypeScript, and Tailwind CSS.
    3. Install dependencies: `pg` (node-postgres), `@types/pg`, `bcryptjs`, `@types/bcryptjs`, `lucide-react`, `clsx`, `tailwind-merge`.
    4. Configure PostgreSQL connection pool in `src/lib/db.ts` connecting to `lms_dev` via Unix socket `/tmp:5432` or TCP port `5432`.
    5. Test database connectivity via Node.js script.
  </action>
  <verify>
    node -e "const {pool} = require('./src/lib/db'); pool.query('SELECT 1').then(() => { console.log('DB Connected'); process.exit(0); });"
  </verify>
  <done>
    Next.js application compiles and establishes connection pool with PostgreSQL `lms_dev`.
  </done>
</task>

<task type="auto" effort="high">
  <name>Implement Core Node.js Backend API Handlers</name>
  <files>
    src/app/api/auth/login/route.ts
    src/app/api/auth/me/route.ts
    src/app/api/provinces/route.ts
    src/app/api/projects/route.ts
    src/app/api/landowners/route.ts
    src/app/api/surveys/route.ts
    src/app/api/cases/route.ts
    src/app/api/cases/[id]/transition/route.ts
    src/app/api/leases/route.ts
    src/app/api/rows/route.ts
    src/app/api/payments/route.ts
    src/app/api/dbpfc/route.ts
    src/app/api/reports/route.ts
    src/app/api/audit/route.ts
  </files>
  <action>
    Develop RESTful API route handlers implementing full transactional integrity:
    1. Auth: User login, session cookie, role-based designation validation.
    2. Projects: Query `lms.project` and `api.v_project_land_status`.
    3. Landowners: CNIC validation (`XXXXX-XXXXXXX-X`), search, creation with FBR status.
    4. Surveys: Query `lms.survey`, calculate fractional co-owner shares, enforce 100% balance.
    5. Cases: Query `lms.compensation_case`, calculate crop/tree damages, execute 6-tier stage transitions with mandatory remarks.
    6. Leases: Query `lms.lease`, compute annual rent escalation, flag 30/60/90-day expiry.
    7. ROW Corridors: Query `lms.row_corridor` for pipeline and flowline lengths.
    8. Payments: Compute WHT deduction (Filers standard vs Non-Filers 2x), prevent duplicate voucher releases.
    9. DBPFC: Query Sindh Government Land reservations and committee rate approvals.
    10. Audit: Return tamper-evident audit events from `audit.audit_event`.
  </action>
  <verify>
    curl -s http://localhost:3000/api/provinces | grep -q "Sindh"
  </verify>
  <done>
    All backend API routes return structured JSON from PostgreSQL with complete error handling.
  </done>
</task>

<task type="auto" effort="high">
  <name>Develop Next.js Enterprise UI with Rich Aesthetics</name>
  <files>
    src/app/layout.tsx
    src/app/page.tsx
    src/app/dashboard/page.tsx
    src/app/projects/page.tsx
    src/app/landowners/page.tsx
    src/app/surveys/page.tsx
    src/app/cases/page.tsx
    src/app/leases/page.tsx
    src/app/rows/page.tsx
    src/app/payments/page.tsx
    src/app/dbpfc/page.tsx
    src/app/gis/page.tsx
    src/app/reports/page.tsx
    src/components/layout/Shell.tsx
    src/components/layout/Sidebar.tsx
    src/components/layout/Header.tsx
    src/components/ui/ShareBalancer.tsx
    src/components/ui/WorkflowStepper.tsx
  </files>
  <action>
    Build production Next.js frontend pages with state-of-the-art aesthetics:
    - Deep navy/slate palette with Mari Energies gold accents.
    - Persistent application shell with provincial switcher and 10-role simulator.
    - Interactive 100% Share Balancer with live mathematical verification.
    - 6-Tier Workflow Approval Stepper with advance/return modals.
    - Financial payment voucher issuance with real-time FBR WHT calculations.
    - Interactive Cadastral Map overlaying concession blocks and well locations.
  </action>
  <verify>
    npm run build
  </verify>
  <done>
    Next.js production build succeeds with all static and dynamic routes compiled.
  </done>
</task>

<task type="auto" effort="medium">
  <name>End-to-End Verification, Performance & Documentation</name>
  <files>
    README.md
    .gsd/STATE.md
    .gsd/phases/7/VERIFICATION.md
  </files>
  <action>
    1. Start local Next.js dev server on port 3000.
    2. Test end-to-end API and UI navigation across all modules.
    3. Document setup, configuration, and execution steps.
  </action>
  <verify>
    curl -I http://localhost:3000
  </verify>
  <done>
    Application runs locally, connects natively to PostgreSQL, passes end-to-end verification.
  </done>
</task>

## Must-Haves
- [ ] Next.js + Node.js + PostgreSQL 16 full-stack architecture active.
- [ ] Real database persistence for all entities (no client mock data).
- [ ] 6-tier designation approval workflow functioning end-to-end.
- [ ] CNIC regex and 100% mathematical share balancing enforced.
- [ ] Automated FBR WHT tax calculation and payment release controls.
- [ ] Production build passes with zero lint/type errors.

## Success Criteria
- [ ] `npm run build` exits with 0.
- [ ] Next.js server serves `/` and all routes with live data from `lms_dev`.
- [ ] Setup and execution documented in `README.md`.
