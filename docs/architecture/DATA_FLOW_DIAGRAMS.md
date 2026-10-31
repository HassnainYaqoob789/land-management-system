# Data flow diagrams — Mari Energies Land Management System

Status of this document: **draft of 2026-10-30, written from the code and the
database as they stand during the RBAC / reporting implementation.** Each
element is marked:

- **(E)** existing and verified by automated tests before 2026-10-30;
- **(N)** new in migrations 0039–0044 or the current implementation round —
  present in the code/database, verification in progress (see
  `docs/RELEASE_ASSESSMENT_*.md` for the latest test evidence);
- **(I)** being implemented in this round — designed and contracted, **not yet
  present in the code** at the last check;
- **(P)** planned or external, not verified in this environment.

Every component named below was checked against the graphify knowledge graph
of the code and the live test-database schema (`graphify-out/graph.json`,
rebuilt 2026-10-30; 3,386 nodes). Re-check after changes with
`graphify query "<component>"` or `graphify explain "<file>"`.

Diagrams are Mermaid (render in GitHub, VS Code, or any Mermaid viewer).
Trust boundaries are drawn as dashed sub-graphs (styled in each diagram).

## 1. Context diagram (level 0)

```mermaid
flowchart LR
  subgraph Users["People (browser)"]
    FO["Field land officers / data entry"]
    AP["Approvers by designation: DM, Sr Admin, Manager Land HO, Legal, Negotiation, Finance"]
    FIN["Finance approver / releaser"]
    AUD["Internal audit / security auditor"]
    ADM["System / identity administrator"]
    EX["Executives / viewers"]
  end
  LMS(("LMS: Next.js app + PostgreSQL"))
  IDP[["Identity providers: OIDC, SAML, LDAP/AD (N)(P)"]]
  SMTP[["Mail relay SMTP (N)(P)"]]
  SAP[["SAP integration gateway (N)(P)"]]
  MAP[["Map tiles: OpenStreetMap, Esri imagery (E)"]]

  FO -- "landowners, CNIC, parcels, shares, cases, leases, documents, KML" --> LMS
  AP -- "workflow decisions, comments" --> LMS
  FIN -- "vouchers, verification, release, holds, receipts" --> LMS
  AUD -- "audit and security queries" --> LMS
  ADM -- "users, roles, permissions, providers, policy" --> LMS
  EX -- "dashboards, reports, exports" --> LMS
  LMS -- "screens, reports, PDF/XLSX/CSV, printouts with logo and footer" --> Users
  LMS <-- "sign-in assertions, directory bind" --> IDP
  LMS -- "password reset and notice e-mail" --> SMTP
  LMS -- "ERP postings from the outbox" --> SAP
  MAP -- "tiles, fetched by the browser, allowed by CSP" --> Users
```

## 2. Level 1 — processes, stores and trust boundaries

```mermaid
flowchart TB
  B["Browser: React pages, legacy design"]

  subgraph TB1["Trust boundary 1: public network to application"]
    MW["Middleware: nonce CSP, security headers (E)"]
  end

  subgraph APP["Application tier, Node, database role lms_app"]
    P0["0 Sign-in and session /api/auth: password Argon2id, TOTP (E); OIDC, SAML, LDAP, recovery e-mail (N); passkeys (I)"]
    P1["1 Authorization gate protect(): session, CSRF, MFA policy, permission, re-auth, record scope ctx.can (E)(N)"]
    P2["2 Land and ownership: surveys, landowners, units, gis, import (E)"]
    P3["3 Acquisition and leases: acquisitions, leases, rows, dbpfc, mutations, legal, encroachments, grievances (E)"]
    P4["4 Compensation and payments: cases, payments, holds, receipts, budgets (E); adjustments and release reversal in the database (N), their API routes (I)"]
    P5["5 Workflow and inbox: api.advance_workflow, inbox (E)"]
    P6["6 Reporting and exports: /api/analytics KPIs and reports (E); /api/reports engine, templates, person statement (I) on report_template and unit tables (N)"]
    P7["7 Identity administration: users, roles (N), settings (E)"]
    P8["8 Documents: hash-addressed store, MIME sniffing, size limit, access log (E)"]
  end

  subgraph TB2["Trust boundary 2: application to database, actor asserted per transaction"]
    RLS["Row-level security and definer routines: util.actor_id, lms.actor_role from IAM (N), iam.require / require_in (N)"]
  end

  subgraph DB["PostgreSQL 16"]
    D1[("lms: land, owners, CNIC, cases, payments, leases")]
    D2[("iam: roles, permissions, assignments, providers, secret ciphertext, challenges")]
    D3[("audit: append-only audit_event, auth_event")]
    D4[("lms.report_template, report_export_job (N)")]
    D5[("lms.integration_outbox")]
  end
  DS[("Document store DOCUMENT_STORE_DIR, sha256-addressed (E)")]
  W["9 Integration worker: role lms_worker, api.outbox_* (N)"]
  SAPG[["SAP gateway (P)"]]
  IDPS[["Identity providers (P)"]]
  SMTPS[["SMTP relay (P)"]]

  B -- "HTTPS" --> MW
  MW --> P0
  MW --> P1
  P1 --> P2 & P3 & P4 & P5 & P6 & P7 & P8
  P0 & P2 & P3 & P4 & P5 & P6 & P7 & P8 --> RLS
  RLS --> D1 & D2 & D3 & D4 & D5
  P8 <--> DS
  W --> D5
  W -- "HTTPS with idempotency key" --> SAPG
  P0 <--> IDPS
  P0 --> SMTPS
  style TB1 stroke-dasharray: 6 4
  style TB2 stroke-dasharray: 6 4
```

\* `iam.secret` holds ciphertext only (AES-GCM, keys in the application
environment `IAM_MASTER_KEYS`), never plaintext provider secrets.

### Trust boundaries and sensitive flows

| Boundary | What crosses it | Controls |
|:---|:---|:---|
| Browser → application | credentials, session cookie, CSRF token, CNIC/phone/IBAN, money, documents | TLS (deployment), nonce CSP, same-origin + CSRF on writes, rate limits, MFA policy, re-auth for privileged actions |
| Application → database | the actor id (per transaction), parameterised SQL | the application role holds no ownership and no BYPASSRLS; row-level security per province; definer routines re-check permissions; only lms_readwrite sessions may assert an actor; the system account needs a maintenance session or a signed system context (N) |
| Reporting login → database | — | no actor can be asserted: row-level security returns nothing (N) |
| Application → identity providers | authorization codes, assertions, directory binds | PKCE+state+nonce, signed SAML with single-use request id, LDAPS with CA; mappings explicit only (N) |
| Worker → SAP gateway | ERP postings | dedicated login, idempotency key, no simulated success (N) |
| Application → document store | file bytes | content hash, size/type checks, province check on the parent record (E) |

## 3. Level 2 — sign-in and authorization

```mermaid
flowchart LR
  U["User"] --> L["Login page (E to N)"]
  L -- "username and password" --> PW["attemptLogin: iam.authn_lookup, Argon2id, lockout, failure_counts (E)"]
  L -- "passkey" --> PK["/api/auth/passkey routes (I) on iam.mfa_webauthn, challenge_issue/take, passkey_lookup, passkey_record_use counter check (N)"]
  L -- "SSO button" --> SSO["/api/auth/oidc or saml start, IdP, callback (N)"]
  L -- "directory" --> LD["ldapAuthenticate over LDAPS (N)"]
  SSO & LD --> PROV["iam.provision_external in signed system context: ok, pending approval or inactive (N); iam.deprovision_external on removal (E)"]
  PW -- "MFA required? iam.mfa_required_for (N)" --> MFA["/api/auth/mfa/verify: challenge_find, fail, consume (N)"]
  PW & MFA & PK & PROV --> FL["finishLogin: iam.create_session, HttpOnly cookie, CSRF token (E)"]
  FL --> S[("lms.login_session")]
  R["Each API request"] --> PR["protect(): resolve session, effective_permissions, MFA, permission, re-auth, ctx.can scope (E)(N)"]
  PR -- "api.set_actor" --> RLS2[("RLS and routines")]
  PR -- "denials" --> AE[("audit.auth_event")]
```

## 4. Level 2 — land, ownership and CNIC

```mermaid
flowchart LR
  FO["Land officer"] -- "landowner and CNIC" --> LO["/api/landowners: CNIC unique and validated (E)"]
  FO -- "parcel, recorded area and unit" --> SV["/api/surveys: total_area derived in acres from recorded area and unit (E)(N)"]
  FO -- "ownership shares" --> SH["Shares: deferred 100 percent check (E)"]
  FO -- "KML / KMZ" --> G["/api/gis/kml (E)"]
  FO -- "CSV batch" --> IM["/api/import: validate with import:create, promote with import:update, province-checked (N)"]
  LO & SV & SH & G & IM --> D1[("lms.landowner, survey, survey_ownership_share, admin_unit")]
  D1 -- "PII masked unless pii:read (N)" --> OUT["Screens, search, reports"]
  D1 --> AU[("audit.audit_event")]
```

## 5. Level 2 — acquisition, compensation and payments

```mermaid
flowchart LR
  PRE["Preparer"] -- "case lines and owners" --> C["/api/cases (E)"]
  C --> WF["api.advance_workflow: step groups by designation, separation of duties (E)"]
  APV["Approvers"] -- "transition" --> WF
  WF -- "HO Approved" --> CA[("compensation_case")]
  APR["Approver"] -- "signed adjustment with reason: api.adjust_case (N), route (I)" --> ADJ[("lms.case_adjustment, append-only")]
  FIN["Finance"] -- "voucher" --> RQ["api.request_payment: WHT by filer status (E)"]
  RQ --> V[("payment_request")]
  VER["Verifier"] --> VF["Verified stage through the voucher workflow, api.advance_workflow (E)"]
  VF --> V
  HLD["Finance or legal"] -- "court-stay or dispute hold" --> HO[("lms.payment_hold, scope-checked (E)")]
  HO -. "blocks" .-> RL
  REL["Releaser, not the verifier"] -- "api.release_payment; payments:release in the voucher's province (N)" --> RL[("lms.payment_release, append-only")]
  RL -- "api.allocate_payment" --> AL[("lms.payment_allocation")]
  RL --> RC[("lms.payment_receipt (E)")]
  RL -. "api.reverse_release with reason (N), route (I)" .-> RV[("lms.payment_release_reversal, append-only")]
  RL --> OB[("integration_outbox")]
  OB --> WK["Worker to SAP (N)(P)"]
  CA & AL & ADJ & RV --> ST["lms.case_settlement_totals: assessed, approved, adjusted, paid, outstanding"]
```

## 6. Level 2 — reporting and audit

```mermaid
flowchart LR
  RU["Report user"] -- "configuration: catalogue keys only" --> RUN["/api/reports/run (I): validate, compile parameterised SQL, GROUPING SETS subtotals, units via lms.unit_conversion and lms.report_unit (N)"]
  RUN --> DSETS[("RLS-scoped datasets")]
  RUN -- "masked unless pii:read" --> SCR["Screen"]
  RU -- "export, needs reports:export" --> EXP["/api/reports/export (I): PDF, XLSX, CSV, print HTML with logo and Developed by Alisons Technology; writers src/lib/export (N)"]
  RU -- "templates" --> TPL[("lms.report_template: private or shared by RLS")]
  RUN & EXP -- "report_run, report_export" --> AE2[("audit.auth_event")]
  ALL["Every data change"] --> AV[("audit.audit_event, append-only")]
  ALL --> RVH[("audit.record_version: record history (E)")]
  AUDR["Internal audit"] --> AQ["/api/audit (E)"]
  AQ --> AV & AE2 & RVH
  DOCU["Document opened"] --> DAL[("lms.document_access_log (E)")]
```

## 7. Data stores

| Store | Contents | Protection |
|:---|:---|:---|
| `lms.*` | land, ownership, persons (CNIC, phone, IBAN, address), projects, cases, payments, leases, legal, workflow | RLS per province; field masking without `pii:read` (N); audit triggers |
| `iam.*` | roles, permissions, assignments, sessions, MFA factors, passkeys, providers, provider secrets (ciphertext), challenges | RLS by permission; guards on every change; challenges reachable only through routines (N) |
| `audit.*` | business change history (`audit_event`), record versions (`record_version`) and security events (`auth_event`) | append-only for the application; tamper-evident (DB-02) |
| Document store | uploaded files | content-addressed and verified on read; MIME sniffing and size limit on upload; every access logged in `lms.document_access_log`; access through `/api/documents` only |
| Browser | session cookie (HttpOnly), CSRF token in memory, per-user UI preferences | no business data persisted in the browser |
