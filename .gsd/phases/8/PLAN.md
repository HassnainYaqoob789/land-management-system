---
phase: 8
plan: 1
wave: 1
gap_closure: true
---

# Plan 8: Reference Data Cleansing & Ingestion, Missing Business Workflows, and Enterprise Integrations

## Objective
Implement, integrate, and verify all 7 gaps identified in `.gsd/GAP_ANALYSIS.md`:
1. Cleanse and ingest reference CSV datasets (412 landowners, 648 leases, 450 renewals, 55 projects, DPFC government land) into PostgreSQL `lms_dev`.
2. Implement 4-tier Land Lease Request Initiation & Approval Workflow (`Sample Approval Workflow.pdf` & Presentation Slide 11).
3. Implement Lease Renewal Reason-Based Hold & Release management (Presentation Slide 15).
4. Implement Enterprise Active Directory (ADFS / Entra ID) SSO Staging Simulator on `/login`.
5. Implement SAP ERP RFC Outbox Worker (`scripts/sap_outbox_worker.ts`).
6. Implement Automated VAPT Security Scanner (`tests/security/vapt_scanner.test.js`).
7. Execute Backup and Restoration Recovery Verification Drill (`db/tools/backup.sh`).

## Context
Load these files for context:
- `.gsd/GAP_ANALYSIS.md`
- `.gsd/SPEC.md`
- `.gsd/ROADMAP.md`
- `requirments/CSV Datasets.zip`
- `requirments/Workflow references.zip` (`Sample Approval Workflow.pdf`)
- `requirments/Measurement Units, Adminitrative Hierarchy, Terminology & Work Flow (12-March-2026).ppsx`
- `src/lib/db.ts`
- `src/lib/auth.ts`
- `src/app/api/`

## Tasks

<task type="auto" effort="high">
  <name>Reference CSV Data Cleansing and Automated Ingestion Engine</name>
  <files>
    scripts/ingest_reference_data.ts
    package.json
  </files>
  <action>
    1. Parse reference CSVs from `requirments/CSV Datasets/`:
       - `Landowner_Detail.csv` (412 landowners): Map name, CNIC, area, paid amounts.
       - `Project_Wise_Summary.csv` (55 projects): Ingest all projects, concession codes, and province mappings.
       - `Lease_Register.csv` (648 leases): Cleanse dates (`end_date > start_date`), map survey numbers, dehs, talukas.
       - `Renewal.csv` (450 renewals): Populate renewal records with annual escalation schedules.
       - `Sample DPFC Government Land.csv`: Populate government land reservations.
    2. Enforce CNIC normalization and data hygiene.
    3. Execute in atomic transaction using `src/lib/db.ts` connection pool.
    4. Provide CLI command `npm run db:ingest:reference`.
  </action>
  <verify>
    npm run db:ingest:reference && psql -d lms_dev -c "SELECT count(*) FROM lms.landowner;" | grep -q "4"
  </verify>
  <done>
    PostgreSQL `lms_dev` contains all 400+ landowners, 600+ leases, and 55 concession projects from reference materials.
  </done>
</task>

<task type="auto" effort="high">
  <name>4-Tier Land Lease Request Initiation & Approval Workflow</name>
  <files>
    src/app/api/requests/route.ts
    src/app/api/requests/[id]/transition/route.ts
    src/app/requests/page.tsx
    src/components/layout/Header.tsx
  </files>
  <action>
    1. Implement database table `lms.land_request` with Request ID (`REQ-YYYY-XXXX`), project, concession, land purpose, area in Acres/Ghunta, justification, attachments.
    2. Implement REST API endpoints:
       - `GET /api/requests`: Search, filter by province/status.
       - `POST /api/requests`: Create new request (Initiator).
       - `POST /api/requests/[id]/transition`: 4-tier state transitions:
         - Initiator -> Submitted (Director Operations Approval Pending)
         - Director Operations -> Approved OR Returned/Rejected with mandatory remarks
         - Regional Manager -> Forwarded to Land Affairs
         - DM/TL Land Affairs -> Land Processing Initiated
    3. Build responsive UI at `/requests` with request creation modal, filter pills, and transition action bar.
    4. Add Requests link to navigation header.
  </action>
  <verify>
    curl -s http://localhost:3030/api/requests | grep -q "requests"
  </verify>
  <done>
    4-tier land lease request flow from `Sample Approval Workflow.pdf` is fully functional and demonstrated in UI and API.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Lease Renewal Approval & Reason-Based Hold/Release Controls</name>
  <files>
    src/app/api/leases/[id]/hold/route.ts
    src/app/api/leases/[id]/renew/route.ts
    src/app/leases/page.tsx
  </files>
  <action>
    1. Implement `/api/leases/[id]/hold`: Toggle between `Active`, `Hold`, and `Released` states with mandatory hold reason and audit event logging.
    2. Implement `/api/leases/[id]/renew`: Process yearly lease renewal with annual escalation calculation.
    3. Update `src/app/leases/page.tsx` with Hold / Release modal, reason prompt, renewal button, and badge indicators.
  </action>
  <verify>
    curl -s -X POST http://localhost:3030/api/leases/LSE-000001/hold -H "Content-Type: application/json" -d '{"action":"hold","reason":"Pending legal clearance"}'
  </verify>
  <done>
    Lease renewal and hold/release controls compliant with Slide 15 of reference presentation are active and tested.
  </done>
</task>

<task type="auto" effort="high">
  <name>Active Directory SSO Staging Simulator & SAP Outbox Worker</name>
  <files>
    src/app/api/auth/sso/login/route.ts
    src/app/api/auth/sso/callback/route.ts
    src/app/api/auth/sso/metadata/route.ts
    src/app/(auth)/login/page.tsx
    scripts/sap_outbox_worker.ts
  </files>
  <action>
    1. Create SAML/OIDC federation endpoints (`/api/auth/sso/login`, `/api/auth/sso/callback`, `/api/auth/sso/metadata`).
    2. Add interactive "Sign in with Microsoft Entra ID / ADFS" corporate simulator on login screen for all 10 E&P personas.
    3. Build `scripts/sap_outbox_worker.ts` that polls `lms.integration_outbox`, formats SAP BAPI accounting documents, simulates/posts GL documents (`BELNR: 1900000421`), and updates outbox to `SYNCHRONIZED`.
  </action>
  <verify>
    npx tsx scripts/sap_outbox_worker.ts --dry-run
  </verify>
  <done>
    Active Directory SSO simulator functional on login page and SAP outbox worker synchronizes payment releases.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Automated VAPT Security Scanner & Backup Verification Drill</name>
  <files>
    tests/security/vapt_scanner.test.js
    package.json
  </files>
  <action>
    1. Implement `tests/security/vapt_scanner.test.js` validating SQL injection resistance, XSS reflection escaping, cross-province IDOR isolation, unauthenticated 401s, and HTTP-only cookie security.
    2. Execute `db/tools/backup.sh` to generate an encrypted snapshot, restore into a test database, and verify row count integrity.
    3. Add script `npm run test:vapt` to package.json.
  </action>
  <verify>
    npm run test:vapt
  </verify>
  <done>
    Automated VAPT security scan passes 100% green and backup/recovery procedures are empirically validated.
  </done>
</task>
