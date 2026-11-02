# CLAUDE.md — Mari Energies LMS: Project Context

Single source of context for AI coding sessions. **Update the "Task Log" and any stale section after every task.**
Last full analysis: 2026-10-30.

---

## 1. What this is

Enterprise **Land Management System** for Mari Energies Ltd (Pakistani oil and gas exploration and production).
- **Provinces:** SND, BAL, PNJ, KPK.
- **Covers:** concessions and projects, cadastral parcels (Khasra/Survey), landowners (CNIC is the master key), LAA 1894 acquisition, surface leases, ROW pipeline corridors, compensation cases, payments with FBR withholding tax, DBPFC (Sindh govt land pricing), GIS/KML, Segregation of Duties approvals, and an immutable audit trail.
- **Go-live target:** 2027-03-01.
- **Release status (docs/reports/RELEASE_ASSESSMENT_2026-10-29.md):** **NOT releasable.** All automated gates pass; blockers are listed in §9.
- The app runs locally without issues (user confirmed 2026-10-30).

## 2. Stack

- **Next.js ^15.1** (App Router), **React 19**, TypeScript 5.7 (strict, `@/*` → `src/*`).
- **PostgreSQL 16** via raw `pg` (no ORM). The local cluster runs on **port 5433**, data in `.data/pgdata`.
- **Auth:** `@node-rs/argon2` (bcrypt accepted for legacy hashes), `otplib` (TOTP), `@simplewebauthn` v14 (passkeys), `openid-client` v6, `@node-saml/node-saml`, `ldapts`.
- **Other:** `maplibre-gl` 4.7.1 (has a critical advisory, DEP-01), `chart.js`, `pdfkit`, `adm-zip`, `lucide-react`, `nodemailer`.
- **Tests:** vitest 5, Playwright 1.64 with axe-core, `node --test`, and Python DB tests.
- **Styling:** a ported "legacy" CSS design system (`src/styles/legacy/*.css`, `components/legacy/ui.tsx`) is primary. Tailwind is secondary, with `preflight: false`.

## 3. Repo layout (what matters)

```
src/
  middleware.ts            cookie presence → else redirect /login; sets CSP nonce (skips /api)
  app/<module>/page.tsx    ~35 client screens, wrapped in PageGuard
  app/api/**/route.ts      ~90 route handlers, each wrapped in protect()/publicRoute/ssoRoute
  app/settings/_components settings tabs (SignIn, Mappings, Policy, Requests, Emergency/break-glass)
  components/layout/       Shell (LMSContext: user, perms, activeProvince), Header, Sidebar,
                           nav.ts = SINGLE source for menu + route→permission map
  components/legacy/       ui.tsx (Modal, Field…), data.tsx (useList…), ChartBox
  components/{auth,reports,roles,cases,search,ui,brand}
  lib/db.ts                pg Pool, assertSafeDbRole, withActor, withoutActor
  lib/iam/http.ts          protect(), toResponse(), json(), HttpError, sameOrigin, requireRecord, SCOPED tables
  lib/iam/*                session, login, password, mfa, passkey, crypto, config, sso/{oidc,saml,ldap,flow…}
  lib/workflow.ts          workflow resource/table maps, queueFirstStep, reopenForChanges
  lib/domain.ts            provinces, CNIC/IBAN validation, area units, FBR tax, formatPKR, share math
  lib/reporting/           catalogue-only report engine (no user SQL)
  lib/export/              pdf.ts (pdfkit), xlsx.ts (hand-written)
  lib/kml.ts, documents.ts (sha256 content-addressed store, 50 MB cap), paging.ts, csv.ts, csp.ts
  lib/client/api.ts        useApi cache (TTL), send() adds the x-csrf-token header, invalidate()
  lib/client/permissions.ts useCan / useCanIn
db/
  bootstrap/01_roles.sql, 02_database.sql, 03_leakproof.sql, 04_fix_ownership.sql
  migrations/0001..0057    (56 files; number 0045 never used; forward-only, checksummed)
  seed/ seed_demo*.sql     seeds/reporting_fixture.sql (test DBs only)
  tests/                   test_01..22 (SQL + Python 07/16/19)
  tools/                   migrate.py, rebuild.sh, run_tests.py, backup.sh, perf.py
scripts/                   iam/bootstrap.ts (create account/password), demo/setup_demo.mjs,
                           sap_outbox_worker.ts, ingest_reference_data.ts, perf/load_test.mjs,
                           test-idp/server.mjs (local OIDC/SAML/LDAP/mail), run_all_checks.sh
tests/                     unit/, integration/, iam/, regression/, e2e/, _archive/ (dead, not run)
docs/                      reports/, requirements/, security/, compliance/, architecture/ + models
.gsd/                      GSD process: SPEC, REQUIREMENTS, ROADMAP, STATE, TODO, DECISIONS, phases/1..8
.agent/ .agents/           GSD workflows, subagents, skills (see §11)
legacy-demo/ (archive/)    static HTML design reference — read-only
archive/requirments/       client source material (misspelled on purpose) — DO NOT EDIT
```

Clutter that is safe to ignore: `.next`, `build/` (legacy demo generator), `playwright-report`, `test-results`, `graphify-out` (a code graph; `GRAPH_REPORT.md` is useful), `backups/` (5 pg dumps from 2026-10-27/28), `.data/` (local pgdata and **credential JSONs — never print them**).

## 4. Request lifecycle: auth, RBAC, DB

1. `middleware.ts` only checks that a session cookie exists.
2. Route → `protect({permission:[resource,action], reauth?, authenticatedOnly?})` in `lib/iam/http.ts`:
   1. resolves the session: an opaque token in cookie `__Host-lms_session` / `lms_session`; only its sha256 is stored in the DB (`iam.resolve_session`).
   2. checks CSRF: the `x-csrf-token` header must equal HMAC(session id), and mutating requests need a same-origin `Origin`.
   3. checks must-change-password, MFA (`iam.mfa_required_for`) and reauth (`iam.reauth_minutes`, default 10).
   4. opens `withActor(userId)` → `BEGIN; SELECT api.set_actor($1)`. **RLS enforces province scope.** One request is one transaction.
   5. loads `iam.effective_permissions`, unioned across roles. The widest scope wins: global ⊇ head_office ⊇ province ⊇ project ⊇ assigned.
3. Handler gets `ctx.client` (preferred), `ctx.has()` and `ctx.can(rec)`. Use `requireRecord()` for record scope; an out-of-scope record returns **404**.
4. `toResponse()` maps PG error codes: 42501→403/404, P0001→400, 23505→409, 55000/40001→409, 57014→503.
5. `assertSafeDbRole()` refuses a superuser, a BYPASSRLS role, or a schema-owner role. **The app must connect as `lms_app`.**

**Legacy route style:** `ctx.db` / `legacyUser` / `NextResponse.json` (~107 call sites). New code should use `ctx.client` + `json()` / `HttpError`.

**Seeded IAM roles:** system-administrator, land-manager, finance-approver, case-approver, data-entry, viewer, security-auditor; later migrations add negotiation-officer and legal-advisor. Roles can also be created at runtime.

**Seed usernames:** admin, lofield, nego, legal, sradmin, dmfield, mland, finance, viewer. They have no usable password; set one with `npx tsx scripts/iam/bootstrap.ts --username <name>`.

**SoD chain:** lofield (prepare) → nego → legal → sradmin → dmfield → Manager Land HO → finance (voucher, `CHQ-` cheque, SAP outbox). Self-approval is prohibited.

## 5. Database

- **Schemas:** `lms` (domain, ~110 tables), `iam` (21 tables), `audit` (`audit_event` append-only, `auth_event`, `record_version`), `api` (views and SECURITY DEFINER routines the app calls), `util`, `ext` (PostGIS).
- **Cluster roles:** `lms_owner` (NOLOGIN, owns all objects), `lms_migrator`, `lms_app`, `lms_report`, `lms_test`, `lms_worker`, plus `lms_readwrite` / `lms_readonly`. None has BYPASSRLS.
- **Migration groups:**
  - 0001: numeric contract
  - 0002–09: tables
  - 0010–13: functions and triggers
  - 0014: views
  - 0016: RLS
  - 0017: grants
  - 0019: indexes
  - 0020–23: IAM
  - 0024–26: land requests, lease hold/renewal, GIS
  - 0027–38: fixes (WHT 0035/0037, RLS initplan 0036)
  - 0039–47: RBAC lifecycle, reporting, authorization hardening, role administration, admin hierarchy
  - 0047: per-designation least-privilege roles (legal-advisor, negotiation-officer)
  - 0048: closes the RBAC designation gaps found in the 2026-10-30 audit
  - 0049: landowner statement shows every payment line gross (net + WHT in the description)
  - 0050–0054: fixes found by running every suite (cross-province allocation, REQ template, secret audit key, commitment triggers, group-mapping uniqueness)
  - 0055: approval-queue RLS shows a new record to its province at once (**file recovered 2026-10-31**: it had been applied to lms_dev/lms_test on 2026-10-30 17:54 with no file in the repo; rebuilt from pg_policies, verified identical, checksum row updated, old checksum kept in the file)
  - 0056: `landowner_report:read` permission + `api.rpt_ownership` gains `tax_status`, `owner_on_hold`
  - 0057: exploration land requests on the GIS map (2 roles, versioned polygons, Draft / Handed over stages)
  - 0058: land request ↔ acquisition link · 0059: audit fixes (payments, holds, case guard, reversal-aware views)
  - 0060: land request completion loop (`work_stage`, stage Completed, acquisition Handover → khasras Acquired/Leased + request Completed), `lms.province_unit_factor` + `api.set/clear_province_unit_factor` (per-province unit sizes; survey trigger uses them), `province_unit` editable, 5 prototype purposes, inbox:read for exploration-planner / land-request-reviewer
  - 0062: mutation re-pointing is parcel-wise (`lms.case_parcel_value`) and puts the transferor's unreleased vouchers on hold; payments API gains `cancel` (Finance)
  - 0061: applying a mutation re-points the transferor's unpaid share on open cases and lessor on active leases to the heirs/buyers (`lms.mutation_repoint`, `api.v_mutation_repoint`)
  - 0057: exploration land requests on the GIS map: roles `exploration-planner` + `land-request-reviewer`, `lms.land_request_area` (versioned polygon, append-only, RLS, shape/requester/stage trigger), land_request stages Draft / Withdrawn / Handed over + hand-over columns and trigger (Land Officer (Field) only)
- **Status (2026-11-02):** `lms_dev` is at 0062, all applied, 0 drift (backup before 0060: `backups/lms_dev_before_0060_2026-11-02.dump`). Check with `python db/tools/migrate.py --dsn "$DATABASE_URL_ADMIN" status`.
- **Local cluster:** PostgreSQL 18 binaries at `C:\Program Files\PostgreSQL\18\bin` (not on PATH), data in `.data/pgdata`, port 5433. `pg_hba` trusts localhost, superuser is `postgres`.
- **Windows gotchas:**
  - set `PGCLIENTENCODING=UTF8` and `PYTHONUTF8=1`, or migrations and tests fail with "invalid byte sequence";
  - `python3` is a Store alias, so use `python` or a shim;
  - `rebuild.sh` must be run through `bash` (run_tests.py cannot spawn it). To test without touching `lms_dev`, run `bash db/tools/rebuild.sh lms_test seed`, then `python db/tools/run_tests.py --db lms_test --no-rebuild`.
- **Setup:**
  ```sh
  psql -d postgres -f db/bootstrap/01_roles.sql
  psql -d postgres -v db=lms_dev -f db/bootstrap/02_database.sql
  LMS_DSN="postgresql:///lms_dev?user=lms_migrator" python3 db/tools/migrate.py up
  # or all-in-one: db/tools/rebuild.sh lms_dev seed   (DROPS the DB)
  ```
- **Business invariants:**
  - `numeric(18,4)`, never float, for money, area and shares.
  - Co-owner shares must total exactly 100.0%.
  - A deceased owner blocks payment until a Wirasat/Intiqal mutation.
  - Stay orders and budget checks are enforced in the DB.
  - Idempotency keys stop duplicate payments.
  - Non-filer WHT is 2x the filer rate.
  - Never UPDATE or DELETE audit tables.
- **Area units:** 1 acre = 8 kanal = 160 marla = 4,840 sq yd = 43,560 sq ft; 1 ha = 2.47105 ac; 1 murabba = 25 ac; 1 jareeb = 0.5 ac.

## 6. Environment (`.env.local`; names only, never print values)

- **Set:** `DATABASE_URL`, `DATABASE_URL_ADMIN`, `PGUSER/PGHOST/PGPORT/PGDATABASE`, `JWT_SECRET` (**unused**), `IAM_MASTER_KEYS`, `IAM_HMAC_KEY`, `APP_ORIGIN`, `IAM_COOKIE_SECURE`.
- **`APP_ALLOWED_ORIGINS`:** comma-separated extra origins accepted by the CSRF Origin check (`lib/iam/config.ts` `allowedOrigins()`). `APP_ORIGIN` here is the LAN IP `http://192.168.18.74:3040`, and `localhost:3040` / `127.0.0.1:3040` are allowed through this variable. **The server runs on 3040** (`next start -H 0.0.0.0 -p 3040`, demo mode on, DB `lms_dev`).
- **Optional:** `DB_POOL_MAX`, `TRUST_PROXY_HOPS`, `IAM_TOTP_ISSUER`, `IAM_RP_NAME`, `IAM_ENABLE_SSO_SIMULATOR`, `LMS_DEMO_MODE` (never in prod), `LMS_DEMO_CREDENTIALS_FILE`, `DOCUMENT_STORE_DIR`.
- **Test-only:** `IAM_TEST_BASE`, `IAM_TEST_PASSWORDS`, `BASE_URL`, `PERF_PASSWORDS`.

## 7. Commands

| Task | Command |
|---|---|
| Dev / build / prod | `npm run dev` (port 3000) · `npm run build` · `npm start` (port 3030) |
| Typecheck / lint | `npm run typecheck` · `npm run lint` (weak config: no next/react-hooks rules) |
| Unit | `npm run test:unit` (scripts pass `--experimental-strip-types`, needed on Node 22.15; `measurement_units` needs the DB) |
| Integration | `npm run test:integration` (KML only; `sap_worker.test.js` is not wired into any script) |
| DB tests | `npm run test:db` → `python3 db/tools/run_tests.py` (on Windows `python3` may be `python`) |
| API | `IAM_TEST_BASE=… IAM_TEST_PASSWORDS=… npm run test:api` (needs a running server and DB) |
| E2E | `BASE_URL=… IAM_TEST_PASSWORDS=… npm run test:playwright` |
| Demo DB | `npm run demo:setup` (rebuilds `lms_demo` only) |
| All release checks | `scripts/run_all_checks.sh` |

## 8. Rules to follow (from PROJECT_RULES.md, GSD-STYLE.md, RELEASE_GATES)

- **Process:** SPEC → PLAN → EXECUTE → VERIFY → COMMIT. SPEC is FINALIZED.
- **Proof for every change:**

  | Change | Proof |
  |---|---|
  | API | curl output |
  | UI | screenshot |
  | Build | command output |
  | Test | runner output |

  "Should work" is not accepted.
- **Commits:** `type(scope): description` (feat|fix|docs|refactor|test|chore). One task per commit, verify first, never `--allow-empty`.
- **PowerShell 5.1** cannot parse `&&` or `||`. Use `;` or the Bash tool.
- **SQL:**
  - parameterized only
  - snake_case, schema-qualified tables
  - UUID primary keys
  - money rules live in `api.*` routines; never trust a client-sent rate
  - RLS policies wrap actor functions: `(SELECT lms.actor_provinces())`
- **Lists:** bounded via `lib/paging.ts` (default 100, max 500) and return `page.total`. KPIs come from aggregates, not from on-screen rows.
- **Reports and gates:**
  - Reports state the command, DB and date; anything not run is "NOT EXECUTED".
  - Gate statuses: PASSED / FAILED / BLOCKED / SKIPPED / NOT EXECUTED.
- **Do not edit** `archive/requirments/` (client material). Move unused files to `archive/nonessential-files/` with a MANIFEST.md entry.
- `nav.ts` is the single source for the menu and route permissions. Keep pages and APIs in sync with it.

## 9. Open blockers, gaps and known issues

**Release blockers (2026-10-29):**
- REQ-06: LAA 1894 Section 4/6/9/11 milestones (needs a business decision).
- WHT override policy (APP-12, needs Finance confirmation).
- NFR-10: real SSO (AD/Entra). Code for LDAP/OIDC/SAML/passkey exists, but it is not verified against the real IdP.
- DEP-01: maplibre-gl advisory.
- No stakeholder UAT; no production-like performance run (dashboard p50 is 5.6 s at 25 users).

**Functional (docs/requirements/GAP_LIST.md, 76 gaps; inventory has 120 reqs: 42 implemented / 49 partial / 18 missing):**
- Approval by designation (REQ-36/42) **is enforced** (verified 2026-10-30): land-request tiers check `app_user_group` in the route and in the DB triggers. But no account holds those positions (see §9b).
- 50% tranches are simulated (REQ-68).
- Missing:
  - flare-pit workflow (REQ-43)
  - past-pending workflow (REQ-44)
  - case classification (REQ-47)
  - reject/return with remarks (REQ-49)
  - project status report (REQ-79)
  - notifications (REQ-39)
  - renewal approval (REQ-59)
  - receipt document (REQ-65)
  - Division admin level (REQ-01)
- 9 source conflicts are waiting on a Mari decision (see REQUIREMENTS_INVENTORY.md).

**Security (docs/SECURITY_FINDINGS.md):**
- APP-04: no CI scanning.
- APP-05: no logging or alerting.
- APP-10: invite/reset links shown to admins.
- DEP-02: rotate 2 DB passwords.
- DB-03: no TLS.
- DB-07: backups unencrypted, no PITR.
- DB-08 / DB-09: no object store, no DB activity monitoring.
- CSP still allows `style-src 'unsafe-inline'`.
- No DENY audit logging.
- Accepted risks have no named signer.

**Code issues (status as of 2026-10-30):**
1. FIXED: hard-coded `localhost:3040` / `127.0.0.1:3040` in `sameOrigin()` (`lib/iam/http.ts`). Extra origins now come only from `APP_ALLOWED_ORIGINS`. Live since the user rebuilt and restarted on 2026-10-30. Verified: localhost, 127.0.0.1 and the LAN IP get 200; a foreign origin gets 403.
2. OPEN, low priority: `DATABASE_URL_ADMIN` sits in `.env.local` (scripts need it; the app never reads it); `JWT_SECRET` is unused. Left as they are.
3. FIXED: `RoleSwitcherModal`, `WorkflowStepper` and `Can.tsx` moved to `archive/nonessential-files/` (listed in MANIFEST). Two things stay on purpose:
   - `lib/auth.ts` is a deliberate tombstone that stops the old insecure helpers from being imported;
   - `api/auth/sso/*` are deliberate 404 stubs for the retired simulator.
4. NOT A BUG: the `authenticatedOnly` routes each check the exact permission inside the handler (payments by action, request tiers by group, import create/update, inbox comment needs `<resource>:update`, units needs `settings:update`, search/calendar filter by `<module>:read`). `documents` PUT archive needs `documents:update`.
5. FIXED: the bogus `src/pages` glob was removed from Tailwind. ESLint is still weak, by choice.
6. PARTLY FIXED: README and db/README counts updated. Still open:
   - `.gsd/STATE.md` and the ROADMAP header are stale;
   - `.gsd/phases/9/` is missing;
   - the multi-agent "PRODUCTION READY" report is discredited.
7. OPEN (needs the user's OK): **git has one commit; `src/`, `package.json`, `tests/`, migrations 0019–0048 and most docs are UNTRACKED.**
8. FIXED: `scripts/ingest_reference_data.ts` pointed at `requirments/`, which moved to `archive/requirments/`. It now checks both paths.
9. FIXED: `npm run test:unit` / `test:integration` failed on Node 22.15 (`.ts` imports). The flag was added.
10. OPEN: **6 DB test files fail, and did before 0047** (checked by rebuilding at 0046):

    | Test | Error |
    |---|---|
    | test_01 | expects 23503, gets P0002 since 0046 |
    | test_02 | DHRK-001 released amount |
    | test_13 | direct insert into `survey_ownership_share` is now denied |
    | test_14 | reconcile finds 2 exceptions |
    | test_20 | `register_ownership` arguments |
    | test_21 | voucher raiser = releaser SoD |

    Each needs a decision: is the test or the code wrong?

## 9b. RBAC audit (2026-10-30), with live sign-in of all 16 demo accounts

**Where it is defined:**

| What | Where |
|---|---|
| Permissions | `iam.permission` (resource:action; `is_sensitive` means MFA) |
| Role → permission | `iam.role_permission`, with a scope level |
| User → role | `iam.user_role` |
| Approval position | `lms.app_user_group` |
| Stage → position | `lms.workflow_step_group` |
| Province access | `lms.app_user_province` |
| SoD / admin override | `lms.system_setting` `workflow.sod_mode` = strict, `workflow.admin_override` = false |

Role grants are maintained in migrations 0023, 0039–0044, **0047 (the authoritative matrix)** and **0048**. The demo seed (`db/seed/seed_demo.sql`) was fixed to map `legal`→legal-advisor, `nego*`→negotiation-officer and `viewer`→viewer with no group.

| User(s) | Role | Province | Approval position | Can do |
|---|---|---|---|---|
| admin | system-administrator | all | System Administrator | users, roles, settings, audit, reports, **Landowner Register report (read-only, CNIC masked, 0056)**. No business registers (SoD). |
| audit | security-auditor | all | Internal Audit | read-only on every register plus audit/users/roles. CNIC masked. |
| lofield, loquetta, lopnj | data-entry | SND / BAL / PNJ+KPK | Land Officer (Field) | create and update field records, raise payments, import staging |
| nego, negoqta | negotiation-officer | SND / BAL | Negotiation Group | cases (approve "Checked"), leases, ROW, acquisitions, grievances, DBPFC read |
| legal | legal-advisor | all | Legal Advisor | legal, acquisitions, mutations, encroachments, cases (approve "Reviewed") |
| sradmin, sradmqta, sradmpnj, dmfield, dmqta | case-approver | SND / BAL / PNJ+KPK | Sr. Admin / DM-TL | field approvals, import promote, DBPFC |
| mland | land-manager (head_office) | all | Manager Land (HO) | HO approvals, **payment release**, budgets |
| finance | finance-approver | all | Finance Officer | **payment verify**, holds, reconcile, budgets |
| viewer | viewer | all | — | dashboards, reports, GIS, read-only portfolio |

**Verified working:**
- Province isolation: each field user sees only their own provinces.
- Every workflow step is checked by designation group in `api.advance_workflow`.
- SoD: the preparer cannot approve, and one person cannot approve two tiers.
- User admin is admin-only.
- Payments: Finance verifies, Manager Land releases.
- The menu (`nav.ts`) matches the API permissions.

**Land request positions (2026-10-31):** demo accounts now hold them (`db/seed/seed_exploration_accounts.sql`): `dirops` (Director Operations, all), `regmgr`/`regmgrqta` (Regional Manager, SND/BAL), `landaffairs`/`landaffqta` (DM / TL Land Affairs, SND/BAL); `explorer`/`explorerqta` are Exploration Planners. The real holders are still a business decision.

**Side effect of 0047:** the administrator can no longer build custom roles that contain business permissions, because a granter must hold what they grant. So nobody can create a custom business role today.

## 10. GSD process (in short)

- `/plan` → `.gsd/phases/{N}/{n}-PLAN.md` with XML `<task>` blocks (name / files / action / verify / done).
- `/execute` → one commit per task + SUMMARY.md.
- `/verify` → VERIFICATION.md built from fresh evidence.
- Also: `/debug` (3-strike rule), `/pause` / `/resume`, `/map`.
- Update `.gsd/STATE.md` after tasks when working inside a GSD phase.
- Roadmap: Milestone 2, phases 1–9 marked complete (phase 6 verification was PARTIAL).

## 11. Reference files (read when relevant)

- **Rules:** `PROJECT_RULES.md`, `GSD-STYLE.md`, `adapters/CLAUDE.md` (optional effort tips)
- **Spec / requirements:** `.gsd/SPEC.md`, `.gsd/REQUIREMENTS.md`, `docs/requirements/{REQUIREMENTS_INVENTORY,TRACEABILITY_MATRIX,GAP_LIST}.md`
- **Gates / status:** `.gsd/RELEASE_GATES.md`, `docs/reports/RELEASE_ASSESSMENT_2026-10-29.md` (latest), `.gsd/STATE.md`
- **Authorization:** `docs/AUTHORIZATION_MODEL.md`, `docs/RBAC_PERMISSION_MATRIX.md`
- **Reports:** `docs/REPORTING_MODEL.md`
- **DB:** `db/README.md`, `docs/DATABASE_ENGINEERING_REPORT.md`, `docs/DATABASE_SECURITY_REVIEW.md`, `docs/QUERY_PLAN_EVIDENCE.md`
- **Security:** `docs/SECURITY_FINDINGS.md`, `docs/security/SECURITY_ARCHITECTURE.md`, `docs/compliance/*`
- **Architecture:** `docs/architecture/DATA_FLOW_DIAGRAMS.md`, `.gsd/ARCHITECTURE.md`, `graphify-out/GRAPH_REPORT.md`
- **Project skills:** `.agents/skills/lms-auth-rbac-security`, `lms-requirements-traceability`, `lms-workflow-uat`, `postgres-data-integrity`, `nextjs-fullstack-dev`, `playwright-a11y-automation`, `design-compliance`
- **GSD agents:** `.agents/agents/gsd-{planner,executor,verifier,researcher,debugger}.md`
- **Workflows:** `.agent/workflows/*.md` (plan, execute, verify, debug, pause, resume, map, …)
- **Ignore:** `.agent/skills/earllm-build` (unrelated Android project); `.agent/skills/go-playwright` (Go, not used here)

---

## Task Log (newest first; add one line per task)

| Date | Task | Files touched | Notes |
|---|---|---|---|
| 2026-11-02 | Live outage (pm2 list empty, 503) + one-command VPS deploy | new `scripts/deploy_vps.sh` (start lms-db, backup, migrate, demo seeds if demo on, npm ci + build, start/restart lms-app on 8003, pm2 save, @reboot cron with nvm loaded); pushed 1caf3c1 + 0edb45e | Cause: pm2 daemon came back empty and the old `@reboot pm2 resurrect` cron had no nvm, so nothing restarted. Update flow on VPS: `cd ~/apps/lms && git pull && bash scripts/deploy_vps.sh`. Advised a 5-minute watchdog cron (pm2 ping + resurrect). Not yet run on the VPS by the user at time of writing. |
| 2026-11-02 | **Client demo walkthrough** (all 8 client points, role by role, with data) + 2 fixes found while rehearsing | new `docs/manuals/06_CLIENT_DEMO_WALKTHROUGH.md` + `export/06 LMS Client Demo Walkthrough.{docx,pdf}`, manuals README; `legal/page.tsx` (**parcel + landowner pickers**: before, a stay order saved from the screen linked nothing and held no payment; LIT-0004/0005 in lms_dev have no links), `api/users/route.ts` (a date-only "valid until" now ends that day in PKT, not 23:59 UTC = next day 04:59 PKT) | Rehearsed the whole script through the API on `lms_democheck` (copy of lms_dev, dropped afterwards): 63 checks, 0 failures; codes REQ-2026-0004, ACQ-2026-0004, CC-2026-0012, VCH-2026-00034…37, CHQ-25186412, LIT-0006, MUT-0007. Found: lifting a court stay needs payment-hold authority (mland), not the Legal Advisor; header search returns the landowner only. Browser checks: legal form pickers, Cancel voucher, explorer inbox. tsc/lint/build pass. Needs rebuild + restart. lms_dev untouched by the rehearsal. |
| 2026-11-02 | Decided the 3 open mutation/ROW questions (user: "decide professionally") | migration **0062**; `api/payments/route.ts` (`cancel` action: Finance, reason, lifts the voucher's own holds first), `payments/page.tsx` (Cancel voucher button + dialog); tests `db/tests/test_25_mutation_parcelwise_hold.sql`, `tests/regression/voucher_cancel.test.ts`; report §10 | (1) unreleased vouchers of the old owner are **held**, not cancelled; Finance cancels or lifts; (2) a case where the old owner keeps another parcel is split **parcel-wise** by line value; (3) ROW hand-over stays **Leased**. DB 26/26 (919); API rerun 109/109; full API 1545/1548 (workflows leftover data + 2 fixed/flaky). All 3 DBs at 0062. Needs rebuild + restart on 3040. |
| 2026-11-02 | **Implemented all client requirements (P0 + P1) + full verification** (local only; live not touched) | migrations **0060**, **0061**; seed `db/seed/seed_director_account.sql` (+ in `setup_demo.mjs`); `api/requests/*` (COMPLETE action, progress, `work`), `requests/page.tsx` (Land ready step/KPI, Mark land ready, progress strip), `api/inbox/landRequests.ts` + inbox page, `api/leases` + `leases/page.tsx` (`?from_request=` pre-fill + link), `api/units` (province factors, unit lists, province conversion), `settings/_components/UnitsTab.tsx` + Settings tab, `surveys/page.tsx` (province units first), `api/users` + `UserAccess.tsx` + `users/page.tsx` + `users/grantExpiry.ts` (valid-until set/change/remove = revoke + re-grant), `api/landowners` + page (duplicate CNIC/name check), `api/surveys` (named khasra conflict), `api/mutations` + page (re-pointed payments), `components.css` (mobile chooser), `nav.ts` (Settings for identity-settings readers), `gis/page.tsx`, `landRequestArea.ts`, `reporting/catalog.ts`; tests `db/tests/test_23_mutation_repoint.sql`, `test_24_request_completion_units.sql`, regression `land_request_gis` (+2), `inbox_land_requests`, `temp_access_duplicates`, `grant_expiry`; report §9 in `docs/reports/CLIENT_REQUIREMENTS_ANALYSIS_2026-11-02.md` | lms_dev, lms_test, lms_iam_test at 0061. `director` (all 33 tabs, read-only) added to lms_dev + `.data/demo-credentials.json` (26 accounts). Results: tsc/lint/build pass; unit 42/42; KML 9/9; DB 25/25 (904); new API tests 30/30; full API 1541/1546, the 5: 3 passed on rerun (timing flakes + a test fixed to use a fresh voucher period), `workflows` case (6 leftover cases on AREA-000007 in lms_iam_test; rebuild it) and `passkey` fixture (known). Browser (3041): Sindh visible at 390 px, completed request details, Land units tab, khasra unit groups. Open business questions in report §9. **User's 3040 server needs `npm run build` + restart.** |
| 2026-10-31 | **Built Phase 1 of the exploration land request on the GIS map** (user: both the Exploration Planner and the Land Officer raise requests) | migration **0057**; `db/seed/seed_exploration_accounts.sql` (7 demo accounts; also loaded by `setup_demo.mjs`); `src/lib/geo.ts` (area, centroid, point-in-polygon, self-crossing, overlap, lat/long paste and KML parsing); `src/lib/landRequestArea.ts`; `api/requests` (rewritten on ctx.client: drafts private, `?geo=1` layer, `?id=` detail with versions, parcels inside, warnings), new `api/requests/[id]` PATCH (requester edits Draft/Returned → new polygon version), `api/requests/[id]/transition` (+SUBMIT, WITHDRAW, HANDOVER with optional marking of Proposed parcels inside as Under Acquisition); `api/auth/me` returns `groups`; `components/gis/LandRequestDrawer.tsx` + `gis/page.tsx` (draw by click, drag corners, editable lat/long table, paste, KML, live area/parcels/warnings, Land requests layer coloured by stage, `?request=` / `?edit=`); `requests/page.tsx` (new stages, Details modal, Send/Withdraw/Edit on map/Start land work); PageGuard sends a user without /dashboard to /gis or their first page; CSS; `tests/regression/land_request_gis.test.ts`, `tests/unit/geo.test.js`; `docs/testing/EXPLORATION_LAND_REQUEST_TEST_GUIDE.md` | Applied to lms_dev, lms_test (clean rebuild), lms_iam_test; 7 accounts added to lms_dev with passwords in `.data/demo-credentials.json` (now 23). Results: tsc/lint clean; unit 42/42; DB 23/23 (842; it caught a PUBLIC-executable trigger function, fixed in 0057 before lms_dev); new API flow 10/10; full API 1480 pass / 2 fail / 34 skipped: the failures (directory sign-in 503, recovery file) need the test IdP, which was not running, and roles reauth trips `login_session_expiry_ck` in a test fixture, none of them land-request code; Playwright (temporary spec, deleted) on a 3041 test build: explorer lands on /gis, draws 4 corners, submits; dirops sees Details and the polygon on the map. On Windows: `rebuild.sh` needs a `python3` shim on PATH in /c/... form and `PGUSER=postgres`; earlier failed sign-ins leave a 15-minute per-IP rate limit (audit-based) that makes the API suite fail with 429. Not built: pre-filled acquisition/lease/case on hand-over, lines with width, PostGIS, land requests in Approvals & Alerts. **Needs rebuild + restart.** |
| 2026-11-02 | Client requirements analysis (8 messages after the first demo) + plan | new `docs/reports/CLIENT_REQUIREMENTS_ANALYSIS_2026-11-02.md` (source `clientrequirement.md`) | Analysis only, no code. **Live site returned 503** on 2 Nov (Apache proxy; pm2 likely not running). Built: exploration request + approvals + hand-over + acquisition, CNIC/khasra uniqueness, court stay → payment hold, mutation moves shares, province unit lists. Gaps: acquisition Handover does not mark khasras Acquired or close the request ('Land ready'), the requester cannot see acquisition progress, no role end date in the UI, no all-tabs demo account (audit 31/33, mland 27, admin 10), **mobile province chooser cuts off Sindh** (`.screen` vertical centring), the survey form offers all units in every province, unit factors not editable and not per province, an applied mutation does not re-point open-case payments, purpose list shorter than the prototype. P0 list for before the demo, P1 after. |
| 2026-10-31 | **LIVE on DreamHost VPS** (`https://land-management.alisonstech-dev.com`) | server only (no repo change) | VPS vps55680, user `landmanagement`, no sudo. Code in `~/apps/lms` (git clone of main); PostgreSQL 18.6 (micromamba `~/pg18`, data `~/pgdata`, 127.0.0.1:5433, pm2 `lms-db`); DB `lms_prod` restored from the lms_dev dump (58/58 applied, 0 drift, 27 users); documents in `~/lms-data/documents`; `.env.production.local` with the PC's IAM keys; app on pm2 `lms-app`, **`-H 0.0.0.0 -p 8003`** (DreamHost proxy port 8003; on 127.0.0.1 the proxy gave 503); cron `@reboot pm2 resurrect`. Role passwords in `~/.pg_{super,migrator,app}_pw`. **Demo mode is ON on live** (user's choice) with `~/lms-data/demo-credentials.json`. Gotcha: its `"database"` field must equal the live DB name (`lms_prod`), or `/api/auth/demo-accounts` hides the list. The `lms_app` DB password was pasted in chat: rotate it. Backup cron: given, not confirmed. |
| 2026-10-31 | Deployment guide rewritten for the GitHub + pm2 flow | `docs/deploy/DREAMHOST_VPS_DEPLOYMENT.md`, export `docs/deploy/export/… (GitHub + pm2).{pdf,docx}` | Main path: git push → clone/pull on the VPS, PostgreSQL 18 via micromamba under pm2 (lms-db, :5433), app under pm2 (lms-app, :8040), DreamHost Proxy + Let's Encrypt; start options A exact copy / B empty / C demo; backups, the update flow, troubleshooting, checklist; the sudo route is now a short appendix. |
| 2026-10-31 | **Pushed to GitHub** + go-live plan with the exact DB | new `.gitignore` (secrets, `.data/`, dumps, `db/live-snapshot/`, `archive/requirments/` excluded), `.gitattributes` (LF), `.env.example`, `docs/deploy/GO_LIVE_PLAN.md` | Repo https://github.com/HassnainYaqoob789/land-management-system (**public**, user's choice; client files excluded at the user's request). New orphan branch **`main`**, one clean commit (844 files), because old `master` commit 3b06b90 contains client files under `requirments/`; `master` kept locally, never pushed. Secret scan: placeholders only. `db/live-snapshot/lms_dev.dump` + `documents.tgz` made for scp (ignored by git); the dump was restored into a scratch DB: 58/58 applied, 0 drift, counts match, all owned by lms_owner. The server needs PostgreSQL 18 (conda-forge) and the same IAM keys as the PC. |
| 2026-10-31 | Deployment guide: managed VPS path (no sudo, pm2) | `docs/deploy/DREAMHOST_VPS_DEPLOYMENT.md` §11 | User has no sudo and uses pm2. PostgreSQL 16 is installed in the home folder with micromamba (conda-forge) and initdb on 127.0.0.1:5433; pm2 runs `lms-db` and `lms-app` (127.0.0.1:8040); domain, proxy and Let's Encrypt come from the DreamHost panel; cron @reboot runs pm2 resurrect, plus a nightly pg_dump. Not tried on DreamHost itself; the guide asks the user to check that the 4 extensions are present first. |
| 2026-10-31 | DreamHost deployment guide | new `docs/deploy/DREAMHOST_VPS_DEPLOYMENT.md`, new `db/seed/seed_production_admin.sql` (first admin on an empty DB: system-administrator role, System Administrator position, all provinces; idempotent) | Guide: Ubuntu 24.04 + sudo (DreamCompute), PG16, roles → db → migrate.py → `.env.production.local` (lms_app, new IAM keys, COOKIE_SECURE, TRUST_PROXY_HOPS=1, demo mode off) → npm ci/build → systemd on 127.0.0.1:3040 → nginx + certbot → admin → backups. Warns that DreamHost **managed** VPS has no root or PostgreSQL. Verified the empty-DB path on a throwaway `lms_prodcheck` (migrations up, admin seed twice, bootstrap password), then dropped it. 03b voice script also trimmed to the segments only. |
| 2026-10-31 | Google Vids narration (short) | `docs/manuals/export/Google Vids script/Part 1–3.txt` (each ≤2,500 chars), source `docs/manuals/03c_GOOGLE_VIDS_SCRIPT_SOURCE.txt` | Starts at login. Each scene is one line on what it is and why, then the steps; no SSML. About 920 words, roughly 6 minutes of voice. Long values (CNIC, IBAN, coordinates, justification) are pasted from the 05 Demo Data. |
| 2026-10-31 | AI-voice sync script for the demo video | `docs/manuals/03b_AI_VOICE_SYNC_SCRIPT.md`, `export/03b …{docx,pdf}`, `export/AI voice segments/*.txt` (38 clips + all-in-one) | Voice split into 38 short clips (one per action block; record one screen clip per voice clip and join in editing, so logins and page loads happen off camera). The voice reads each form value as it is pasted; `<break time>` tags of 3 s or less (ElevenLabs). Win+V clipboard-history tip for fast entry. About 15 min of audio. |
| 2026-10-31 | Docs exported as Word + PDF | `docs/manuals/export/` (01/02/03/05 .docx + .pdf, 04 one-page .pdf + .png), README | Generated with a scratchpad converter (python-docx + Playwright print, mermaid via CDN; LR flows drawn top-down for A4). Also published as claude.ai artifacts (Docs type + diagram page), but those are private to the Claude Code account (omair…), so the user's other account sees 'Page not found': share from that account, or use the exported files. |
| 2026-10-31 | Documentation & demo pack (5 deliverables) | new `docs/manuals/`: README, 01_COMPLETE_USER_MANUAL.md (~17k words), 02_KEY_FEATURES_USER_MANUAL.md, 03_KEY_FEATURES_DEMO_VIDEO_SCRIPT.md, 04_ARCHITECTURE_WORKFLOW_DIAGRAM.{html,md,png}, 05_DEMO_RECORDING_DATA_AND_SCENARIOS.md | Docs only, no code. 2/3/5 share one storyline and data: DHRK-301 → AREA-000034/35 (Jarwar, 12 ac + 64 Kanal) → Mahar brothers SND-000047/48 (Filer/Non-Filer) → REQ-2026-0004 (20.19 ac, returned once, v2 15.83 ac) → ACQ-2026-0004 → CC-2026-0012 (Rs 2,458,000) → VCH-2026-00034 (Rs 1,000,000 gross, net 900,000) → CHQ → RCPT-2026-0101; take-2 values included. Form fields verified against code and lms_dev. The complete manual marks 5 'to be confirmed' points (MFA policy for production, reset mail, no lease-termination control on screen, grievance due days 14 vs 15, 0% WHT for govt payees). |
| 2026-10-31 | **End-to-end audit + fixes** (4 parallel module audits; report `docs/reports/E2E_AUDIT_2026-10-31.md`) | migrations **0058** (land request ↔ acquisition link) and **0059** (case voucher cap at award, deceased payee refused, case/lease voucher must name the landowner, held lease + parcel stay reach every line kind, no receipt on reversed cheque, case needs owners to approve, reversals excluded from paid views, `v_payment_release.reversed_at`, land-request tier reset on resubmit); routes acquisitions, requests/*, calendar, surveys, analytics/kpis, reports/person, leases, projects; pages acquisitions (Create acquisition from request), requests, surveys, legal (court-order field to lift a stay), payments, dashboard, projdash, nav.ts; seed + `regmgrpnj`, `landaffpnj` (25 demo accounts); tests `audit_fixes_2026_10_31.test.ts`, land_request_gis +3, reporting_api/roles updated | 23 confirmed defects fixed (F1–F23), 17 open items listed with priority (O1–O18). **O1 urgent: 3040 runs LMS_DEMO_MODE=on bound to the LAN, so `/api/auth/demo-accounts` gives every password to the LAN.** Results: tsc/lint/build pass; unit 42/42; KML 9/9; DB 23/23 (clean lms_test at 0059); API 1526/1529 (3 env/test-data, explained in report); audit-fix tests 10/10; land-request API 13/13; browser flow PASS; full Playwright 14 pass / 73 fail / 4 skip / 13 not run, all test drift (39 wait for the old 'Select province' h2, 5 psql not on PATH). All three DBs at 0059. API suite needs: test IdPs (`node scripts/test-idp/server.mjs <dir> http://localhost:3041`), server env NODE_EXTRA_CA_CERTS/SMTP_*/DOCUMENT_STORE_DIR matching the runner, IAM_TEST_IDP_CONFIG. lms_iam_test accumulates cases (workflows test may need a rebuild). Needs rebuild + restart on 3040. |
| 2026-10-31 | **Built exploration land requests on the GIS map** (plan Phase 1 + part of 2) | migration **0057** (roles `exploration-planner`, `land-request-reviewer`; `lms.land_request_area` versioned polygons, append-only, RLS, DB shape/requester/stage checks; stages Draft/Returned/Handed over/Withdrawn; hand-over trigger = Land Officer (Field) only), `src/lib/geo.ts`, `src/lib/landRequestArea.ts`, `api/requests` (draft, polygon, `?geo=1` layer, `?id=` detail with versions/parcels inside/warnings), new `api/requests/[id]` PATCH, transition (SUBMIT/WITHDRAW/HANDOVER + mark parcels Under Acquisition), `api/auth/me` (+groups), `components/gis/LandRequestDrawer.tsx`, `gis/page.tsx` (draw: click/drag/paste lat-long/KML), `requests/page.tsx` (Details, Send/Withdraw, Start land work), PageGuard (no-dashboard roles land on /gis), CSS, `db/seed/seed_exploration_accounts.sql` (explorer, explorerqta, dirops, regmgr, regmgrqta, landaffairs, landaffqta), `setup_demo.mjs`, tests `tests/unit/geo.test.js`, `tests/regression/land_request_gis.test.ts`, guide `docs/testing/EXPLORATION_LAND_REQUEST_TEST_GUIDE.md` | Both Exploration Planner and Land Officer raise requests (user decision). lms_dev at 0057; 7 accounts added to `.data/demo-credentials.json` (23). Verified: unit 42/42, DB 23/23 (clean lms_test rebuild; found and fixed a PUBLIC-executable trigger function), new API flow test 10/10 on 3041. Full API suite and Playwright UI run NOT EXECUTED to completion (session ended; earlier run blocked by 429 rate limit from my own wrong-password logins). User tested the flow live on 3040 (REQ-2026-0002, polygon outside every khasra so nothing marked); I ran REQ-2026-0003 via the 3040 API: AREA-000032 → Under Acquisition. Hand-over message now explains when no parcel is marked (needs rebuild). Temp file `tests/e2e/zz_tmp_land_request_ui.spec.ts` still present. |
| 2026-10-31 | Proposal v2: roles and full flow | `docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md` | Link to Land Requests (confirmed by user). New role **Exploration Planner** = the "Initiator" the land-request route already names; new role **Land Request Reviewer** for Director Ops / Regional Mgr; Land Affairs = case-approver account; Land Officer takes over after approval ("Handed over"). New stages Draft + Handed over. Plan only. |
| 2026-10-31 | Proposal: exploration user draws land polygons on the GIS map | `docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md` (new) | Plan only, nothing built. Extend Land Request with a versioned polygon (`land_request_area`), Terra Draw + Turf.js, existing 3-tier approval, new Exploration role and demo approver accounts; 3 phases; 7 open business questions. |
| 2026-10-31 | GIS: survey markers missing on first load (appeared only after toggling "Survey parcels") | `src/app/gis/page.tsx` | Cause: the layer effect bailed out on `map.isStyleLoaded()`, which is false while basemap tiles are still downloading; nothing re-ran it until a toggle. Now a `styleReady` ref is set on 'style.load' and cleared before `setStyle()`. Verified in Chromium (Playwright, lofield on a test build over lms_dev): markers drawn and auto-framed without touching the checkbox. Markers come from `GET /api/gis` → `lms.survey` rows with `lat`/`lng` (+ `api.v_survey_ownership`), coloured by `status_code`. Needs rebuild. |
| 2026-10-31 | **Landowner Register** tab (read-only, province-wise) for admin and the overseeing roles | migration **0056** (`landowner_report:read` → system-administrator, land-manager, security-auditor, finance-approver; view columns), recovered **0055** file, `lib/reporting/catalog.ts` (dataset `landowner_register`; OWNER_TYPE 'B' label fixed to 'Owner and attorney'), new `src/app/landowner-register/page.tsx`, `nav.ts` (Records & Reports → Landowner Register), `.fgrid-4` CSS | Filters: province (follows header chip), district → taluka/tehsil → deh/mouza, owner status/type, tax status, land class, payment hold, name, code, khasra; unit = province unit / as recorded / any common unit; grouping = detail, province totals, district totals, per owner; CSV/XLSX/PDF export via the engine. Verified through the built API on lms_dev: admin/mland/audit/finance run it (27 rows, all 4 provinces; CNIC masked for admin and audit), lofield/viewer/loquetta get 403; filters, Kanal conversion (Hassnain 10 ac = 80 Kanal), summaries and CSV export work; page redirects to /login without a session. tsc, lint clean. Needs rebuild. |
| 2026-10-31 | Receipt made fully dynamic for every payment kind | `api/payments/route.ts` (`receiptDocument` rewritten: kind case/lease/dbpfc/standalone; parcels from case lines, `lease_survey`, `dbpfc_survey`, grouped by revenue location; per-head quantities (lease area×rate×term, each crop's damaged acres×rate, trees by species/size, misc items); case vouchers spread over the case's heads; payee share/capacity and settlement (payable, paid before, this, balance) from `api.rpt_case_owner`; lessor count; reversal from `payment_release_reversal`; instrument by payment mode), `payments/page.tsx` (`receiptHtml`: share clause, settlement table, declaration = full and final / part payment / government acknowledgement / void; advance-rent clause only for non-one-time rent; CANCELLED watermark; signatory block for non-landowners; "Payee"/"Self" = in person) | Verified through the built API on 7 real receipts: lms_dev (Hassnain crop, Mukhtiar 60% part payment with lease+crop+tree+misc, 2 stand-alone) and lms_iam_test fixtures `RCTFX-*` (lease rent with 2 lessors, DBPFC Pay Order to Govt with 0% WHT, reversed IBFT). tsc, lint clean. Not done: Urdu/Sindhi version. Needs rebuild. |
| 2026-10-31 | Receipt wording fix (user spotted it) | `api/payments/route.ts` (returns `lease_acres`, `crops` [crop, damaged_acres, rate], `tree_count`, `parcel_acres`), `payments/page.tsx` | The receipt said "land measuring 10.00 acres" (the whole parcel) for a 5-acre wheat damage. It now states the basis: lease area for a lease, "5.00 acres of damaged wheat" for crops, tree count; the parcel area is shown only as "(recorded area …)", and the crop line shows "wheat, 5.00 ac × Rs 20,000/ac". tsc and lint clean. Needs rebuild. |
| 2026-10-31 | Built the printable **Receipt of Payment** (REQ-65, was Missing) | `api/payments/route.ts` (`GET ?receipt=<id>`: receipt + cheque + voucher + payee + case/lease + parcels + revenue location + breakdown by head, RLS + `payments:read` record scope, PII redacted), `lib/domain.ts` (`amountInWords`), `payments/page.tsx` (`receiptHtml`, "Print receipt" button in the Receipts table), `tests/unit/domain.test.js` (+3) | Layout follows `archive/requirments/Reports and documents/Sample Payment Receipt.png`; adds Gross / less WHT / Total lines because the cheque is net. Still missing from REQ-65: Urdu/Sindhi version. Verified the SQL on `lms_dev` as finance (RCPT-2026-0030 → CHQ-25186410, 90,000, Taluka Mirpur Mathelo, District Ghotki) and that BAL `loquetta` cannot see it. tsc, lint, unit 32/32. **Needs rebuild + restart.** User also completed the full manual flow for Hassnain Yaqoob (SND-000044): TEST-001 → AREA-000032 → CC-2026-0010 → VCH-2026-00030 → CHQ-25186410 → allocation → RCPT-2026-0030; statement balance 0. |
| 2026-10-30 | Ran **every** test suite; fixed the real bugs found and outdated tests | migrations **0050** (allocate_payment: a case in another province reads as not found, no code leak), **0051** (REQ-YYYY- code template: land requests failed on any DB built from migrations), **0052** (secret audit metadata key: no SSO provider with a secret could be saved), **0053** (parcel-commitment triggers SECURITY DEFINER: **every app-saved case with a lease line failed at COMMIT, 403**), **0054** (group_mapping UNIQUE NULLS NOT DISTINCT); `sso/respond.ts` (**OIDC/SAML session cookie was dropped by clearBinding**: nobody could sign in by OIDC/SAML); `api/requests` (blank concession_name used the NOT NULL default); CNIC auto-format (`formatCNICInput`, 4 inputs); `.area-in` CSS (area box squeezed to a sliver); `.env.local` += DOCUMENT_STORE_DIR (uploads 500'd in production mode); `next.config.ts` distDir from NEXT_DIST_DIR; test harness Windows fixes (CRLF, stdin SQL, npx shell, PG18 RESTRICT code); many tests updated for 0043/0046/0047 behaviour; `test:sap` script; hard-coded DB password removed from `tests/unit/measurement_units.test.js` | **DB 23/23 (842 assertions), API 1505/1505 (+1 order-dependent skip), unit 29/29, KML 9/9, SAP 5/5.** **Playwright: 36 pass / 136 fail, NOT fixed**: mostly UI test drift (login brand mark is now the logo; province chooser flow), plus 2 real a11y issues (`.side-foot` contrast, `#uMenuBtn` label). Test setup: `lms_iam_test` on 3041 from `.next-test`, IdPs from `scripts/test-idp/server.mjs`. Next.js added `.next-test/types/**/*.ts` to tsconfig include (harmless). `lms_dev` at 0054. |
| 2026-10-30 | Fixed the statement and CNIC-search bugs | migration **0049** (statement: every payment line gross, net + WHT in the description), `api/landowners/route.ts` (payment lines, balance and paid_to_date only with `payments:read` for the owner's province → `payments_shown`), `landowners/page.tsx` (uses `payments_shown`, explanatory note, "Paid to date (cheques, after tax)"), `api/payments/route.ts` (CNIC search needs `pii:read`), `api/mutations/route.ts` (search adds CNIC [pii], mutation_type, revenue_mutation_no), `seed_demo_transactions.sql` (cheque no longer back-dated), test guide updated | `lms_dev` at 0049. DB suite 17/6 (same 6 as before). Statement balance = owed amount for every landowner on lms_test. tsc and lint clean. F3/F4 were not defects. **Needs rebuild + restart for the API/UI parts.** |
| 2026-10-30 | Explained the landowner statement and wrote a test guide | `docs/testing/LANDOWNER_STATEMENT_TEST_GUIDE.md` (new) | Statement = `api.report_landowner_statement` + `api.v_landowner_summary`; SND-000002 reconciles. Open bugs: (a) `landowners/page.tsx` hides payment rows on `'Payment released'`, a value never produced, and the API returns them anyway, so Legal (no `payments:read`) sees payment amounts; (b) payments search matches CNIC without `pii:read`; (c) Mutations search box promises CNIC but the API does not search it. Not fixed yet. |
| 2026-10-30 | GIS map showed "Access blocked" 403 tiles | `next.config.ts` (/gis Referrer-Policy override), `src/app/gis/page.tsx` (meta referrer while the map is mounted) | Cause: app-wide `Referrer-Policy: same-origin` drops the Referer, and OSM's tile policy blocks browser requests without one. Fix sends the origin only, on /gis only. tsc and lint clean. **Needs rebuild + restart.** |
| 2026-10-30 | Verified the rebuilt server (user ran `npm run build` and restarted on 3040) | CLAUDE.md | The origin fix is live; demo accounts still listed. The build warns about two lockfiles (`C:\Users\DELL\package-lock.json`); harmless, fixable with `outputFileTracingRoot`. |
| 2026-10-30 | Fixed §9 issues + full RBAC audit | `lib/iam/{http,config}.ts`, `.env.local` (+APP_ALLOWED_ORIGINS), migration 0048 (new), `seed_demo.sql`, tests 12/19/22, `ingest_reference_data.ts`, package.json test scripts, tailwind.config.ts, README, db/README, archived 3 components | Recorded 0047 and applied 0048 on `lms_dev`. DB suite at 0048: 17 pass / 6 fail (the same 6 failed before 0047). tsc and lint clean; unit+KML 25/25. Server **not restarted**: rebuild needed for the origin fix. |
| 2026-10-30 | Full project analysis; created this CLAUDE.md | CLAUDE.md | No code changed. Found issues in §9 items 1–7. |
