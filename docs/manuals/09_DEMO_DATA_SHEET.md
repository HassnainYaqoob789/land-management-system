# LMS Demo Data Sheet (fresh data set)

Copy-paste values for every module, in the same order and numbers as **08 Module Workflow Quick Reference** (08 shows where to click; this sheet shows what to type). Every name, CNIC, khasra and code here is invented and does not clash with data already in the system (checked against `lms_dev` on 3 Nov 2026).

**Rehearsed on 3 Nov 2026 against a copy of lms_dev: 76/76 steps passed** (every step below, through the app's own API, with the accounts named); the encroachment and grievance approval chains were added afterwards and checked in the database on 3 Nov 2026 (rolled back).

---

## Before you start

| # | Item | What to do |
|---|---|---|
| 1 | Site | Live: `https://land-management.alisonstech-dev.com`. Local: `http://localhost:3040`. |
| 2 | Backup first | Live (VPS): `export PATH="$HOME/pg18/bin:$PATH"; PGPASSWORD="$(cat ~/.pg_super_pw)" pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc -d lms_prod -f ~/backups/before_demo_$(date +%F).dump`. Local: `pg_dump -Fc -d lms_dev -f backups/before_demo.dump`. |
| 3 | Browser | One **incognito window per account**, or **Sign out** (top-right name → Sign out) between accounts. Choose **Sindh** on *Select province*. |
| 4 | Codes | Codes below are **e.g.**: the real number depends on what already exists (on live they will be higher). Carry on with whatever code the screen shows. |
| 5 | Dates | Type dates as `DD/MM/YYYY` in the date boxes. |
| 6 | Order | Do the sections in order. Section 4 (shares) must be done **before** section 14 (mutation). |

---

## 0. Accounts used

| Account | Position | Used in |
|---|---|---|
| `admin` | System Administrator | 1, 21 |
| `lofield` | Land Officer (Field), Sindh | 2, 3, 4, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17 |
| `explorer` | Exploration Planner | 5 |
| `dirops` / `regmgr` / `landaffairs` | Director Operations / Regional Manager / DM-TL Land Affairs | 5 |
| `nego` | Negotiation Group | 6, 7 |
| `legal` | Legal Advisor | 7, 13, 14 |
| `sradmin` | Sr. Administrator LMS (Field) | 6, 7, 8, 9, 10, 14 |
| `dmfield` | DM / Team Lead (Field) | 6, 7 |
| `mland` | Manager Land (HO) | 6, 7, 8, 9, 10, 11, 12, 13, 14 |
| `finance` | Finance Officer | 12, 13, 14 |
| `audit` | Internal Audit | 20 |

---

## 1. Users & Roles (optional): `admin`

**Users & Roles → + Add User**

| Field | Value |
|---|---|
| Username | `sindh.officer2` |
| Full name | `Shabana Memon` |
| Email | `shabana.memon@lms.invalid` |
| Department | `Land` |
| Position | `Land Officer (Field)` |
| Office | same as `lofield` |
| Roles | `data-entry` |
| Provinces | `SND` |
| Approval positions | `Land Officer (Field)` |

→ **Create and get invitation link**. **Expected:** an invitation link is shown (copy it if you want to show first sign-in).

---

## 2. Project: `lofield`

**Projects / Well Locations → + Add Project**

| Field | Value |
|---|---|
| Project code | `DHRK-410` |
| Province | Sindh |
| Name | `Daharki Well-07 Exploratory Location` |
| Type | `Well Location` |
| Block / concession | `Daharki D&PL` |
| District | `Ghotki` |
| Required area | `18` |
| Description | `Exploratory well pad, rig camp and 1.2 km access road south of Bago Daharki. Spud planned Mar 2027.` |

→ **Save**. **Expected:** DHRK-410 in the list.

---

## 3. Landowners: `lofield`

**Landowners → + Add Landowner**, once per owner. Province **Sindh**, Owner type **O — Owner** for all.

| Field | Owner 1 | Owner 2 (sells later) | Owner 3 (buyer) | Owner 4 (lessor) |
|---|---|---|---|---|
| CNIC (type the digits) | `4510531002115` | `4510531002123` | `4510531002131` | `4510531002149` |
| Full name (as on CNIC) | `Karim Bux Unar` | `Rahim Bux Unar` | `Ali Sher Kalhoro` | `Gul Muhammad Bhutto` |
| Father / husband name | `Haji Ali Nawaz Unar` | `Haji Ali Nawaz Unar` | `Muhammad Hayat Kalhoro` | `Allah Rakhio Bhutto` |
| Tax status | `Filer` | `Non-Filer` | `Filer` | `Filer` |
| Phone | `0301-4471122` | `0302-5582233` | `0333-6693344` | `0300-7704455` |
| Bank branch | `HBL Daharki` | `Meezan Bank Daharki` | `UBL Daharki` | `National Bank Daharki` |
| IBAN | `PK62HABB0024710000561234` | `PK41MEZN0014620000873311` | `PK18UNIL0109000398765432` | `PK05NBPA0123004500678912` |
| Address | `Village Bago, Taluka Daharki, District Ghotki` | same | `Mohalla Kalhoro, Daharki, District Ghotki` | `Village Bago, Taluka Daharki, District Ghotki` |

**Expected:** e.g. SND-000047 … SND-000050. Saving the same CNIC twice is refused ("This CNIC is already registered").

---

## 4. Khasras and shares: `lofield`

**Survey / Khasra Register → + Add Survey**, once per khasra. Province **Sindh**, Revenue location **Ghotki → Daharki → Bago Daharki**, Project **DHRK-410**, Block no. `14`, Khasra type `Rural`, Land class **Private**.

| Field | Khasra 1 | Khasra 2 | Khasra 3 |
|---|---|---|---|
| Survey / khasra no. | `611/1` | `611/2` | `612` |
| Recorded area + unit | `10` + **Acre** | `240` + **Ghunta** | `5` + **Acre** |
| Latitude | `28.0215` | `28.0208` | `28.0190` |
| Longitude | `69.6365` | `69.6377` | `69.6400` |
| Remarks | `Cotton field; boundary with katcha road on the west.` | `Cotton standing at the time of survey; 5 kikar trees.` | `Barren; proposed rig camp.` |

**Expected:** e.g. AREA-000034 (10 ac), AREA-000035 (**6 ac**: 240 Ghunta ÷ 40), AREA-000036 (5 ac).

**Shares** (on each row click **Shares** → *Landowner to add* → **+** → share → **Save shares**; total must be 100%):

| Khasra | Owners and shares | Revenue document |
|---|---|---|
| 611/1 | Karim Bux Unar `60`, Rahim Bux Unar `40` | `Fard 2026/411` |
| 611/2 | Karim Bux Unar `50`, Rahim Bux Unar `50` | `Fard 2026/412` |
| 612 | Gul Muhammad Bhutto `100` | `Fard 2026/413` |

---

## 5. GIS land request (draw, return, redraw, approve)

### 5a. Draw and submit: `explorer`

**GIS Land Map → ✎ Draw land request → Paste lat/long** → paste → **Use these corners**:

```
28.02250, 69.63550
28.02250, 69.63850
28.02000, 69.63850
28.02000, 69.63550
```

**Expected:** about **20.20 acres**, **2 parcels inside** (611/1, 611/2). → **Continue: request details**:

| Field | Value |
|---|---|
| Project | `DHRK-410` |
| Purpose | `Well Location` |
| Priority | `Urgent` |
| Required by | `15/02/2027` |
| Target deh / village | `Bago Daharki` |
| Concession block | `Daharki D&PL` |
| Justification | `Exploratory well Daharki Well-07: pad 120 m x 120 m, rig camp, mud pits and a 1.2 km access road. Rig arrives Mar 2027, so land is needed by 15 Feb 2027.` |

→ **Submit to Director Operations**. **Expected:** e.g. **REQ-2026-0004**, polygon orange.

### 5b. Approvals (sign in → Land Requests → click the row's **Review** → *Decision* ▾ → *Comment* → button)

| # | Sign in as | Choice | Comment |
|---|---|---|---|
| 1 | `dirops` | Approve | `Operational need confirmed: Well-07 is in the 2027 drilling plan.` |
| 2 | `regmgr` | **Return** | `Pull the north boundary about 45 m south to stay clear of the village graveyard, then resubmit.` |

### 5c. Redraw: `explorer`

Land Requests → **Edit on map** → **Clear** → **Paste lat/long**:

```
28.02210, 69.63550
28.02210, 69.63850
28.02000, 69.63850
28.02000, 69.63550
```

**Expected:** about **16.97 acres**, still 2 parcels inside. **Continue: review and save** → What changed: `North boundary moved 45 m south, as asked by the Regional Manager.` → **Save and send to Director Operations**.

### 5d. Final approvals (each: sign in → Land Requests → **Review** → *Decision* **Approve** → *Comment* → **Approve**)

| # | Sign in as | Comment |
|---|---|---|
| 3 | `dirops` | `Revised boundary acceptable.` |
| 4 | `regmgr` | `Region supports it; graveyard now outside.` |
| 5 | `landaffairs` | `Private land, two owners identified, no litigation recorded. Approved.` |

**Expected:** stage **Approved**; Details → Polygon versions shows v2 and v1.

---

## 6. Acquisition (from the request)

### 6a. Take it up: `lofield`

Sign in as **`lofield`** → Land Requests → click REQ… → **Start land work**: Land work `Acquisition`, keep *Mark the recorded parcels … Under Acquisition* ticked, comment `Negotiation with the Unar family starts 15 Nov 2026.` → **Take it up**. Then **Create acquisition** (form is pre-filled):

| Field | Value |
|---|---|
| Mode | `Private Lease` |
| Negotiated rate (Rs / acre) | `55000` |
| Target handover | `15/02/2027` |
| Surveys | 611/1, 611/2 (pre-filled) |

→ **Save**. **Expected:** e.g. **ACQ-2026-0004**. Then on its row click **Title** → tick all **7** checks → close.

### 6b. Stages (sign in as each account → Acquisition & Title → click the row → **→** button → note → **Move to …**)

| Sign in as | Button | Note |
|---|---|---|
| `nego` | → Negotiation | `Rate of Rs 55,000/acre/year agreed with both owners.` |
| `dmfield` | → Approval | `Approved at field level.` |
| `mland` | → Acquisition / Lease | `Lease approved at head office.` |
| `sradmin` | → Handover | `Possession taken on site.` |

**Expected:** request **Completed** ("Land ready"); khasras 611/1 and 611/2 **Leased**.

---

## 7. Compensation case: `lofield`

**Compensation Cases → + Add Compensation Case**

| Field | Value |
|---|---|
| Project / well location | `DHRK-410` |
| Land used for | `Well Location` |
| Lease rate (Rs / acre / year) | `55000` |
| Lease term (months) | `36` |
| Remarks | `Three-year surface lease for the Well-07 pad, with cotton and tree damage.` |

| Section → **+ Add line** | Values |
|---|---|
| Landowners | Karim Bux Unar `60` `O`; Rahim Bux Unar `40` `O` |
| Lease lines | Survey 611/1, owners' share `100`, area `10` |
| Crop compensation | Survey 611/2, Crop `Cotton`, Rate `50000`, Damaged `4` |
| Tree compensation | Survey 611/2, Species `Kikar`, Size `Large`, Rate `9000`, Qty `5` |
| Other compensation | Survey 611/1, `Disturbance allowance`, `30000` |
| Documents seen | tick **all** (required before Field Approved) |

→ **Create case**. **Expected:** e.g. **CC-2026-0012**, stage *Prepared*:

| Head | Calculation | Rs |
|---|---|---|
| Lease | 55,000 × 10 ac × 3 yr | 1,650,000 |
| Crop | 50,000 × 4 ac | 200,000 |
| Trees | 9,000 × 5 | 45,000 |
| Other | — | 30,000 |
| **Total** | | **1,925,000** |

**Approval chain** (sign in as each account → Compensation Cases → click the case row → **→** button → note → **Move to …**):

| Sign in as | Button | Note |
|---|---|---|
| `nego` | → Checked | `Rates agreed with both owners on site.` |
| `legal` | → Reviewed | `Title clear per Fard 2026/411-412; no litigation.` |
| `sradmin` | → Verified | `Field records and measurements verified.` |
| `dmfield` | → Field Approved | `Approved at field level.` |
| `mland` | → HO Approved | `Approved at head office.` |

---

## 8. Lease (rig camp on 612)

Sign in as **`lofield`** → **Leases & Agreements → + Add Lease**

| Field | Value |
|---|---|
| Project / well location | `DHRK-410` |
| Lease kind | `Private Land` |
| Initial area (acres) | `5` |
| Lessor (landowner) | `Gul Muhammad Bhutto` |
| Survey parcel (optional) | 612 |
| Start date | `01/12/2026` |
| Term (years) | `3` |
| Annual rent (Rs) | `250000` |
| Escalation (% / yr) | `10` |

**Expected:** e.g. **LSE-00007**, *Draft*. Then:
1. Sign in as **`sradmin`** → Leases & Agreements → click the lease row → **→ Under Review** → note `Lease deed and Fard checked.` → **Move to Under Review**.
2. Sign in as **`mland`** → same row → **→ Approved** → note `Approved at head office.` → **Move to Approved**.

---

## 9. ROW corridor

Sign in as **`lofield`** → **ROW & Pipelines → + Add ROW Corridor**

| Field | Value |
|---|---|
| Project | `DHRK-410` |
| Corridor name | `Well-07 flowline to Daharki Gathering Station` |
| Type | `Flowline ROW` |
| Agreement date | `05/12/2026` |
| From | `Well-07 pad` |
| To | `Daharki Gathering Station` |
| Length (m) | `1800` |
| Width (m) | `15` |
| Tenure (years) | `10` |
| Annual rent (Rs) | `120000` |
| Obligations | `Restore the topsoil after laying; keep a 3 m cattle crossing every 300 m.` |

**Expected:** e.g. **ROW-0006**, **6.67 acres** (1,800 × 15 m). Then:
1. Sign in as **`sradmin`** → ROW & Pipelines → click the row → **→ Under Review** → note `Route walked; no structures.` → **Move to Under Review**.
2. Sign in as **`mland`** → same row → **→ Approved** → note `Approved at head office.` → **Move to Approved**.

---

## 10. DBPFC estimate (Sindh government land)

Sign in as **`lofield`** → **DBPFC — Sindh Govt Land → + Add Estimate**

| Field | Value |
|---|---|
| Sindh project | `DHRK-410` |
| District | `Ghotki` |
| Area | `3` |
| Estimated rate (Rs / acre / year) | `40000` |
| Committee reference | `DBPFC/GHK/2026/41` |
| Meeting date | `15/12/2026` |
| Remarks | `Government land strip along the access road (3 acres).` |

**Expected:** e.g. **DBP-0004**, *Estimated*. Then:
1. Sign in as **`sradmin`** → DBPFC — Sindh Govt Land → click the row → **→ Referred to DBPFC** → note `Sent to the committee.` → **Move to Referred to DBPFC**.
2. Sign in as **`mland`** → same row → **Record rate**: Fixed rate `42000`, Committee reference `DBPFC/GHK/2026/41`, Meeting date `15/12/2026` → **Save rate**.
3. Still `mland` → same row → **→ Rate Fixed** → note `Rate fixed by the committee.` → **Move to Rate Fixed** (recording the rate does not move the stage). **Expected:** *Rate Fixed*, fixed 42,000.

---

## 11. Budget: `mland`

**Budgets → + Add Budget**

| Field | Value |
|---|---|
| Project | `DHRK-410` |
| Fiscal year | `2027` |
| Approved amount (Rs) | `5000000` |
| Approval reference | `BOD/LAND/2026/17` |
| Remarks | `Land budget for Well-07 (lease, crop, ROW, DBPFC).` |

**Expected:** e.g. **BGT-0008**, FY 2027, Rs 5,000,000.

---

## 12. Payments

Sign in as **`lofield`** → **Payments & Cheques → + Request Payment**. Project `DHRK-410`, Case the CC from section 7, Land class `Private`.

| Field | Voucher A | Voucher B (leave unreleased) |
|---|---|---|
| Payee (landowner) | Karim Bux Unar | Rahim Bux Unar |
| Category | `Lease Rent` | `Crop Compensation` |
| Pay type | `Advance Lease (multi-year)` | `One-time` |
| Payment mode | `Cross Cheque` | `Direct Credit (IBFT)` |
| Period from / to | `01/12/2026` / `30/11/2029` | `01/12/2026` / — |
| Gross amount (Rs) | `800000` | `300000` |
| Remarks | `Advance lease rent, first instalment (60% owner).` | `Cotton damage on 611/2 (40% owner).` |

**Expected:**

| Voucher | Tax status | WHT | Net |
|---|---|---|---|
| A, e.g. VCH-2026-00034 | Filer | 10% = 80,000 | **720,000** |
| B, e.g. VCH-2026-00035 | Non-Filer | **20%** = 60,000 | **240,000** |

Then on voucher A:

| Sign in as | Action | Values |
|---|---|---|
| `finance` | **Verify** | Note `Payee, WHT and case checked.` |
| `mland` | **Release cheque** | Cheque date `02/12/2026`, Note `Released at Daharki field office.` → e.g. **CHQ-…**, Rs 720,000 |
| `finance` | **Record receipt** (on the cheque) | Receipt no. `RCPT-2026-0410`, Received on `02/12/2026`, Acknowledged by `Karim Bux Unar`, Their CNIC `45105-3100211-5`, Remarks `Cheque received in person.` → then **Print receipt** in Receipts |
| `finance` | **Allocate voucher** (Liabilities, on the case) | Voucher A, Amount `720000` (the **net**), Note `Advance lease rent against the award.` |

**Negative check:** a new Lease Rent voucher of `2000000` on the case is refused ("at most … can still be requested").

---

## 13. Legal case with a stay order

1. Sign in as **`lofield`** → **+ Request Payment**: payee Karim Bux Unar, `Lease Rent`, `Yearly Lease`, `Cross Cheque`, `Private`, period `01/12/2027` to `30/11/2028`, gross `150000`, remarks `Second-year rent top-up (court stay demo).` → e.g. **VCH-2026-00036**.
2. Sign in as **`legal`** → **Legal & Litigation → + Add Legal Case**:

| Field | Value |
|---|---|
| Province | Sindh |
| Court case no. | `C.S. 377/2026` |
| Court | `Senior Civil Judge, Ghotki` |
| Case type | `Civil suit (title)` |
| Company is | `Proforma Party` |
| Status | `Pending` |
| Parties | `Haji Wali Muhammad Unar v. Karim Bux Unar & Mari Energies Ltd` |
| Project | `DHRK-410` |
| Filed on | `08/12/2026` |
| Next hearing | `22/12/2026` |
| Counsel | `Advocate Rubina Dahri` |
| Financial exposure (Rs) | `900000` |
| Parcels concerned | 611/1 |
| Landowners concerned | Karim Bux Unar |
| Stay order in force | **ticked** |
| Remarks | `Uncle claims a share in khasra 611/1; court ordered status quo on payments.` |

**Expected:** e.g. **LIT-0006**, 2 holds placed.

3. Sign in as **`finance`** → voucher of step 1 → **Verify** → **refused**: "Payment is on hold: stay order in C.S. 377/2026 …".
4. Sign in as **`mland`** → LIT… → **Update**: Status `Decided — In Favour`, untick **Stay order in force**, Court order lifting the stay `Order of 22 Dec 2026 in C.S. 377/2026: suit dismissed, stay vacated.` → Save.
5. Sign in as **`finance`** → **Verify** again (note `Stay vacated; verified.`) → works.

---

## 14. Mutation (sale): Rahim sells to Ali Sher

1. Sign in as **`lofield`** → **Mutation & Succession → + Add Mutation**: Type `Sale / Transfer`, Transferor (current owner) `Rahim Bux Unar`, **+ Add transferee** `Ali Sher Kalhoro`, relation `Buyer`, share `100`, Remarks `Rahim Bux Unar sold his whole share in 611/1 and 611/2 to Ali Sher Kalhoro.` → Save. **Expected:** e.g. **MUT-0007**, Surveys 611/1, 611/2.
2. Sign in as **`sradmin`** → **Revenue record**: Revenue mutation no. `Intiqal 1207/2026`, Mutation date `10/12/2026`, Revenue office `Mukhtiarkar Daharki` → Save → **→ Revenue Verified**.
3. Sign in as **`legal`** → **→ Legal Cleared**.
4. Sign in as **`mland`** → **→ Approved & Applied**.

**Expected:** case owners now **Karim Bux Unar 60%, Ali Sher Kalhoro 40%**; voucher B shows **On hold** ("Ownership changed by mutation …"); mutation Details → *Payments re-pointed*.

5. Sign in as **`finance`** → voucher B → **Cancel voucher**, reason `Land sold by mutation; raised again for the buyer.`
6. Sign in as **`lofield`** → **+ Request Payment**: payee **Ali Sher Kalhoro**, `Crop Compensation`, `One-time`, `Direct Credit (IBFT)`, `Private`, from `01/12/2026`, gross `300000`, remarks `Cotton damage on 611/2, now payable to the buyer (mutation).` **Expected:** e.g. VCH-2026-00037, Filer 10%, net **270,000**. A voucher for Rahim is now refused ("the payee is not an owner on case …").

---

## 15. Encroachment: `lofield`

**Encroachments → + Report Encroachment**

| Field | Value |
|---|---|
| Project | `DHRK-410` |
| On survey or corridor | 611/2 |
| Category | `Boundary encroachment` |
| Risk | `Medium` |
| Detected on | `12/12/2026` |
| Encroacher | `Neighbouring cultivator (name not known)` |
| Area affected | `0.5` |
| Latitude / Longitude | `28.0206` / `69.6381` |
| Description | `Fence moved about 20 m into khasra 611/2 on the south-east side.` |
| Impact | `Access road alignment blocked.` |
| Corrective action | `Joint demarcation with the Tapedar; restore the fence.` |

**Expected:** e.g. **ENC-2026-0004**, *Reported*.

**Approval chain** (sign in as each account → Encroachments → click the row → **→** button → note → **Move to …**). `lofield` reported it, so he cannot take the next step.

| Sign in as | Button | Note |
|---|---|---|
| `sradmin` | → Assessed | `Site visited with the Tapedar; 0.5 acre fenced in.` |
| `dmfield` | → Action Approved | `Approved: joint demarcation and fence restoration.` |
| `legal` | → Legal Follow-up | `Notice served on the occupant; no suit needed for now.` |
| `mland` | → Resolved | `Fence restored on 20 Dec 2026.` |

Court action, if needed, is a separate Legal case (section 13): no field links it to this encroachment, so quote the ENC code in its *Remarks*.

---

## 16. Grievance: `lofield`

**Grievances & IIR → + Add Grievance**

| Field | Value |
|---|---|
| Province | Sindh |
| Type | `Landowner Complaint` |
| Complainant | `Rahim Bux Unar` |
| Complainant CNIC | `45105-3100212-3` |
| Mobile | `0302-5582233` |
| Project | `DHRK-410` |
| Category | `Payment delay` |
| Severity | `Medium` |
| Channel | `In person` |
| Due date | `26/12/2026` |
| Description | `Crop compensation for 611/2 not received; asks when the cheque will be issued.` |

**Expected:** e.g. **GRV-2026-0004**, *Registered*.

**Approval chain** (sign in as each account → Grievances & IIR → click the row → **→** button → note → **Move to …**):

| Sign in as | Button | Note |
|---|---|---|
| `dmfield` | → Assigned | `Assigned to the negotiation team.` |
| `nego` | → In Progress | `Called the complainant; cheque date confirmed.` |

**Stop here in the demo.** *Resolved* needs a resolution text that this screen cannot enter yet, so **→ Resolved** is refused (see 08 §16). The full chain is Resolved (`sradmin`) → Closed (`mland`).

---

## 17. Document upload: `lofield`

**Documents → + Upload Document**: Record type `Compensation case`, Record the CC from section 7, Category `Title document`, File: **any small PDF** (e.g. a scanned Fard, under 50 MB). **Expected:** e.g. **DOC-00006**, with its SHA-256 shown in the row details.

---

## 18. Import

Skip in the demo (needs a prepared spreadsheet in the import template).

---

## 19. Alerts / Calendar

- **Calendar**: the hearing of `C.S. 377/2026` on 22/12/2026 is listed (click it for details).
- **Approvals & Alerts**: each approver sees the item waiting on them (section 5 and 7 steps); `explorer` sees "Land ready" for the request after section 6.

---

## 20. Reports and audit

| Sign in as | Where | Type / filter | Expected |
|---|---|---|---|
| `lofield` | Header search | `45105-3100213-1` → Enter | Ali Sher Kalhoro |
| `lofield` | Landowners → Karim Bux Unar → **Statement** | — | Owed, paid (720,000 net + 80,000 WHT), balance |
| `mland` | Records & Reports → **Landowner Register** | Province Sindh, District Ghotki, Taluka Daharki, Deh Bago Daharki | The 4 owners and their khasras |
| `audit` | **Audit Trail** | Search the CC code, then MUT… and LIT… | Every change; click a row for old and new values |

---

## 21. Settings: a land unit size: `admin`

**Settings → Land units** → tab **SND** → on **Jireb** click the size button:

| Field | Value |
|---|---|
| Jireb per acre | `2` |
| Confirmed by the Land Department | ticked |
| Source / note | `Confirmed by the Land Department, Sindh (demo)` |

→ **Save**. **Expected:** "Jireb in SND: 2 per acre from today." (Parcels already recorded keep their size.)

---

**If something is refused:** "Missing documents" → open the case → Document checklist → tick all. "Select the holdings to transfer." → shares (section 4) were not saved before the mutation. "the … step is for: …" → wrong account; use the one in the table. "segregation of duties" → one person cannot take two steps on the same record.
