# Release assessment — 2026-10-29

**Verdict: not yet releasable to production.** The application is functionally
complete for the documented workflows, and every automated check below passed
on the final build. Five items still need an owner decision or work that cannot
be done in this environment (see [Blockers and decisions](#blockers-and-decisions)).
Formal stakeholder acceptance has not taken place.

Every result below was produced by a command run on 2026-10-29 against the
production build (`next build` + `next start`), not the dev server.

## Environment

| | |
|:---|:---|
| Host | Apple M1, 8 cores, 16 GB, macOS (developer workstation — not production-like) |
| PostgreSQL | 16.13, local Unix socket |
| Node.js | 26.10 · Next.js 15.5.28 · pool 20 connections |
| Functional database | `lms_iam_test` (seed + fixture accounts), server on :3041 |
| Volume database | `lms_perf`: current schema + `db/tools/perf_load.sql` (30,000 cases, 120,000 payment requests, 84,000 releases, 50,010 landowners, 60,013 surveys, 296,000 audit rows), server on :3043 |

## Gates

| Gate | Result | Evidence |
|:---|:---|:---|
| G1 Requirements traceability | **PASSED with open items** | `.gsd/REQUIREMENTS.md` matrix (verified 2026-10-29): 31 complete, REQ-06 partial, NFR-04/05 partial, NFR-10 not implemented, 4 superseded / not applicable |
| G2 Build, types, lint | **PASSED** | `tsc --noEmit` 0 errors · `eslint src` 0 · `next build` compiled; first-load JS 103 kB shared |
| G3 Unit and regression | **PASSED** | `test:unit` 24/24 · `test:integration` (KML) 4/4 · `vitest run tests` **307/307** (IAM 2 files, regression 5 files) |
| G4 Database integrity | **PASSED** | `run_tests.py` 16/16 suites, **484 assertions** · `migrate.py verify`: 38 on disk, 38 applied, 0 drift on `lms_dev`, `lms_iam_test`, `lms_perf` |
| G5 Separation of duties and holds | **PASSED** | workflows.test (each step by a different position; preparer refused), business_rules (stay order blocks release), user_journeys (refusal shown in UI) |
| G6 Browser and accessibility | **PASSED** | Playwright **84/84** (Chromium + mobile Chrome): every screen in the reference shell, axe WCAG 2.1 AA with colour contrast **on**, CSP violations fail the run, role journeys |
| G7 Audit trail | **PASSED** | db test_08 (append-only); report exports now recorded (business_rules) |
| G8 Security | **PASSED with residual risk** | 6 new findings fixed (APP-12…16, DEP-02); DEP-01 dependency advisories open — see below |
| G9 Performance at volume | **PASSED with limits** | see [Performance](#performance); no unbounded list endpoint remains |
| G10 UAT | **Simulated only** | 14 role scenarios executed as automated journeys (below); stakeholder sign-off **NOT EXECUTED** |
| Backup / restore | **PASSED (dev scale)** | `db/tools/backup.sh verify lms_dev`: dump 1.8 MB, restored to a scratch DB, row counts, financial totals, cheque numbers, audit span, schema and migration history identical |

## What changed in this pass

Defects found and fixed (each has a test that fails without the fix):

1. **Withholding tax could be set by the requester** and the documented
   non-filer = 2× rule was missing (APP-12). Migrations 0035/0037.
2. **No Content-Security-Policy or anti-framing headers** in production
   (APP-13). Nonce CSP in `src/middleware.ts`; headers in `next.config.ts`.
3. **User-admin actions** had no API-level permission check (APP-14).
4. **CSV export**: formula injection, no `reports:export` check, not logged (APP-15).
5. **Case transition via PUT** skipped `cases:approve` (APP-16).
6. **Credentials in the working tree** (README, `scripts/service_readiness.js`) (DEP-02).
7. **Unbounded lists** — every register returned in full (54 MB for payments):
   server-side paging, search and KPI summaries for all registers; database-search
   pickers for landowners, surveys, cases and vouchers in forms (PERF-01).
8. **Row-level security cost** ~23 µs per row → once per statement (0036).
9. **Case settlement** computed by a function per case → grouped join (0038);
   equivalence checked on all 30,000 cases (0 differences).
10. **Dashboard read field names the KPI API does not return**, so its tiles,
    portfolio table and province chart showed blanks; the KPI response repeated
    the portfolio three times (0.97 MB → 0.25 MB).
11. **Reports silently truncated** at 100–200 rows while printing "Total";
    reports now include every row in totals and exports, the screen shows 1,000.
12. **Calendar** read fields that do not exist (`title`, `has_stay_order`) and
    fetched whole registers; now one bounded `/api/calendar` query.
13. **GIS** lacked the reference's satellite basemap (REQ-16).
14. Smaller: lease "Survey parcel" dropdown read non-existent fields; inbox
    "waiting on you" filtered in the browser over an unbounded queue; a
    database-pool timeout returned 500 (now 503 + `Retry-After`); unknown amounts
    showed "Rs. 0" (now "—").

Test-suite repairs (none weakens an assertion):

- Six suites written for the pre-authentication build were archived to
  `tests/_archive/` with a README; every rule they asserted runs signed in
  in `tests/regression/`.
- The password-change test now restores the account it changes; the lockout
  test uses an account no other test uses; the mutation test creates its own
  transferor and parcel; a swallowed `catch` in the acquisition test was
  replaced by asserted steps.

## Performance

Measured with `scripts/perf/load_test.mjs` against :3043 (volume database),
signed in as the all-province read-only user (the widest row-level-security
scope) and, for the write, as the land officer. Each figure is milliseconds
per request; "req/s" is throughput at that concurrency.

Before this pass (single request, same data): `/api/cases` 15.4 s / 23 MB,
`/api/payments` 14.2 s / 54 MB, dashboard KPIs 16.0 s, payment liabilities 12 s.

| Endpoint | Size | 1 user p50 / p95 | 10 users p50 / p95 | 25 users p50 / p95 | 25-user req/s | Errors (1/10/25) |
|:---|---:|---:|---:|---:|---:|:---|
| dashboard KPIs | 247 KB | 571 / 620 | 1763 / 2510 | 5572 / 10464 | 3.7 | 0/0/1 |
| cases list (all provinces) | 78 KB | 232 / 346 | 1010 / 1077 | 2192 / 4070 | 9.6 | 0/0/0 |
| cases list (SND) | 77 KB | 207 / 236 | 924 / 1006 | 1896 / 3564 | 10.9 | 0/0/0 |
| landowner search | 47 KB | 155 / 176 | 792 / 986 | 1809 / 2797 | 12.4 | 0/0/0 |
| surveys list | 45 KB | 77 / 92 | 383 / 498 | 847 / 1442 | 25.9 | 0/0/0 |
| payments list | 84 KB | 362 / 433 | 1580 / 1729 | 3263 / 6304 | 6.2 | 0/0/0 |
| leases list | 81 KB | 53 / 62 | 204 / 284 | 455 / 754 | 48.2 | 0/0/0 |
| inbox | 57 KB | 158 / 179 | 1014 / 1097 | 2125 / 4308 | 9.4 | 0/0/0 |
| report r1 portfolio | 1 KB | 121 / 163 | 469 / 552 | 1003 / 1754 | 21.5 | 0/0/0 |
| report r5 | 93 KB | 166 / 180 | 1034 / 1473 | 2369 / 2951 | 9.8 | 0/0/0 |
| audit trail | 156 KB | 79 / 95 | 227 / 309 | 465 / 829 | 44.4 | 0/0/0 |
| reference data | 12 KB | 3 / 8 | 15 / 21 | 29 / 67 | 587.6 | 0/0/0 |
| payment request (write) | 0 KB | 7 / 9 | 24 / 39 | 48 / 71 | 503.8 | 0/0/0 |

The one error at 25 users was a `503 busy` (no free database connection within 5 s), returned with `Retry-After`; there were no 500s.

Reading the numbers: one user gets every list in 50–360 ms, report r5 (all
30,000 cases) in ~170 ms and the dashboard in ~0.6 s. Latency grows roughly
linearly with concurrency because PostgreSQL and the single Node.js process
share 8 cores on one laptop; throughput, not latency, is the limit. The
dashboard and payments list are the heaviest calls (their KPI aggregates scan
the whole register each time) and are the first candidates for caching or
pre-aggregation if production measurements call for it. These are workstation
numbers: repeat on production-sized hardware, with the database on its own
host, before setting service levels.

## UAT (simulated)

Executed as automated journeys with real accounts, one browser context or
session per person, and every outcome checked against the API or database.
This is **not** stakeholder acceptance.

| # | Role(s) | Scenario | Result | Test |
|:--|:---|:---|:---|:---|
| 1 | Land officer | Prepares a case in the form (owners, lease and crop lines); shares off 100% are stopped; totals computed by the database | PASSED | user_journeys |
| 2 | Land officer | Tries to approve own case; refusal shown, stage unchanged | PASSED | user_journeys |
| 3 | Negotiation | Approves with a note; history and stage visible to the first user | PASSED | user_journeys |
| 4 | Five positions | Case through every approval; documents required before field approval; valuation locked after | PASSED | workflows |
| 5 | Land officer / Finance / Manager | Voucher request → verify → release → receipt; double submit is one voucher; duplicate period refused | PASSED | workflows |
| 6 | Finance / Land officer | Holds: data entry cannot lift; court-stay hold only via the legal case; hold blocks release | PASSED | workflows, business_rules |
| 7 | Land officer | Withholding tax: filer 10%, non-filer 20%, a lower rate refused | PASSED | workflows |
| 8 | Read-only | Sees registers; no create or export controls; API refuses writes and CSV | PASSED | user_journeys, business_rules |
| 9 | Any | Sign-out ends the session for pages and API | PASSED | user_journeys |
| 10 | Various | Grievance, encroachment, ROW, DBPFC, acquisition (title gating), mutation (shares to heirs), legal, budget | PASSED | workflows |
| 11 | Land officer | Document upload, download, tamper detection, out-of-province refusal | PASSED | workflows |
| 12 | Any | Lockout, rate limit, MFA enrolment and step-up, password change, CSRF, session revocation | PASSED | tests/iam |
| 13 | Any | Every screen meets WCAG 2.1 AA (axe, contrast on), desktop and phone | PASSED | legacy_design |
| 14 | Admin / Land officer | Admin widens who approves a stage, change recorded in history, empty stage refused, restored; land officer refused | PASSED | workflows "approval matrix" |

Not executed: sessions with real users from Land, Legal and Finance; usability
observation; printing official forms on the client's printers.

## Security scope and residual risk

Tested: authentication, MFA, sessions, CSRF/Origin, authorisation on every
route (permission map), row-level security by province, SQL injection on list
and login inputs, XSS echo, file upload type and integrity, export controls,
security headers, dependency advisories, secrets in the tree. Not tested:
infrastructure (TLS, reverse proxy, host hardening), a third-party penetration
test, LDAP/OIDC (not built).

Open (from `docs/SECURITY_FINDINGS.md`):

- **DEP-01** `maplibre-gl` 4.7.1 critical advisory (not reachable: no popups or
  user HTML) and Next's bundled PostCSS (build-time only). Fixes need major
  upgrades.
- **APP-10** invitation / reset links are returned to the administrator.
- **DEP-02** rotate the two database passwords that were in the working tree,
  if they were used outside this workstation.
- `style-src 'unsafe-inline'` remains (style attributes only).

## Blockers and decisions

1. **REQ-06 LAA 1894 milestones** (Sections 4/6/9/11): in the analysis document
   but not in the reference design or schema — confirm scope.
2. **WHT override**: the reference lets the requester edit the rate; this build
   enforces policy for landowner payees — confirm with Finance (APP-12).
3. **NFR-10 single sign-on**: LDAP / Entra ID not implemented.
4. **DEP-01**: schedule the MapLibre upgrade, or accept the risk in writing.
5. **Stakeholder UAT** and a production-like performance run.

## Reproduce

```sh
npx tsc --noEmit && npx eslint src && npx next build
python3 db/tools/run_tests.py
for d in lms_dev lms_iam_test; do PGUSER=lms_migrator PGDATABASE=$d python3 db/tools/migrate.py verify; done
IAM_TEST_BASE=http://localhost:3041 IAM_TEST_PASSWORDS=<file> npx vitest run tests
BASE_URL=http://localhost:3041 IAM_TEST_PASSWORDS=<file> npx playwright test
npm run test:unit && npm run test:integration
BASE=http://localhost:3043 PERF_PASSWORDS=<file> node scripts/perf/load_test.mjs 10 40
db/tools/backup.sh verify lms_dev <dir>
```
