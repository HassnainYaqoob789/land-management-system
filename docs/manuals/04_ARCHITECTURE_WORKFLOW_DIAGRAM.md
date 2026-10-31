# LMS Architecture & Workflow

**Mari Energies Ltd: Land Management System.** Deliverable 04, 31 Oct 2026.
This document reflects the code and the `lms_dev` database at migration **0059**.
A print-ready version is in [04_ARCHITECTURE_WORKFLOW_DIAGRAM.html](04_ARCHITECTURE_WORKFLOW_DIAGRAM.html).

**Colour key** (the same colours are used in the HTML version):

| Role groups | Module groups |
|---|---|
| Governance (violet) | Overview (indigo) |
| Exploration (teal) | Master Data (cyan) |
| Field land team (blue) | Land Operations (blue) |
| Head office (rose) | Finance (amber) |
| Finance (amber) | Community (pink) |
| Read-only (grey) | Records & Reports (green) |
| | System (slate) |

**Line key:**
- Solid arrow: flow or data dependency.
- Red dashed arrow: return for changes, or a payment hold.
- Dashed box: an external service, or one not yet verified in production.

---

## A. System architecture

```mermaid
flowchart TB
  subgraph PEOPLE["1 · People and browsers"]
    direction LR
    P1["Field land team<br/>Land Officer, Negotiation, Legal,<br/>Sr Admin, DM/TL"]:::fld
    P2["Exploration<br/>Planner, Director Ops,<br/>Regional Manager"]:::exp
    P3["Head office<br/>Manager Land (HO)"]:::ho
    P4["Finance<br/>Finance Officer"]:::fin
    P5["Governance<br/>Administrator, Security auditor"]:::gov
    P6["Read-only<br/>Viewer, executives"]:::ro
  end

  subgraph APP["2 · Next.js 15 application (Node, React 19) — DB login lms_app"]
    MW["middleware.ts<br/>no cookie → /login · CSP nonce"]
    PG["~35 screens (App Router)<br/>PageGuard + menu from nav.ts"]
    API["~90 API route handlers<br/>protect() / publicRoute / ssoRoute"]
    subgraph PROTECT["protect() on every API request"]
      direction LR
      S1["1 Session<br/>sha256 of token"] --> S2["2 CSRF<br/>HMAC + same-origin"] --> S3["3 Password / MFA /<br/>re-auth 10 min"] --> S4["4 withActor<br/>BEGIN; api.set_actor"] --> S5["5 Permission<br/>scope; out of scope → 404"]
    end
    LIB["workflow.ts · domain.ts (CNIC, units, WHT) · reporting engine (catalogue only)<br/>export PDF/XLSX/CSV · kml.ts · documents.ts (sha256, 50 MB)"]
    MW --> PG
    PG --> API --> PROTECT --> LIB
  end

  subgraph DB["3 · PostgreSQL 16"]
    RLS["Row-level security by province: (SELECT lms.actor_provinces())<br/>definer routines re-check permissions; workflow, SoD, hold and budget triggers"]
    LMS[("lms<br/>~110 domain tables")]
    APIS[("api<br/>views + definer routines")]
    IAM[("iam<br/>21 tables")]
    AUD[("audit<br/>append-only")]
    UTIL[("util / ext")]
    RLS --- LMS & APIS & IAM & AUD & UTIL
  end

  subgraph INT["4 · Integrations and outputs"]
    TILES["Map tiles OSM / Esri"]:::ext
    IDP["SSO: OIDC, SAML, LDAP/AD<br/>(real AD/Entra not yet verified)"]:::ext
    SMTP["SMTP mail relay"]
    DOCS["Document store<br/>sha256-addressed"]
    KML["KML / KMZ import & export"]
    EXP["CSV · XLSX · PDF exports"]
    WORK["SAP outbox worker<br/>login lms_worker"]
    SAP["SAP gateway (external)"]:::ext
  end

  PEOPLE -- "HTTPS · session cookie · x-csrf-token" --> MW
  TILES -. "tiles to the browser" .-> PEOPLE
  APP -- "parameterised SQL as lms_app<br/>(no superuser, no BYPASSRLS)" --> RLS
  API <--> IDP
  API --> SMTP
  LIB <--> DOCS
  LIB <--> KML
  LIB --> EXP
  LMS -- "lms.integration_outbox" --> WORK -- "HTTPS + idempotency key" --> SAP

  classDef fld fill:#e9f0fc,stroke:#1e4fb8,color:#1e4fb8
  classDef exp fill:#e6f6f4,stroke:#0f766e,color:#0f766e
  classDef ho fill:#fdecef,stroke:#be123c,color:#be123c
  classDef fin fill:#fdf3e4,stroke:#a35a00,color:#a35a00
  classDef gov fill:#f3eefe,stroke:#6d28d9,color:#6d28d9
  classDef ro fill:#f1f3f5,stroke:#4b5563,color:#4b5563
  classDef ext fill:#ffffff,stroke:#8a94a3,stroke-dasharray:5 3
```

**How it works.** The system has four layers.

1. **Browser.** People use any modern browser.
2. **Application.** The browser talks only to the Next.js application. Every API request passes five checks in `protect()`:
   1. session;
   2. CSRF token and same-origin;
   3. password change, MFA and re-authentication;
   4. opening one database transaction tagged with the signed-in user;
   5. the permission, at the user's scope.
3. **Database.** Because the transaction carries the user, PostgreSQL itself enforces:
   - province isolation, through row-level security;
   - the approval and separation-of-duties rules, through triggers;
   - the append-only audit trail.

   The application connects as `lms_app`. That login owns nothing and cannot bypass row-level security.
4. **Integrations.**
   - SSO providers and SMTP.
   - The content-addressed document store.
   - KML and the CSV, XLSX and PDF exports.
   - Map tiles, which the browser fetches directly.
   - A separate SAP outbox worker. It reads `lms.integration_outbox` and posts to the SAP gateway.

Real AD/Entra sign-in and the SAP gateway connection are not yet verified in this environment.

---

## B. Roles, approval positions and modules

Taken from the live `iam.role_permission` table on `lms_dev`.

**Key:**
- **A**: approve, verify or release, by approval position.
- **W**: create and edit.
- **R**: read only.
- **–**: no access.

| Role | Approval position | Demo accounts | Province scope | Projects | Khasra | Owners | Land req. | Acq / Lease / ROW | Cases | Legal / Mutation | Payments | Budgets | DBPFC | Grievances | GIS | Reports | Audit | Users / Roles / Settings |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| system-administrator | System Administrator | admin | all | – | – | – | – | – | – | – | – | – | – | – | – | R¹ | R | W |
| security-auditor | Internal Audit | audit | all | R | R | R² | R | R | R | R | R | R | R | R | R | R | R | R |
| exploration-planner | — (initiator) | explorer, explorerqta | own | R | R | – | W | – | – | – | – | – | – | – | R | – | – | – |
| land-request-reviewer | Director Operations; Regional Manager | dirops; regmgr, regmgrqta, regmgrpnj | all / own | R | R | – | A | – | – | – | – | – | – | – | R | – | – | – |
| data-entry | Land Officer (Field) | lofield, loquetta, lopnj | own | W | W | W | W | W | W | W | W | – | W | W | W | R | – | – |
| negotiation-officer | Negotiation Group | nego, negoqta | own | R | W | W | W | W | A | – | W | – | R | W | R | R | – | – |
| legal-advisor | Legal Advisor | legal | all | R | R | R | – | W | A | W | – | – | – | W | R | R | – | – |
| case-approver | Sr. Admin LMS (Field); DM / TL (Field); DM / TL Land Affairs | sradmin, sradmqta, sradmpnj, dmfield, dmqta; landaffairs, landaffqta, landaffpnj | own | W | W | W | A | W | A | W | W | – | W | W | W | R | – | – |
| land-manager | Manager Land (HO) | mland | head office | W | W | W | A | W | A | W | A | W | W | W | W | R | – | – |
| finance-approver | Finance Officer | finance | all | R | R | R | – | R | R | R | A | W | R | – | – | R | – | – |
| viewer | — | viewer | all | R | R | – | – | R | R | – | R | – | – | – | R | R | – | – |

¹ The administrator sees only the Landowner Register report, with CNIC masked. It has no business registers, by separation of duties.
² CNIC is masked for the auditor.

**What the table shows.** Each person's access comes from three separate things:
- a **role**, which gives the permissions in the table;
- an **approval position** (`lms.app_user_group`), which decides which workflow stage they may approve;
- their **assigned provinces**, which limit which records they see.

Only the holder of a stage's position can approve that stage. This is why `case-approver` covers three positions:
- the Sr. Admin "Verified" stage;
- the DM/TL Field "Field Approved" stage;
- the DM/TL Land Affairs land-request tier.

The administrator manages users, roles and settings. By separation of duties, it holds no business registers.

---

## C. Module map and data dependencies

```mermaid
flowchart LR
  subgraph OV["Overview"]
    DASH["Executive Dashboard"]
    GIS["GIS Land Map"]
    PDASH["Project Dashboard"]
    INBOX["Approvals & Alerts"]
    CAL["Calendar"]
  end
  subgraph MD["Master Data"]
    UNITS["Administrative Hierarchy"]
    PROJ["Projects / Well Locations"]
    SURV["Survey / Khasra Register"]
    OWN["Landowners & co-owner shares"]
    PROV["Provincial Revenue Systems"]
  end
  subgraph LO["Land Operations"]
    REQ["Land Requests (polygon)"]
    ACQ["Acquisition & Title"]
    CASE["Compensation Cases"]
    LEASE["Leases & Agreements"]
    ROW["ROW & Pipelines"]
    ENC["Encroachments"]
    MUT["Mutation & Succession"]
    LEG["Legal & Litigation"]
  end
  subgraph FI["Finance"]
    BUD["Budgets"]
    VCH["Payment voucher"]
    CHQ["Verify → Release → Cheque"]
    RCT["Receipt of payment"]
    DBP["DBPFC — Sindh govt land"]
  end
  subgraph CM["Community"]
    GRV["Grievances & IIR"]
  end
  subgraph RR["Records & Reports"]
    REG["Landowner Register"]
    DOC["Documents"]
    UPL["Data Upload"]
    REP["Reports"]
    STMT["Landowner statement"]
    AUDT["Audit Trail"]
  end
  subgraph SY["System"]
    USR["Users & Roles · Roles & Permissions · Approval Matrix · Settings · Architecture & Security · Account & Security"]
  end

  PROJ --> SURV
  SURV <--> OWN
  GIS <--> SURV
  GIS <-->|draw / view polygons| REQ
  REQ -- "hand-over" --> ACQ
  SURV & OWN -- "parcels + owners" --> ACQ & CASE & LEASE & ROW
  MUT -- "updates shares" --> OWN
  CASE --> VCH
  LEASE --> VCH
  DBP --> VCH
  BUD -- "budget check at verify" --> VCH
  VCH --> CHQ --> RCT
  RCT -- "paid figures" --> STMT & REP
  LEG -. "stay order = payment hold" .-> CHQ

  classDef ov fill:#eef0ff,stroke:#4f46e5
  classDef md fill:#e7f5f8,stroke:#0e7490
  classDef lo fill:#ebf1ff,stroke:#1d4ed8
  classDef fi fill:#fdf4e7,stroke:#b45309
  classDef cm fill:#fcedf4,stroke:#be185d
  classDef rr fill:#eaf6ee,stroke:#15803d
  classDef sy fill:#eff2f6,stroke:#475569
  class DASH,GIS,PDASH,INBOX,CAL ov
  class UNITS,PROJ,SURV,OWN,PROV md
  class REQ,ACQ,CASE,LEASE,ROW,ENC,MUT,LEG lo
  class BUD,VCH,CHQ,RCT,DBP fi
  class GRV cm
  class REG,DOC,UPL,REP,STMT,AUDT rr
  class USR sy
  linkStyle 22 stroke:#c81e1e,stroke-dasharray:6 4
```

**How the modules connect.** The menu groups are the ones in the application (`nav.ts`).

**Land records.**
- A project holds khasra (survey) parcels.
- Each parcel carries co-owner shares that must total exactly 100%. The landowner's CNIC is the master key.
- Acquisition, compensation cases, leases and ROW corridors all work on those parcels and owners.
- A mutation (Wirasat / Intiqal) changes the ownership shares.

**Map and land requests.**
- The GIS map shows one point per khasra and the land-request polygons.
- An approved land request is handed over to the Land Officer as an acquisition.

**Payments.**
- An approved case, a lease or a DBPFC estimate (Sindh government land) produces a payment voucher.
- At verification the budget is checked and any hold applies. A court stay order on the parcel is one such hold.
- The cheque is released and the receipt recorded.
- The paid figures feed the landowner statement and the reports.
- Every change in every module writes to the append-only Audit Trail.

---

## D. End-to-end workflow

### Part 1: Land request and hand-over

```mermaid
flowchart LR
  subgraph EP["Exploration Planner · explorer, explorerqta"]
    A1["1 Draw polygon on the GIS map<br/>(or GPS corners / KML)<br/>Draft → Submitted"]
  end
  subgraph DO["Director Operations · land-request-reviewer · dirops"]
    A2["2 Tier 2: is the operational need real?"]
  end
  subgraph RM["Regional Manager · regmgr, regmgrqta, regmgrpnj"]
    A3["3 Tier 3: does the region support it?"]
  end
  subgraph LA["DM / TL Land Affairs · case-approver · landaffairs, -qta, -pnj"]
    A4["4 Tier 4: can the land be obtained?<br/>→ Approved"]
  end
  subgraph LOF["Land Officer (Field) · data-entry · lofield, loquetta, lopnj"]
    A5["5 Hand over → Handed over<br/>parcels: Under Acquisition"]
    A6["6 Create acquisition<br/>pre-filled, linked both ways"]
  end
  X(["Rejected (closed)"])

  A1 --> A2 -- Approve --> A3 -- Approve --> A4 -- Approve --> A5 --> A6
  A6 --> P2(["to Part 2: compensation case / lease"])
  A2 -. "Return (comment)" .-> A1
  A3 -. "Return (comment)" .-> A1
  A4 -. "Return (comment)" .-> A1
  A2 & A3 & A4 -. "Reject" .-> X

  linkStyle 6,7,8,9,10,11 stroke:#c81e1e,stroke-dasharray:6 4
```

**Steps.**
1. The **Exploration Planner** draws the land needed on the GIS map, as a polygon of latitude/longitude corners. The corners can also be pasted from a field GPS or uploaded as KML. The planner then submits the request.
2. The request passes three approval tiers, each decided only by the holder of that position in their own provinces:
   - **Tier 2, Director Operations:** is the operational need real?
   - **Tier 3, Regional Manager:** does the region support it?
   - **Tier 4, DM / TL Land Affairs:** can the land be obtained?
3. **Return.** Any tier can return the request with a comment. The planner edits the polygon and resubmits. A new version is kept, and all tiers start again.
4. **Reject.** Any tier can reject the request, which closes it.
5. **Hand-over.** Once the request is approved, the province's **Land Officer** hands it over:
   - the parcels inside the polygon are marked *Under Acquisition*;
   - an acquisition opens, pre-filled from the request.

**Rules.**
- The requester cannot approve their own request.
- One person can decide only one tier.
- Drafts are visible only to their author.
- The planner never sees owner names, CNICs or payments.

### Part 2: Compensation case and payment

```mermaid
flowchart LR
  subgraph L1["Land Officer (Field) · data-entry"]
    B1["1 Prepare case<br/>owners, heads, award<br/>→ Prepared"]
    B7["7 Raise voucher<br/>named landowner; capped at award<br/>→ Requested"]
  end
  subgraph L2["Negotiation Group · negotiation-officer"]
    B2["2 Check → Checked"]
  end
  subgraph L3["Legal Advisor · legal-advisor"]
    B3["3 Review → Reviewed"]
  end
  subgraph L4["Sr. Admin LMS (Field) · case-approver"]
    B4["4 Verify → Verified"]
  end
  subgraph L5["DM / TL (Field) · case-approver"]
    B5["5 Approval 1 → Field Approved"]
  end
  subgraph L6["Manager Land (HO) · land-manager"]
    B6["6 Approval 2 (Kharat) → HO Approved"]
    B9["9 Release → cheque CHQ-<br/>(not the verifier)"]
  end
  subgraph L7["Finance Officer · finance-approver"]
    B8["8 Verify<br/>budget, holds, WHT by filer status"]
    B10["10 Receipt RCPT-<br/>allocate to the owner"]
  end
  subgraph L8["System · database + SAP worker"]
    B9s["SAP outbox<br/>ERP posting queued"]
    B11["11 Landowner statement<br/>owed, paid, balance → reports"]
  end

  B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7 --> B8 --> B9
  B9 --> B10 --> B11
  B9 --> B9s
  B2 & B3 & B4 & B5 & B6 -. "Return for changes (reason required)" .-> B1

  linkStyle 11,12,13,14,15 stroke:#c81e1e,stroke-dasharray:6 4
```

**Steps.**
1. The **Land Officer** prepares the compensation case from the acquisition or lease: owners, heads of compensation and award.
2. The case then passes five position-checked stages:
   - **Checked** by the Negotiation Group;
   - **Reviewed** by the Legal Advisor;
   - **Verified** by the Sr. Admin LMS (Field);
   - **Field Approved** by the DM / TL (Field);
   - **HO Approved** (Kharat) by Manager Land (HO).
3. **Return for changes.** Any approver can send the case back to the Land Officer with a reason. Every approval then starts again.
4. **Voucher.** The Land Officer raises the payment voucher. It must name a landowner, and the vouchers on a case cannot exceed its award.
5. **Verification.** The **Finance Officer** verifies the voucher. At this point:
   - the budget is checked;
   - payment holds apply: court stay order, deceased owner, lease or landowner hold;
   - the FBR withholding tax is computed for the payee's filer or non-filer status.
6. **Release.** **Manager Land (HO)** releases the cheque. The releaser cannot be the verifier. Release queues the ERP posting in the SAP outbox.
7. **Receipt and statement.** Finance records the receipt, and the landowner statement shows the balance.

**Separation of duties.**
- The preparer cannot approve.
- One person, one tier.
- Only the position holder decides, in their own provinces.
- Finance verifies and Manager Land releases.

---

## E. Controls built into the system

```mermaid
flowchart LR
  C1["Province isolation<br/>row-level security; out of scope → 404"]
  C2["Separation of duties<br/>preparer ≠ approver; one person, one tier;<br/>sod_mode = strict"]
  C3["MFA and re-auth<br/>TOTP / passkey; re-auth within 10 min"]
  C4["Audit trail<br/>append-only audit_event"]
  C5["PII masking<br/>CNIC, phone, bank need pii:read"]
  C6["WHT filer / non-filer<br/>computed in DB; non-filer = 2× filer"]
  C7["Payment holds<br/>stay order, deceased owner, lease hold"]
  C8["Budget check<br/>at voucher verification"]
  C9["Award cap<br/>vouchers ≤ payable award; idempotency keys"]
```

**What the controls do.** All of these rules are enforced by the server and the database, not only by the screens.

| Control | How it works |
|---|---|
| Province isolation | PostgreSQL row-level security shows each user only their assigned provinces. A record outside their scope answers 404. |
| Separation of duties | The strict mode is on and the administrator override is off. The preparer cannot approve, and one person decides one tier. |
| MFA and re-authentication | Sensitive permissions need TOTP or a passkey. Privileged actions need re-authentication within 10 minutes. |
| Audit trail | The audit trail is append-only. |
| PII masking | CNIC, phone and bank details need `pii:read`. The auditor and the administrator see CNICs masked. |
| Withholding tax | Computed in the database. The non-filer rate is twice the filer rate. A rate sent by the client is never trusted. |
| Payment holds | A court stay order, a deceased owner (until the Wirasat / Intiqal mutation), a lease hold or a landowner hold blocks verification and release. |
| Budget check | The voucher must fit the project budget. |
| Award cap | Vouchers on a case cannot exceed its payable award. Idempotency keys stop duplicate payments. |

---

## Sources and limits

**Sources:**
- `CLAUDE.md` §2–§5 and §9b
- `docs/architecture/DATA_FLOW_DIAGRAMS.md`
- `src/components/layout/nav.ts`
- `docs/plans/EXPLORATION_LAND_REQUEST_GIS_PLAN.md`
- `docs/reports/E2E_AUDIT_2026-10-31.md`
- `db/migrations/0015_reference_data.sql` (workflow stages and positions), 0057–0059
- `iam.role_permission` on `lms_dev`, queried 31 Oct 2026

**Not yet verified in production:**
- real SSO against AD/Entra;
- the SAP gateway connection;
- production TLS, backups and monitoring.

The system is **not yet released**: see the release assessment and the open items in the E2E audit.

**Limit:** until PostGIS khasra boundaries are added, a parcel counts as "inside" a polygon when its single point is inside it.
