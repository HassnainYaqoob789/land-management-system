# LMS Data Flow Diagrams

Mari Energies Land Management System. The diagrams show how data moves between people, outside parties, the system's processes and its data stores. They describe the system as built on 3 Nov 2026 (database migration 0062).

**How to read them**

| Shape | Meaning |
|---|---|
| Rectangle | External entity: a person or outside party |
| Rounded box with a number | Process: work the system does (1.0, 2.0 …) |
| Cylinder with D-number | Data store: where the data is kept (D1, D2 …) |
| Arrow label | The data that moves |
| Dotted arrow | Happens outside the system, or by hand |

---

## 1. Level 0: Context diagram

The whole system as one process, with everyone who gives it data or takes data from it. The full list of what each one gives and gets is in section 5.

```mermaid
flowchart LR
  FO["Land Officer (Field)"] <-->|field records / work queues| LMS
  EP["Exploration Planner"] <-->|polygons / request status| LMS
  RV["Land request reviewers"] <-->|decisions / requests waiting| LMS
  AP["Case and acquisition approvers"] <-->|approvals / records waiting| LMS
  FI["Finance Officer"] <-->|verify, holds, receipts / vouchers| LMS
  ML["Manager Land (HO)"] <-->|release, stays, rates / HO queue| LMS
  AD["System Administrator"] <-->|users, roles, settings| LMS
  MG["Director / Viewer"] <-->|dashboards, reports| LMS
  AU["Internal Audit"] <-->|audit trail| LMS
  LMS(["0.0 Land Management System"])
  LMS -->|released payments| SAP["SAP / Bank"]
  IDP["Identity provider, mail"] <-->|sign-on / mail| LMS
  MAP["OpenStreetMap"] -->|map tiles| LMS
  REV["Revenue Department"] -.->|Fard, Intiqal| FO
  CRT["Courts"] -.->|stay orders, decrees| FO
```

---

## 2. Level 1: Main processes and data stores

Shown in two parts. **Every process** also writes each change to **D8 Audit trail**, and every request first passes **1.0 Sign in and access control** (see 3.1).

### 2a. Land side

```mermaid
flowchart TD
  U["Field and exploration users"]
  P2(["2.0 Master data: projects, khasras, owners, shares"])
  P3(["3.0 Land requests on the GIS map"])
  P4(["4.0 Acquisition and title"])
  P9(["9.0 Mutation and succession"])
  P11(["11.0 Documents and data import"])
  D2[("D2 Projects, khasras, owners, shares")]
  D3[("D3 Land requests, polygons")]
  D4[("D4 Acquisitions, cases, leases")]
  D6[("D6 Mutations")]
  D7[("D7 Document files")]
  U --> P2 & P3 & P11
  P2 <--> D2
  P3 <--> D3
  P3 -->|parcels inside| D2
  P3 -->|handed over| P4
  P4 <--> D4
  P4 -->|progress, land ready| D3
  P4 -->|Acquired / Leased| D2
  P9 <--> D6
  P9 -->|shares move| D2
  P9 -->|unpaid share re-pointed| D4
  P11 <--> D7
  P11 -->|validated rows| D2
```

### 2b. Money and control side

```mermaid
flowchart TD
  U["Approvers, Finance, Manager Land"]
  P5(["5.0 Compensation cases"])
  P6(["6.0 Leases, ROW, DBPFC"])
  P7(["7.0 Payments and cheques"])
  P8(["8.0 Legal and litigation"])
  P10(["10.0 Encroachments, grievances"])
  P12(["12.0 Reports, dashboards, alerts"])
  D4[("D4 Cases, leases, ROW, DBPFC")]
  D5[("D5 Vouchers, cheques, holds")]
  D6[("D6 Legal, encroachments, grievances")]
  D9[("D9 SAP outbox")]
  U --> P5 & P6 & P7 & P8 & P10
  P5 <--> D4
  P6 <--> D4
  P5 -->|approved award| P7
  P6 -->|rent, government land| P7
  P7 <--> D5
  P7 -->|released payment| D9
  P8 <--> D6
  P8 -->|stay order hold| D5
  P10 <--> D6
  D4 & D5 & D6 --> P12
  P12 -->|reports, queues, calendar| U
```

---

## 3. Level 2 flows

### 3.1 Process 1.0: Sign in and access control

Every request runs as the signed-in user inside one database transaction. The database itself checks the user's province, permission and approval position before any data is read or changed.

```mermaid
flowchart TD
  U["User"]
  A(["1.1 Check password or single sign-on"])
  B(["1.2 Two-step verification"])
  C(["1.3 Create session"])
  E(["1.4 Check each request"])
  D1[("D1 Users, roles, positions")]
  DS[("D1 Sessions")]
  D8[("D8 Sign-in log")]
  U -->|username, password| A
  A <-->|password hash, lock count| D1
  A -->|failed or successful attempt| D8
  A -->|MFA needed| B
  B -->|code or passkey| C
  A -->|no MFA needed| C
  C -->|session token hash| DS
  C -->|session cookie| U
  U -->|every request with cookie and CSRF token| E
  E <-->|permissions, province, position| D1
  E -->|allowed request| OUT["Business process 2.0 to 13.0"]
```

### 3.2 Processes 3.0 and 4.0: Land request to land ready

```mermaid
flowchart TD
  EP["Exploration Planner / Land Officer"]
  R1["Director Operations"]
  R2["Regional Manager"]
  R3["DM / TL Land Affairs"]
  LO["Land Officer (Field)"]
  AQ["Negotiation, DM / TL, Manager Land, Sr. Admin"]
  P31(["3.1 Draw polygon and submit"])
  P32(["3.2 Three-tier review"])
  P33(["3.3 Start land work"])
  P41(["4.1 Create acquisition from the request"])
  P42(["4.2 Acquisition stages and title checks"])
  P43(["4.3 Handover"])
  D3[("D3 Land requests, polygon versions")]
  D2[("D2 Khasras")]
  D4[("D4 Acquisitions")]
  EP -->|corners, purpose, project, justification| P31
  P31 -->|area, parcels inside, warnings| EP
  P31 -->|request v1| D3
  D3 --> P32
  R1 & R2 & R3 -->|approve, return or reject with comment| P32
  P32 -->|returned: redraw as v2| P31
  P32 -->|approved| P33
  LO -->|kind of land work, comment| P33
  P33 -->|Proposed khasras inside become Under Acquisition| D2
  P33 --> P41
  LO -->|mode, rate, khasras pre-filled| P41
  P41 --> D4
  AQ -->|stage moves, title checks| P42
  P42 <--> D4
  P42 -->|stage copied to the request| D3
  P42 --> P43
  P43 -->|khasras Acquired or Leased| D2
  P43 -->|request Completed, Land ready| D3
  D3 -->|Land ready alert| EP
```

### 3.3 Processes 5.0 and 7.0: Compensation to cheque

```mermaid
flowchart TD
  LO["Land Officer (Field)"]
  AP["Negotiation, Legal, Sr. Admin, DM / TL, Manager Land"]
  FI["Finance Officer"]
  ML["Manager Land (HO)"]
  OW["Landowner"]
  P51(["5.1 Prepare case: owners, lines, documents"])
  P52(["5.2 Five-step approval"])
  P71(["7.1 Request voucher"])
  P72(["7.2 Verify"])
  P73(["7.3 Release cheque"])
  P74(["7.4 Receipt and allocation"])
  D2[("D2 Owners, shares, khasras")]
  D4[("D4 Cases")]
  D5[("D5 Vouchers, cheques, receipts, holds")]
  D9[("D9 SAP outbox")]
  SET[("Settings: WHT %, budget")]
  LO -->|owners and shares, lease, crop, tree, other lines, document ticks| P51
  D2 -->|owners, khasra areas| P51
  P51 -->|award total| D4
  AP -->|one step each| P52
  P52 <--> D4
  D4 -->|HO Approved award per owner| P71
  LO -->|payee, category, gross amount| P71
  SET -->|WHT 10% filer, 20% non-filer| P71
  P71 -->|voucher: gross, WHT, net| D5
  FI --> P72
  P72 -->|hold check, budget check| D5
  ML -->|cheque date, password again| P73
  P73 -->|cheque| D5
  P73 -->|posting| D9
  D9 -.->|SAP worker| SAPX["SAP / Bank"]
  P73 -.->|cheque| OW
  FI -->|receipt no., allocation of the net amount| P74
  P74 --> D5
```

### 3.4 Process 8.0: Court stay stops payment

```mermaid
flowchart TD
  LG["Legal Advisor"]
  ML["Manager Land (HO)"]
  FI["Finance Officer"]
  CRT["Court"]
  P81(["8.1 Record legal case with stay order"])
  P82(["8.2 Place payment holds"])
  P83(["8.3 Lift stay with court order"])
  D6[("D6 Legal cases, linked khasras and owners")]
  D5[("D5 Payment holds, vouchers")]
  CRT -.->|stay order| LG
  LG -->|court, parties, parcels, landowners, stay ticked| P81
  P81 --> D6
  P81 --> P82
  P82 -->|hold on each linked owner and khasra| D5
  FI -->|verify or release| D5
  D5 -->|refused: Payment is on hold| FI
  CRT -.->|order vacating the stay| ML
  ML -->|court order text| P83
  P83 -->|stay off| D6
  P83 -->|holds lifted| D5
```

### 3.5 Process 9.0: Mutation moves shares and payments

```mermaid
flowchart TD
  LO["Land Officer (Field)"]
  SA["Sr. Administrator"]
  LG["Legal Advisor"]
  ML["Manager Land (HO)"]
  FI["Finance Officer"]
  P91(["9.1 Record mutation: transferor, heirs or buyer"])
  P92(["9.2 Revenue record and checks"])
  P93(["9.3 Approve and apply"])
  D2[("D2 Ownership shares and history")]
  D4[("D4 Open cases and active leases")]
  D5[("D5 Seller's unreleased vouchers")]
  D6[("D6 Mutations, re-point log")]
  LO -->|type, transferor, transferees and shares| P91
  D2 -->|khasras the transferor holds| P91
  P91 --> D6
  SA -->|Intiqal no., date, office| P92
  LG -->|legal clearance| P92
  P92 <--> D6
  ML --> P93
  P93 -->|shares move to heirs or buyer| D2
  P93 -->|unpaid case share and lessor role re-pointed, parcel-wise| D4
  P93 -->|vouchers put on hold| D5
  P93 -->|what moved| D6
  FI -->|cancel or lift held voucher| D5
```

### 3.6 Processes 12.0 and 13.0: Reports, alerts and audit

```mermaid
flowchart TD
  ALL[("D1 to D7: every register")]
  P121(["12.1 Approval queue: records waiting on my position"])
  P122(["12.2 Calendar: lease expiry, ROW renewal, hearings, required-by dates"])
  P123(["12.3 Dashboards and KPIs"])
  P124(["12.4 Reports and Landowner Register: PDF, Excel, CSV"])
  P13(["13.0 Audit trail"])
  D8[("D8 Audit events, record versions, sign-in log, document access")]
  AP["Approvers"]
  MG["Director, Manager Land, Viewer"]
  AU["Internal Audit"]
  ALL --> P121 --> AP
  ALL --> P122 --> AP
  ALL --> P123 --> MG
  ALL -->|province-limited rows, CNIC masked without permission| P124 --> MG
  ALL -->|every insert, update, stage move| P13 --> D8
  D8 -->|search by record, user, date| AU
```

---

## 4. Data stores

| Store | Holds | Main tables |
|---|---|---|
| D1 | Users, roles, permissions, approval positions, provinces, sessions, MFA | `lms.app_user`, `lms.app_user_group`, `lms.app_user_province`, `iam.role`, `iam.role_permission`, `iam.user_role`, `lms.login_session`, `iam.mfa_*` |
| D2 | Projects, administrative hierarchy, khasras, landowners, ownership shares | `lms.project`, `lms.admin_unit`, `lms.survey`, `lms.landowner`, `lms.survey_ownership_share`, `lms.survey_ownership_history` |
| D3 | Land requests, versioned polygons | `lms.land_request`, `lms.land_request_area` |
| D4 | Acquisitions, title checks, compensation cases and lines, leases, ROW corridors, DBPFC estimates, budgets | `lms.acquisition`, `lms.acquisition_title_check`, `lms.compensation_case`, `lms.case_*`, `lms.lease`, `lms.row_corridor`, `lms.dbpfc_estimate`, `lms.budget` |
| D5 | Vouchers, cheques, reversals, receipts, allocations, payment holds, reconciliation | `lms.payment_request`, `lms.payment_release`, `lms.payment_release_reversal`, `lms.payment_receipt`, `lms.payment_allocation`, `lms.payment_hold`, `lms.reconciliation_run` |
| D6 | Legal cases and hearings, mutations and re-point log, encroachments, grievances | `lms.legal_case`, `lms.legal_hearing`, `lms.mutation`, `lms.mutation_repoint`, `lms.encroachment`, `lms.grievance` |
| D7 | Uploaded files (stored by content hash), KML layers, import batches | `lms.document`, `lms.project_kml_import`, `lms.import_batch` + the document folder on disk |
| D8 | Audit events, record versions, sign-in events, document access log | `audit.audit_event`, `audit.record_version`, `audit.auth_event`, `lms.document_access_log` |
| D9 | Released payments waiting to be posted to SAP | `lms.integration_outbox` |
| — | Workflow stages, who approves each step, settings | `lms.workflow_stage`, `lms.workflow_step_group`, `lms.system_setting` |

## 5. External entities

| Entity | Gives the system | Gets from the system |
|---|---|---|
| Land Officer (Field) | Projects, khasras, owners, shares, cases, vouchers, mutations, encroachments, grievances, documents | Work queues, alerts, calendar |
| Exploration Planner | Land request polygons | Request status, Land ready |
| Land request reviewers (Director Operations, Regional Manager, DM / TL Land Affairs) | Approve, return, reject | Requests waiting on them |
| Case and acquisition approvers (Negotiation, Legal, Sr. Admin, DM / TL Field, Manager Land) | One approval step each | Records waiting on their position |
| Finance Officer | Verification, holds, receipts, cancellations | Vouchers, cheques, reconciliation |
| Manager Land (HO) | Cheque release, lifting stays, rate fixing, budgets | Head-office queue, dashboards |
| Director / Viewer | — | Dashboards, reports |
| Internal Audit | — | Audit trail, sign-in log |
| System Administrator | Users, roles, positions, settings, land units | User and session lists |
| Revenue Department (outside the system) | Fard, Intiqal, revenue records, entered by the Land Officer | — |
| Courts (outside the system) | Stay orders and decrees, entered by Legal / Manager Land | — |
| SAP / Bank | — | Postings of released payments (D9) |
| Identity provider, mail server | Single sign-on identity | Invitation and password-reset mail |
| OpenStreetMap | Map tiles | — |
