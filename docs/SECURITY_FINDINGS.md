# Security findings

> **Change during this work (2026-10-27).** While this phase was in progress,
> another process restructured the repository: the browser prototype moved from
> `app/` to `legacy-demo/`, and a Next.js application tier appeared in `src/`
> with API routes that connect to `lms_dev` and call `api.set_actor()`. That
> tier is not reviewed anywhere in these documents — it was not written here and
> has not been read, so nothing below should be taken as an assessment of it.
> The statement "no application tier exists" describes the state this work was
> carried out against. Two things are visible without reviewing it, and are
> recorded as APP-06 in [SECURITY_FINDINGS.md](SECURITY_FINDINGS.md): its
> connection string names no database user, and `.env.local` points at the
> local socket, so it connects as the invoking operating-system account rather
> than as `lms_app`. On this machine that account is a superuser, which
> bypasses every row-level security policy — the province isolation described
> below would be inert at runtime until the connection uses `lms_app`.


Open findings for the LMS, with severity, owner and status. One row per
finding; the detail sections below carry the reasoning.

**Status values.** *Open* — not addressed. *Mitigated* — partly addressed, with
a stated residual risk. *Accepted* — a deliberate decision to carry the risk,
which still needs a named person to accept it (see "Risk acceptance" at the
end: nobody has accepted anything yet, because that is an organisational act
and not something this work can perform).

**What this document covers.** The database layer, which exists and is tested,
and the application layer, which does not exist yet. Findings prefixed `APP-`
are about the absent application tier and are listed because leaving them out
would misrepresent the system's security posture, not because any of them has
been worked on.

Date of this review: 2026-10-27. Reviewer: the engineering work recorded in
this repository. No external party has reviewed or tested any of it, and the
application tier in `src/` has not been reviewed by anyone — APP-06 is the one
observation made about it, and it came from reading two lines of
configuration rather than from a review.

| ID | Finding | Severity | Layer | Status |
| --- | --- | --- | --- | --- |
| APP-01 | No server-side application tier exists: no authentication, authorisation, session management, input validation, security headers or rate limiting | Critical | Application | Open |
| APP-02 | The prototype stores demo passwords in plaintext and displays them on the sign-in screen | Critical | Application | Open (prototype only) |
| APP-03 | Role rights and province scope are enforced in the browser, which is not a boundary | Critical | Application | Mitigated at the database layer |
| APP-04 | No dependency, secret or static-analysis scanning is wired into any build | High | Process | Open |
| APP-06 | The application tier that appeared in `src/` connects as the invoking OS account, not as `lms_app`; on this machine that account is a superuser, so row-level security is bypassed | Critical | Application | Mitigated |
| APP-07 | A development "SSO simulator" accepted any asserted identity at the callback and the UI claimed SAML/OIDC were active | Critical | Application | Mitigated |
| APP-08 | `GET /api/payments` concatenated the `province` query parameter into SQL | Critical | Application | Fixed |
| APP-09 | Route handlers returned raw exception text to callers and reported business-rule refusals as HTTP 500 | Medium | Application | Fixed |
| DB-14 | Migration 0026 granted `ALL PRIVILEGES` on every `lms` table to `lms_app`, added four tables without row-level security, five owner-rights views, and land-request approvals without separation of duties | High | Database | Fixed |
| DB-13 | `lms.convert_area` duplicates `api.convert_area` with hard-coded factors, converting the two unconfirmed units silently | Medium | Data | Open (needs owner decision) |
| APP-05 | No centralised log collection, alerting or incident detection | High | Infrastructure | Open |
| DB-01 | `SECURITY DEFINER` routines bypass row-level security by design | High | Database | Mitigated |
| DB-02 | Audit immutability holds against the application, not against the schema owner or a superuser | High | Database | Mitigated |
| DB-03 | Database connections are not required to use TLS in this environment | High | Infrastructure | Open |
| DB-04 | Actor attribution trusts the application tier | Medium | Database | Accepted (needs sign-off) |
| DB-05 | Three views run with owner rights and restate the province predicate in their own body | Medium | Database | Mitigated |
| DB-06 | `lms.workflow_transition`, `lms.workflow_assignment` and related tables use a polymorphic record reference with no foreign key | Medium | Database | Mitigated |
| DB-07 | No backup encryption, off-site copy, retention enforcement or point-in-time recovery | High | Infrastructure | Open |
| DB-08 | Document bytes live outside the database; their protection is the object store's, which does not exist yet | Medium | Infrastructure | Open |
| DB-09 | Privileged database activity is not monitored | Medium | Infrastructure | Open |
| DB-10 | Two land-unit conversion factors are unconfirmed | Low | Data | Mitigated |
| DB-11 | Heir share splits of thirds leave a 0.0001% residue | Low | Data | Accepted |
| DB-12 | Record-code lookups cannot use their index under row-level security unless citext equality is marked `LEAKPROOF` | Medium | Database | Mitigated, pending a cluster decision |

---

## APP-01 — No application tier exists

**Risk.** Everything the OWASP ASVS asks of an application — authentication,
session management, access control, input validation, output encoding,
security headers, rate limiting, error handling — is absent, because the
component that would implement it has not been built. The repository holds a
browser-only prototype (`app/`) and, as of this phase, a PostgreSQL database.

**Why this is listed as Critical rather than "not applicable".** A reader
could otherwise take the database work as evidence that the system is secured.
It is not. The database defends itself against a compromised or careless
application; it cannot authenticate an end user, and it cannot stop a request
that never reaches it.

**What exists instead.** The database enforces province scope, role
restrictions on the write paths, the financial invariants and the audit trail
below the application, so these controls do not depend on application code
being correct. That is deliberate and it is the main result of this phase. It
is not a substitute for the application tier.

**Remediation.** Build the server-side tier. Until then, no deployment to
anything holding real landowner data.

**Owner.** Engineering lead. **Dependency.** Phase decision on the application
stack.

---

## APP-02 — Plaintext demo passwords

**Risk.** `legacy-demo/assets/js/data/demo.js` carries passwords in clear and the
sign-in screen lists them. In a prototype whose data is entirely fictional this
is a usability choice; the risk is that the pattern, or the file, survives into
something real.

**Mitigation already in place.** `lms.app_user.password_hash` has a CHECK
constraint that rejects anything not in Argon2 or bcrypt form, so the
prototype's passwords cannot be migrated into the database as they stand. The
seed file (`db/seed/seed_demo.sql`) deliberately writes a verifier that no
password produces, so a seeded account cannot be signed in to at all.

**Remediation.** Argon2id in the application tier, with the parameters and the
account-lockout threshold from `lms.system_setting`
(`security.password_min_length`, `security.max_failed_logins`).

---

## APP-03 — Client-side authorisation

**Risk.** In the prototype, role rights and province scope are decided in
JavaScript (`legacy-demo/assets/js/core/engine.js`, `legacy-demo/assets/js/app/scope.js`). A
crafted request bypasses them entirely.

**Mitigation.** Both are now enforced in the database, below any application:
province scope by row-level security on every province-bearing table and
through every child table's parent (migration 0016), and role restrictions
inside the routines that perform privileged operations. A Sindh account cannot
read a Balochistan case through a view, through a base table, through a report
routine or through a primary-key lookup; `db/tests/test_05_views_rls.sql` and
`db/tests/test_06_rls_scope.sql` assert each of those.

**Residual risk.** The database can only scope what it is told about the actor,
which is DB-04.

---

## APP-04 — No scanning in the build

**Risk.** No software-composition analysis, no secret scanning, no static
analysis, no dependency alerting. The browser prototype vendors Chart.js,
jsPDF, SheetJS, JSZip and MapLibre GL as copied files, so a published
vulnerability in any of them would not surface anywhere.

**Remediation.** A CI pipeline with dependency scanning, secret scanning and
SAST, gating merges. This needs a CI system, which this environment does not
have, so it is a dependency and not something that could be completed here.

---

## DB-01 — `SECURITY DEFINER` routines bypass row-level security

**Risk.** A definer-rights routine runs as `lms_owner`, which owns the tables
and therefore bypasses their policies. A routine that forgot to check the
actor's province would be a hole straight through row-level security.

**Why they are definer-rights at all.** Each one has to write a table the
application is deliberately not allowed to write: `api.release_payment` writes
the release ledger, `api.advance_workflow` writes the workflow decision,
`api.apply_mutation` writes ownership history, the audit trigger writes the
trail. That privilege separation is the point — it is what makes a fabricated
release or a fabricated approval impossible through the application's own
grants.

**Mitigation.**
- Every definer routine re-checks province access itself before touching
  anything. `db/tests/test_06_rls_scope.sql` asserts this for
  `api.advance_workflow`, `api.request_payment`, `api.release_payment` and
  `api.allocate_payment`, each with a known out-of-scope record.
- Every routine in the schema pins `search_path = pg_catalog, pg_temp`, so a
  caller cannot shadow a function or operator it relies on.
  `db/tests/test_10_roles_grants.sql` asserts there is no exception.
- Every reference inside them is schema-qualified.
- `EXECUTE` is granted per routine, not per schema, and no routine is
  executable by `PUBLIC` — also asserted.
- `api.apply_mutation` is not granted to the application at all: moving
  ownership is a consequence of an approval, never an operation of its own.
- The one piece of dynamic SQL that builds an identifier
  (`lms.next_code_year`) takes it from `lms.code_sequence`, which the
  application cannot write to, and still passes it through `format(%I)`.

**Residual risk.** A future routine added without the province check. The
mitigation is the review habit plus the test file, which will not catch a
routine nobody adds a test for. A lint that fails any definer routine in `api`
without a province check would close this properly and is not written.

**Owner.** Database engineering.

---

## DB-02 — Audit immutability stops at the schema owner

**Risk.** The claim "the audit trail is append-only" is true of the
application and false of a privileged session. `db/tests/test_15_maintenance.sql`
demonstrates the limit rather than hiding it: as `lms_owner` it disables the
append-only trigger, deletes an audit row, and re-enables it.

**What is in place.** Three independent mechanisms against the application:
the grants (no INSERT, UPDATE, DELETE or TRUNCATE on any audit table — TRUNCATE
revoked separately because it fires no row triggers), a `BEFORE UPDATE OR
DELETE` trigger that raises, and the fact that the only writer is a definer
trigger whose content the caller does not choose. `db/tests/test_08_audit_immutability.sql`
exercises all of it, including the ledgers (`lms.payment_release`,
`lms.workflow_transition`, `lms.survey_ownership_history`,
`lms.setting_history`, `lms.dbpfc_rate_history`).

**What would close it.** Shipping audit events out of the database to an
append-only destination — a WORM bucket, or a log pipeline the database role
cannot reach — and reconciling counts between the two. That requires
infrastructure this environment does not have. Until then the honest statement
is: tamper-evident against the application, not tamper-proof against a
database administrator.

**Compensating control available now.** `audit.audit_event.db_role` records
which database role each change arrived as, so an administrative change is
distinguishable from an application one. A privileged session that deletes
rows still leaves a gap in the `id` sequence, which is detectable but not
currently checked by anything.

---

## DB-03 — TLS not enforced for database connections

**Risk.** The local cluster this was developed and tested against uses Unix
socket and `trust` authentication. Nothing requires TLS, and no client
certificate is checked.

**Remediation.** In the deployed environment: `hostssl` only in `pg_hba.conf`,
`ssl = on`, a server certificate from the organisation's CA, and
`sslmode=verify-full` in every connection string. Optionally client
certificates for `lms_app` and `lms_migrator` in place of passwords.

**Why it is not done here.** It is a cluster and network configuration, not a
schema one, and claiming it on a developer workstation would be
misrepresentation. `db/bootstrap/01_roles.sql` sets no passwords for this
reason and says where credentials belong.

---

## DB-04 — Actor attribution trusts the application

**Risk.** The application tells the database which end user is acting, by
setting `lms.actor_id` at the start of each transaction. A compromised or buggy
application can set any value, so the audit trail attributes actions as
reliably as the application tier is trustworthy — no more.

**What it does defend against.** Mistakes, missing context (a write with no
actor is refused outright, not recorded anonymously), and identity leaking
between pooled requests: `api.set_actor` uses `SET LOCAL`, so the value is
discarded when the transaction ends. `db/tests/test_09_identity_context.sql`
proves the non-leakage with two consecutive transactions on one connection,
after both a commit and a rollback — the property a connection pool depends on.

**What would close it.** One database role per end user, so `current_user` is
the attribution, or signed identity assertions the database verifies. Both are
substantial changes; one role per user also interacts badly with connection
pooling.

**Decision.** Accept, as a documented limitation, on the basis that the
application tier is inside the trust boundary and that every write is
attributed to *something* nameable. **This acceptance has not been given by
anyone with the authority to give it** — see "Risk acceptance".

---

## DB-05 — Owner-rights views with the predicate restated

**Risk.** `api.v_landowner_summary_masked`, `api.v_payment_release_masked` and
`api.v_province_summary_cached` run with owner rights rather than
`security_invoker`, and therefore bypass row-level security. Each restates the
province predicate in its own body. If that predicate and the policies in
migration 0016 ever diverge, these three views become a way around the
policies.

**Why they are not `security_invoker`.** The first two mask a CNIC, and masking
a column requires reading it, which requires the caller to hold `SELECT` on it
— at which point the caller can read it unmasked and the mask is decorative.
The third reads a materialized view, which cannot carry row-level security at
all.

**Mitigation.** The predicate is the same function call the policies make
(`lms.actor_role()` and `lms.actor_provinces()`), and
`db/tests/test_05_views_rls.sql` asserts that each masked view returns exactly
the same row set as its unmasked, policy-governed equivalent for the same
actor, and that a differently-scoped actor sees only its own province.

**Residual risk.** The tests compare row sets, so a divergence that happens to
produce the same rows in the demo data would pass. A larger fixture would
reduce that; the comparison is the control, not a proof.

---

## DB-06 — Polymorphic record references

**Risk.** `lms.workflow_transition`, `lms.workflow_assignment`,
`lms.workflow_comment`, `lms.workflow_escalation`, `lms.document`,
`lms.data_provenance` and `audit.audit_event` all reference a record by
`(entity, record_id)` across nine possible tables. A polymorphic reference
cannot carry a foreign key, so the database cannot refuse an orphan.

**Mitigation.** The application has no `INSERT` privilege on
`lms.workflow_transition` or on the audit tables at all; the only writers are
`api.advance_workflow` and the audit trigger, each of which resolves the record
in its own entity table first and fails if it is not there. For
`lms.document` the application does hold `INSERT`, so an orphan document row
is possible and is the weakest point of this finding.

**Residual risk.** A privileged session can insert an orphan anywhere. A
periodic consistency check (one query per entity, looking for `record_id`
values with no matching row) would detect it and is not written.

**Alternative considered.** One transition table per entity — nine tables —
would make the references declarative at the cost of nine near-identical
tables and a union in every cross-entity query. Rejected as worse overall, but
it is a defensible choice and worth revisiting if orphans ever appear.

---

## DB-07 — Backups are not protected, copied off-site, retained or PITR-capable

**Risk.** `db/tools/backup.sh` takes a dump, restores it into a scratch
database and compares row counts, financial totals, cheque numbers, audit span,
schema and migration history — so the restore path is genuinely tested, and
the verification has been run (see `docs/DATABASE_ENGINEERING_REPORT.md`,
"Backup and recovery"). What it does **not** do: encrypt the dump, copy it
anywhere else, enforce a retention period, or support recovery to a point in
time between backups.

**Consequence.** A dump file is a complete copy of every landowner's CNIC,
bank details and payment history, sitting unencrypted on whatever filesystem
produced it. The RPO is "since the last dump", with no WAL archive to close
the gap.

**Remediation.** `pg_basebackup` plus WAL archiving to object storage for
point-in-time recovery; dumps encrypted at rest and written to a location the
database role cannot delete from; a retention schedule; and the recovery
exercise repeated against the real environment rather than a workstation.

---

## DB-08 — Document bytes are outside the database

**Risk.** `lms.document` holds metadata, a storage reference and a SHA-256,
not the file. That is the right design — it keeps the database small enough to
restore quickly and lets the object store handle encryption and lifecycle —
but it means the files' confidentiality and integrity depend on an object store
that does not exist in this environment.

**What the database contributes.** The SHA-256 of every stored object, so a
substituted or corrupted file is detectable; a MIME allowlist, so an SVG or
HTML payload cannot be recorded as an attachment and served back to a reviewer;
a 50 MiB cap; soft delete with a reason; and `lms.document_access_log`, which
records who read which document.

**Remediation.** Provision the object store with server-side encryption,
versioning, no public access, and credentials held in the deployment secret
store (`lms.integration_endpoint.secret_ref` names the secret, never holds it).
Verify checksums on read.

---

## DB-09 — Privileged database activity is not monitored

**Risk.** Nothing watches for a superuser session, a `DISABLE TRIGGER`, a
`GRANT`, a schema change outside a migration, or a bulk read of the landowner
table. DB-02's mitigation assumes somebody would notice.

**Remediation.** `pgaudit` or `log_statement = 'ddl'` plus log shipping to a
collector the database role cannot write to; alerts on connections by
`lms_owner` (which should never log in at all), on DDL outside a migration
window, and on `pg_catalog` privilege changes. Needs the log pipeline in
APP-05.

---

## DB-10 — Unconfirmed conversion factors

**Risk.** The Jireb (Sindh) and Bigha (KPK) factors vary by district and have
not been confirmed by the client. An area converted with a wrong factor
produces a wrong compensation amount.

**Mitigation.** `lms.unit_conversion.is_confirmed` is `false` for both, and
`api.convert_area()` raises rather than returning a number unless the caller
explicitly opts in and takes responsibility for labelling the result
provisional. Import validation reports a warning on any row that uses one.
`db/tests/test_02_routines.sql` asserts the refusal.

**Remediation.** Obtain the per-district factors and add them as new
`lms.unit_conversion` rows with their own validity periods — the table is
versioned, so a correction does not rewrite history.

---

## DB-11 — Rounding residue on thirds

**Risk.** `lms.share_pct` has four decimal places. Two heirs at two thirds and
one third record as 66.6667 and 33.3333, totalling 99.9999 rather than 100.

**Decision.** Accept. The residue is 0.0001% of one parcel, it is always under
and never over (so the 100% ceiling is never breached), and the alternative —
storing shares as exact fractions — would complicate every query that sums
them for a benefit nobody can measure on the ground.
`db/tests/test_11_mutation.sql` asserts the direction of the residue rather
than pretending it is absent.

---

## APP-06 — The new application tier connects with the wrong database role

**Found by inspection, not by review.** This finding is about two lines of
configuration, read while reconciling this document with a directory that
changed during the work. The application tier in `src/` has not been reviewed
and nothing else here should be read as an assessment of it.

**What is there.** `src/lib/db.ts` defaults to
`postgresql://localhost:5432/lms_dev` and `.env.local` sets
`DATABASE_URL=postgresql:///lms_dev?host=/tmp`. Neither names a database user,
so libpq falls back to the invoking operating-system account. On the machine
this was developed on, that account is a **PostgreSQL superuser**.

**Why it matters.** A superuser bypasses row-level security entirely. Every
policy in migration 0016 — the whole province-isolation design, 65 policies on
61 tables — becomes inert at runtime, silently. Nothing errors; a Sindh field
officer's session simply returns every province's rows. The same session also
holds the privileges the grants in migration 0017 withhold: it could insert an
audit event, alter a payment release, or disable a trigger. Every control in
[DATABASE_SECURITY_REVIEW.md](DATABASE_SECURITY_REVIEW.md) that is enforced by
a grant or a policy rather than by a constraint stops applying.

Worth being precise about what still holds: the constraints do. A superuser
cannot release a payment twice — `UNIQUE (payment_id)` does not care who you
are — and `db/tests/test_07_concurrency.py` demonstrates exactly that with the
triggers disabled and owner privileges. The financial invariants survive; the
access control does not.

**Credit where due:** the tier does call `api.set_actor()` on its write paths,
so the audit attribution contract is being honoured. The problem is only the
connection role.

**Remediation.** Set `DATABASE_URL` to connect as `lms_app`, provision its
credential from the deployment secret store, and add a startup assertion that
refuses to serve if `current_user` is not `lms_app` or if
`pg_has_role(current_user, 'pg_read_all_data', 'member')` — a check that would
have caught this, and that costs one query at boot. A test that queries as the
runtime connection and asserts a cross-province row is *not* returned would
catch any future regression of the same kind; the existing
`db/tests/test_06_rls_scope.sql` asserts this for `lms_test` but cannot see how
the application connects.

**Owner.** Whoever owns the application tier.

**Status: mitigated.** `src/lib/db.ts` now has no default connection string,
`DATABASE_URL` names `lms_app`, and `assertSafeDbRole()` refuses to serve when
the connected role is a superuser, has `BYPASSRLS`, or owns any object. Every
data route runs inside `withActor()`, so row-level security sees the signed-in
user's provinces. `tests/iam/routes.test.ts` asserts the per-role outcome of
every data route through the running server.

---

## APP-07 — SSO simulator accepted any identity

`/api/auth/sso/callback` created a session for whatever username the request
named, and the sign-in page and metadata endpoint described SAML 2.0 and OIDC as
active although no assertion or token was ever verified. A redirect is not
authentication. **Mitigated:** the simulator routes answer 404 unless
`NODE_ENV` is not `production` *and* `IAM_ENABLE_SSO_SIMULATOR=true`; the
metadata endpoint states that SAML is not implemented; the sign-in page lists
only providers that are enabled and have passed a connection test. Real OIDC and
LDAP providers are not implemented yet, so no enterprise sign-in is offered.

## APP-08 — SQL injection in the payments list

The `province` filter was interpolated into the query text. **Fixed** by a bound
parameter (`$1::text IS NULL OR province_code = $1`). The signed-in injection
checks in `tests/regression/business_rules.test.ts` cover this endpoint and nine
others with six payloads each.

## APP-09 — Raw exception text in API responses

Seventeen catch blocks in thirteen route handlers returned `error.message` to
the caller, so a database or library failure could disclose table, column or
constraint names (ASVS 7.4.1), and expected refusals — a lease on hold, a
request that does not exist — came back as HTTP 500. **Fixed:** routes throw
`HttpError` with the right status (404 not found, 409 state conflict, 400 rule)
for outcomes they mean to report, user-facing KML/KMZ rejections use
`KmlError`, and every catch returns `toResponse()`, which passes through only
those and the messages our own database routines raise (`P0001`); anything
else becomes a generic 500 carrying a correlation id that matches the server
log.

## DB-14 — Migration 0026 widened privileges and skipped controls

Applied by a superuser during concurrent work: `GRANT ALL PRIVILEGES ON ALL
TABLES IN SCHEMA lms TO lms_app` (and on sequences), `project_kml_import`,
`project_spatial_feature`, `project_gis_merge` and `land_request` without
row-level security, five analytics views running with owner rights, and objects
owned by the superuser. **Fixed** by 0027 (RLS, `security_invoker` views, land
request separation of duties, ownership normalisation), 0029 (privileges back to
the `lms_readwrite` role grants) and 0030 (pinned `search_path`).
`db/tests/test_10` caught the grant and the unpinned function from a clean
rebuild.

## DB-13 — Duplicate area conversion

`lms.convert_area` (0026) hard-codes conversion factors instead of reading the
versioned `lms.unit_conversion` table, converts Jireb and Bigha without the
opt-in that `api.convert_area` requires for unconfirmed factors, and adds
killa, murabba, wiswa and bega, which the reference table does not hold. The
KPI and report endpoints use it. **Open:** whether those units are wanted is a
business decision; the two functions should then become one, backed by the
table.

---

## DB-12 — citext, row-level security and the unusable index

**Risk.** Looking a record up by its code (`AREA-000001`, `CC-2026-0001`,
`VCH-2026-00001`) is one of the commonest operations in the system. Those codes
are the domain `lms.record_code`, built on `citext` so that a code typed in the
wrong case still matches.

Under row-level security, PostgreSQL will not evaluate a user's own `WHERE`
clause before the security policy unless the operator in it is marked
`LEAKPROOF` — otherwise an error raised by the user's qual could reveal a value
from a row the policy would have hidden. `citext_eq` is **not** marked
leakproof, while `texteq` and `uuid_eq` are. The consequence is that the unique
index on a code column cannot be used, and every code lookup becomes a
sequential scan.

Measured on the volume fixture (60,013 parcels, a 20 MB table), as the
application role with policies in force:

```
SELECT id FROM lms.survey WHERE code = 'PF-S0000042';

  default:                Seq Scan, 60,012 rows removed by filter   ~207 ms
  with citext leakproof:  Index Scan using survey_code_key            ~1.7 ms
```

Through `api.v_survey_ownership`, the same lookup goes from 167 ms to 0.75 ms
— see `q15_parcel_ownership_lookup` in
[QUERY_PLAN_EVIDENCE.md](QUERY_PLAN_EVIDENCE.md). The cost grows linearly with
the table, so the gap widens over the system's life.

**This is a consequence of a design choice made in this phase**, not an
inherited problem: `lms.record_code` was put on `citext` for the convenience of
case-insensitive matching, and the interaction with row-level security was not
anticipated. It was found by measuring rather than by reasoning.

**Mitigation offered.** `db/bootstrap/03_leakproof.sql` marks citext's
comparison operators leakproof. It requires a superuser, states its own
reasoning and its own residual risk, and refuses to run as anything else. The
judgement it asks a database administrator to make: `citext_eq` folds case and
compares bytes, with no data-dependent error path, so it cannot leak a value
through an error — the same reasoning by which core `texteq` is already
leakproof.

**Residual risk if the step is taken.** An out-of-memory condition on a
pathological input is in principle observable, and a future change to the
citext extension could introduce an error path this review did not anticipate.
The exposure would be narrow: someone who can already run queries might learn
whether a code they guessed exists outside their province — not its contents —
and every such query is attributed and audited.

**Residual risk if the step is declined.** Code lookups stay correct and stay
slow, degrading linearly. Nothing is unsafe.

**The conservative alternative.** Rebuild `lms.record_code` on plain `text`
and get case-insensitive matching from a functional index on `upper(code)`,
comparing with `upper($1)`. Text equality is already leakproof, so the index
becomes usable with no cluster-level assertion at all. It is a schema change
touching about thirty columns and several routine signatures, so it has not
been made speculatively — but it is the better answer if the cluster owner
declines the leakproof step, and it is the one to take if this ever ships to a
managed service where marking a function leakproof is not possible.

**Decision required.** The cluster owner either runs
`db/bootstrap/03_leakproof.sql` and accepts its stated residual risk, or
declines it and funds the domain change. Neither has been decided.

**Owner.** Database engineering, with the cluster owner.

---

## APP-10 — Invitation and reset tokens returned by the users API

`POST /api/users` (create) and `action: issue_token` return the raw one-time
token and link to the administrator, so it can be handed over out of band. Only
its SHA-256 is stored, it expires, it is single-use, the call needs
`users:update`, and the screen shows it once. It still means a secret crosses
an API response, which the IAM rule forbids. **Open — needs a decision:**
deliver the link by mail (`src/lib/iam/mail.ts`) and stop returning it, or
accept the risk for environments without mail.

## APP-11 — Workflow and data-integrity defects in the API and screens

Found in the re-audit, all **fixed** and covered by `tests/regression`:
every `advance_workflow` caller passed the literal `'Advanced'` as the
approval position, so no transition could succeed; the lease screen sent
transitions without `action: 'transition'` (silently a no-op); the case
document checklist sent `doc_code`/`is_checked` where the API reads
`item_code`/`checked`; case totals were taken from client-sent lump sums
instead of the valuation lines; routes invented provinces, coordinates,
rates, notes and document checks when a field was missing; new records were
not queued for their first approval step; and several list joins on
`lms.app_user` failed under row-level security (migration 0032).

## APP-12 — Requester could set the withholding-tax rate

`POST /api/payments` forwarded a client-supplied `wht_pct` to the
`SECURITY DEFINER` routine `api.request_payment`, which used it in place of the
configured rate, so anyone who could raise a voucher could raise it at 0%
withholding. The documented rule (reference: "non-filer = 2×") was not
applied either. **Fixed** by migrations 0035 and 0037: for a landowner payee the
rate is `finance.wht_pct`, times `finance.wht_nonfiler_multiplier` for a
non-filer, and a different rate in the request is refused. Payees who are not
landowners (e.g. Government of Sindh) default to 0% as in the reference and may
carry a stated rate, which Finance sees at verification. Tests:
`db/tests/test_04_financial.sql`, `tests/regression/workflows.test.ts`.
**Open decision:** the reference lets the requester edit the rate for any
payee; this build does not for landowners. Confirm with Finance.

## APP-13 — No Content-Security-Policy or anti-framing headers

The production build sent no CSP, `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy` or `Permissions-Policy`. **Fixed:** `src/middleware.ts` sets a
per-request nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`,
`object-src 'none'`, `frame-ancestors 'none'`, only the OpenStreetMap tile host
as a third party); `next.config.ts` adds the other headers to every response
(HSTS when `APP_ORIGIN` is https). `style-src` keeps `'unsafe-inline'` for style
attributes (React, MapLibre) — residual, low. Tests:
`tests/regression/security_headers.test.ts`; the Playwright screen sweep fails
on any CSP violation in the console.

## APP-14 — User-administration actions relied on the database alone

`POST /api/users` checked a permission only for `create_user`; `assign_role`,
`revoke_role`, `update_user`, `set_status`, `reset_mfa`, `revoke_sessions` and
`issue_token` relied on row-level security and `iam.require` in the database
(which did refuse). **Fixed** (defence in depth): each action names its
permission and is refused with 403 before any work.

## APP-15 — Report export: formula injection, no export permission, no record

CSV exports wrote cell text unescaped (a landowner named `=HYPERLINK(…)` would
execute in Excel), needed only `reports:read`, and were not logged. **Fixed:**
`src/lib/csv.ts` neutralises formula prefixes; export requires
`reports:export`; each export is written to `audit.auth_event`
(`report_export`). The screen hides the button without the permission.

## APP-16 — Case transition through PUT skipped the approve permission

`PUT /api/cases {action: transition}` needed only `cases:update`, while the
dedicated transition route needs `cases:approve`. **Fixed:** both require
`cases:approve` (separation of duties is still enforced by
`api.advance_workflow`).

## DEP-01 — Dependency advisories (`npm audit --omit=dev`, 2026-10-29)

- `maplibre-gl` 4.7.1 — GHSA-jrc7-96c5-q579 (critical): XSS sanitizer bypass in
  `DOM.sanitize`. Reachable only through HTML the application passes to MapLibre
  (popups/`setHTML`, attribution). This build creates no popups and its only
  attribution string is a constant, so it is not reachable with user data. The
  fix is in 6.x (a major upgrade; the design reference pins 4.7.1). **Open:**
  upgrade after visual regression of the map, or accept with this note.
- `next` 15.5.28 bundles `postcss` 8.4.31 (high): source-map path disclosure and
  `</style>` stringify issues. PostCSS runs at build time on the project's own
  CSS, not on user input. The fix is Next 16 (major). **Open, low.**

## DEP-02 — Credentials in the working tree

`README.md` printed a database password for `lms_owner` and a shared seed
password, and `scripts/service_readiness.js` hard-coded the `lms_app` password.
**Fixed:** both now take credentials from the environment and the README
documents none. Neither file was in the last commit, but the values were on
disk: **rotate those two database passwords** if they were ever used anywhere
but this workstation. `.env.local` is git-ignored and untracked.

## PERF-01 — Unbounded lists and per-row security cost (availability)

At the volume fixture (30k cases, 120k payments, 50k landowners) list
endpoints returned whole registers (`/api/payments` 54 MB in 14 s, `/api/cases`
23 MB in 15 s) — a denial-of-service exposure for any signed-in user. **Fixed:**
server-side paging and search on every register (`src/lib/paging.ts`), RLS
evaluated once per statement (migration 0036: 7.75 s → 0.30 s for the
executive KPIs), case settlement as a grouped join instead of a function per
case (0038: liabilities 12 s → 0.4 s), report screens capped at 1,000 rows with
totals over all rows. A database-pool timeout now answers 503 + `Retry-After`
instead of 500. Measurements: `docs/reports/RELEASE_ASSESSMENT_2026-10-29.md`.

## Risk acceptance

Two findings above are marked *Accepted*. That marking records an engineering
recommendation, not a decision: accepting a risk requires a named person with
the authority to accept it on the organisation's behalf, and no such person has
been asked or has signed.

Before release, each of the following needs a named owner, a date and a
recorded decision:

| ID | Decision required | Who should decide |
| --- | --- | --- |
| DB-04 | Accept trusted-application actor attribution, or fund per-user database roles | Information security owner |
| DB-11 | Accept the share rounding residue | Land operations owner |
| DB-02 | Accept tamper-evident rather than tamper-proof audit until a WORM destination exists | Information security owner, with internal audit |
| DB-06 | Accept polymorphic references with routine-level enforcement | Database engineering lead |
| DB-12 | Mark citext equality leakproof, or fund rebuilding `lms.record_code` on text | Cluster owner with database engineering |

Every other finding is Open and none of the Critical or High ones has been
remediated. On the release gate in the phase brief — "resolve critical and
high-severity findings or formally document an authorised risk decision" —
this system does not pass, and the reason is APP-01: the application tier it
would be secured at does not exist yet.
