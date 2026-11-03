# LMS Short Demo (30 minutes), step by step

**Sign-in:** the sign-in page lists every demo account with its password. Click the account, or type the username and password.
**Province:** after sign-in, choose **Sindh** on the *Select province* screen. To change it later, click the province chip in the header.
**One account at a time:** use a separate incognito window per account, or **Sign out** (top-right name → Sign out) before the next one.
**Comments:** every approval asks for a comment or note. Type the text given, then press the button.
**Details of any record:** click anywhere on a row (not on its buttons) to open the record's details; **Close** or Esc shuts it. The buttons on the row still do their own job.
**Workflow buttons:** an account sees the **→ next step** button only when its position does that step. Everyone else sees **"Waiting on <position>"** on the row, so a wrong button never shows.

---

## Part 0. Prepare the data (do this before the client joins, ~25 min)

The demo uses this data. Enter it once, in this order.

### 0.1 Project: sign in as `lofield`

1. Left menu → **Projects / Well Locations** → **+ Add Project**.
2. Fill in:
   - Project code `DHRK-301`
   - Province `Sindh`
   - Name `Daharki Well-03 Exploratory Location`
   - Type `Well Location`
   - Block / concession `Daharki D&PL`
   - District `Ghotki`
   - Required area `20`
3. Click **Save**. The list shows **DHRK-301**.

### 0.2 Three landowners: still `lofield`

1. Left menu → **Landowners** → **+ Add Landowner**.
2. Fill in owner 1, then **Save**. Repeat for owners 2 and 3.

| Field | Owner 1 | Owner 2 | Owner 3 (buyer later) |
|---|---|---|---|
| Province | Sindh | Sindh | Sindh |
| CNIC (type the digits) | `4510420000113` | `4510420000121` | `4510420000139` |
| Full name | `Ghulam Rasool Mahar` | `Nazir Ahmed Mahar` | `Abdul Ghaffar Chachar` |
| Father / husband | `Muhammad Bux Mahar` | `Muhammad Bux Mahar` | `Haji Allah Bachayo Chachar` |
| Owner type | O — Owner | O — Owner | O — Owner |
| Tax status | `Filer` | `Non-Filer` | `Filer` |

Result: **SND-000047**, **SND-000048**, **SND-000049**.

### 0.3 Two khasras: still `lofield`

1. Left menu → **Survey / Khasra Register** → **+ Add Survey**.
2. Fill in khasra 1, **Save**. Repeat for khasra 2.

| Field | Khasra 1 | Khasra 2 |
|---|---|---|
| Province | Sindh | Sindh |
| Revenue location | Ghotki → Daharki → Jarwar | same |
| Project | DHRK-301 | DHRK-301 |
| Survey / khasra no. | `451/2` | `452/1` |
| Block no. | `9` | `9` |
| Land class | Private | Private |
| Recorded area + unit | `12` + **Acre** | `320` + **Ghunta** |
| Latitude / Longitude | `28.0710` / `69.7050` | `28.0703` / `69.7062` |

Result: **AREA-000034** (12 ac) and **AREA-000035** (8 ac).

3. **Do this before any mutation (Part 5).** On the **AREA-000034** row click **Shares** → in *Landowner to add* pick Ghulam Rasool Mahar → **+** → share `60` → pick Nazir Ahmed Mahar → **+** → share `40` → **Save shares**.
4. On **AREA-000035** do the same with `50` and `50`.

### 0.4 Compensation case: still `lofield`

1. Left menu → **Compensation Cases** → **+ Add Compensation Case**.
2. Header: Project `DHRK-301`, Land used for `Well Location`, Lease rate `60000`, Lease term `36`.
3. **Landowners → + Add line** twice: Ghulam Rasool Mahar `60` `O`; Nazir Ahmed Mahar `40` `O`.
4. **Lease lines → + Add line**: survey AREA-000034, owners' share `100`, area `12`.
5. **Crop → + Add line**: AREA-000035, `Wheat`, rate `45000`, damaged `5`.
6. **Trees → + Add line**: AREA-000035, `Kikar`, `Medium`, rate `8000`, count `6`.
7. **Other → + Add line**: AREA-000034, `Disturbance allowance`, `25000`.
8. **Documents seen**: tick all six. *(Required: without them **→ Field Approved** is refused with "Missing documents: …". If you forgot, open the case and tick them under **Document checklist**.)*
9. Click **Create case**. Result: **CC-2026-0012**, total **Rs 2,458,000**, stage *Prepared*.

### 0.5 Approve the case (one account per step)

On **Compensation Cases**, click the CC-2026-0012 row to open it and press the **→** button. Type the note, confirm. Only the account in the table below sees that button; the others see "Waiting on …".

| Step | Sign in as | Button |
|---|---|---|
| 1 | `nego` | → Checked |
| 2 | `legal` | → Reviewed |
| 3 | `sradmin` | → Verified |
| 4 | `dmfield` | → Field Approved |
| 5 | `mland` | → HO Approved |

### 0.6 Two vouchers: sign in as `lofield`

1. Left menu → **Payments & Cheques** → **+ Request Payment**.
2. Voucher A: Project DHRK-301, Case CC-2026-0012, Payee **Ghulam Rasool Mahar**, Category `Lease Rent`, Pay type `Advance Lease (multi-year)`, Mode `Cross Cheque`, Land class `Private`, Period from `01/11/2026`, Gross `1000000` → **Request**. Result **VCH-2026-00034**.
3. **+ Request Payment** again. Voucher B: same project and case, Payee **Nazir Ahmed Mahar**, Category `Crop Compensation`, Pay type `One-time`, Mode `Direct Credit (IBFT)`, Land class `Private`, Period from `01/11/2026`, Gross `500000` → **Request**. Result **VCH-2026-00035**. **Do not release this one.**
4. Sign in as `finance` → **Payments & Cheques** → VCH-2026-00034 → **Verify** → note `Checked` → **Verify**.
5. Sign in as `mland` → VCH-2026-00034 → **Release cheque** → cheque date today → **Confirm release**. Result **CHQ-…**.

**Ready.** Optional: take a backup now so the demo can be repeated (`pg_dump -Fc -d lms_dev -f backups/before_client_demo.dump`).

---

## Part 1. All tabs, then fewer tabs (3 min)

1. Sign in as **`director`**. Choose *Sindh*.
2. Point at the left menu: **33 tabs**, every section.
3. Click **Compensation Cases**: the **+ Add Compensation Case** button is there. Say: "This account sees everything and can act everywhere: add, edit, and take any approval step."
4. Click the **CC-2026-0012** row: the case opens with its valuation, owners and checklist. Close it.
5. Click **Users & Roles** → click any user's row: name, roles, provinces, positions and last sign-in in one view. Close it.
6. Say the two limits that hold even for the director: "He can raise or verify a voucher but not release it; release is Manager Land's. And on one record he can take only one step; the next step needs another person."
7. Sign out. Sign in as **`explorer`**: the menu has only **9 tabs** (map, projects, khasras, land requests, alerts).
8. Sign out. Sign in as **`viewer`**: **7 tabs**, read-only; on **Landowners** the CNICs are masked.

## Part 2. Exploration request and three approvals (8 min)

### 2.1 Raise the request: `explorer`

1. Sign in as **`explorer`**. The **GIS Land Map** opens.
2. Click **✎ Draw land request**.
3. Click **Paste lat/long**, paste these four lines, click **Use these corners**:
   ```
   28.07200, 69.70400
   28.07200, 69.70700
   28.06950, 69.70700
   28.06950, 69.70400
   ```
4. The side panel shows **20.19 acres** and **2 parcels inside** (AREA-000034, AREA-000035).
5. Click **Continue: request details**. Fill in:
   - Project `DHRK-301`
   - Purpose `Well Location`
   - Priority `Urgent`
   - Required by `15/01/2027`
   - Justification `Exploratory well Daharki Well-03: pad, rig camp and access road.`
6. Click **Submit to Director Operations**. Result: **REQ-2026-0004**, polygon turns orange.

### 2.2 First approval: `dirops`

1. Sign in as **`dirops`**.
2. Left menu → **Approvals & Alerts** → tab **Waiting on you**: REQ-2026-0004 is listed. Say: "Each approver gets the request in his queue."
3. Left menu → **Land Requests** → on REQ-2026-0004 click **Review**.
4. Choose **Approve**, comment `Operational need confirmed.` → **Approve**.

### 2.3 Return: `regmgr`

1. Sign in as **`regmgr`** → **Land Requests** → **Review**.
2. Choose **Return**, comment `Move the north boundary 45 m south.` → **Return for revision**.

### 2.4 Redraw: `explorer`

1. Sign in as **`explorer`** → **Approvals & Alerts** → tab **Your land requests**: "Returned" with the comment.
2. Left menu → **Land Requests** → on REQ-2026-0004 click **Edit on map**.
3. Click **Clear** → **Paste lat/long** → paste, then **Use these corners**:
   ```
   28.07160, 69.70400
   28.07160, 69.70680
   28.06950, 69.70680
   28.06950, 69.70400
   ```
4. Panel shows **15.83 acres**. Click **Continue: review and save**.
5. What changed: `North boundary moved 45 m south.` → **Save and send to Director Operations**.

### 2.5 Final approvals

For each row: sign in → **Land Requests** → **Review** → **Approve** → comment → **Approve**.

| Sign in as | Comment |
|---|---|
| `dirops` | `Revised boundary acceptable.` |
| `regmgr` | `Region supports it.` |
| `landaffairs` | `Private land, owners identified. Approved.` |

Result: stage **Approved**; **Details → Polygon versions** shows v2 and v1.

## Part 3. Acquisition, progress, land ready (6 min)

### 3.1 Take it up: `lofield`

1. Sign in as **`lofield`** → **Land Requests** → on REQ-2026-0004 click **Start land work**.
2. Land work `Acquisition`, keep the tick on *Mark the recorded parcels … Under Acquisition*, comment `Negotiation starts 10 Nov.` → **Take it up**.
3. On the same row click **Create acquisition**. The form is already filled (project, area, khasras).
4. Mode `Private Lease`, Negotiated rate `60000` → **Save**. Result **ACQ-2026-0004**.
5. Left menu → **Acquisition & Title** → on ACQ-2026-0004 click **Title** → tick all six checks → close.

### 3.2 Show the requester's view: `explorer`

1. Sign in as **`explorer`** → **Land Requests** → on REQ-2026-0004 click **Details**.
2. Point at **Land work progress**: the strip is at *Identification*. Say: "The planner cannot open acquisitions, yet sees how far it has got." Keep this window open.

### 3.3 Move the acquisition: one account per stage

For each row: sign in → **Acquisition & Title** → on ACQ-2026-0004 click the **→** button → note → confirm. After each, refresh the explorer's Details to show the strip moving.

**Show once:** after `nego` moves it to *Negotiation*, the same row shows **"Waiting on DM / Team Lead (Field)"** for `nego` instead of a button. Say: "Each person only gets the button for his own step."

| Sign in as | Button |
|---|---|
| `nego` | → Negotiation |
| `dmfield` | → Approval |
| `mland` | → Acquisition / Lease |
| `sradmin` | → Handover |

### 3.4 Show the result

1. In the explorer window: REQ-2026-0004 is **Completed**, with "Land ready: Acquisition ACQ-2026-0004 handed over".
2. **Approvals & Alerts → Your land requests**: **"Land ready · REQ-2026-0004"**.
3. **Survey / Khasra Register**: AREA-000034 and AREA-000035 are now **Leased**.

## Part 4. Court stay stops payment (5 min)

1. Sign in as **`lofield`** → **Payments & Cheques** → **+ Request Payment**: case CC-2026-0012, payee Ghulam Rasool Mahar, `Lease Rent`, `Yearly Lease`, `Cross Cheque`, `Private`, period from `01/11/2027` to `31/10/2028`, gross `200000` → **Request**. Result **VCH-2026-00036**.
2. Sign in as **`legal`** → **Legal & Litigation** → **+ Add Legal Case**. Fill in:
   - Province `Sindh`, Court case no. `C.S. 214/2026`, Court `Senior Civil Judge, Daharki`
   - Case type `Civil suit (title)`, Company is `Proforma Party`, Status `Pending`
   - Parties `Muhammad Yaqoob Mahar v. Ghulam Rasool Mahar & Mari Energies Ltd`
   - Filed on `04/11/2026`
   - **Parcels concerned**: search `451` → pick AREA-000034
   - **Landowners concerned**: search `Ghulam` → pick Ghulam Rasool Mahar
   - Tick **Stay order in force**
   → **Save**. Result **LIT-0006**, marked *Stay order*.
3. Sign in as **`finance`** → **Payments & Cheques** → VCH-2026-00036 shows **On hold** → click **Verify** → note → confirm.
   Result: **refused**, "Payment is on hold: stay order in C.S. 214/2026". Open the **Holds** tab to show the two holds.
4. Sign in as **`mland`** → **Legal & Litigation** → on LIT-0006 click **Update**:
   - Status `Decided — In Favour`
   - Untick **Stay order in force**
   - Court order lifting the stay: `Order of 20 Nov 2026: suit dismissed, stay vacated.`
   → **Save**.
5. Sign in as **`finance`** → VCH-2026-00036 → **Verify** → now it works.

## Part 5. Land sold, payment goes to the new owner (6 min)

> **Check first:** the Part 0.3 **Shares** (Nazir 40% on AREA-000034) must be saved **before** the mutation is created. The mutation takes the khasras from the transferor's recorded shares at the moment it is saved. Without them, the last step is refused with "Select the holdings to transfer."

1. Sign in as **`lofield`** → **Mutation & Succession** → **+ Add Mutation**:
   - Type `Sale / Transfer`
   - Transferor: search `Nazir` → Nazir Ahmed Mahar
   - **+ Add transferee**: Abdul Ghaffar Chachar, relation `Buyer`, share `100`
   → **Save**. Result **MUT-0007**, *Initiated*.
2. Sign in as **`sradmin`** → **Mutation & Succession** → on MUT-0007 click **Revenue record**: mutation no. `Intiqal 881/2026`, date `10/11/2026`, office `Mukhtiarkar Daharki` → **Save**. Then click **→ Revenue Verified**.
3. Sign in as **`legal`** → MUT-0007 → **→ Legal Cleared**.
4. Sign in as **`mland`** → MUT-0007 → **→ Approved & Applied**.
5. Still `mland`: click the MUT-0007 row (or **Details**) → **Payments re-pointed**: "CC-2026-0012 · Nazir Ahmed Mahar → Abdul Ghaffar Chachar · 40%".
6. Open **Compensation Cases** → CC-2026-0012: owners are now Ghulam 60% and **Abdul Ghaffar 40%**.
7. Sign in as **`finance`** → **Payments & Cheques** → VCH-2026-00035 (Nazir) shows **On hold** (ownership changed).
8. Click **Cancel voucher** → reason `Land sold; raised again for the buyer.` → **Cancel voucher**.
9. Sign in as **`lofield`** → **+ Request Payment**: case CC-2026-0012, payee **Abdul Ghaffar Chachar**, `Crop Compensation`, `One-time`, `Direct Credit (IBFT)`, `Private`, from `01/11/2026`, gross `500000` → **Request**. Result **VCH-2026-00037**, net Rs 450,000.

## Part 6. CNIC search and audit (2 min)

1. Sign in as **`lofield`**. In the header search box type `45104-2000013-9` → Enter. Result: **SND-000049 Abdul Ghaffar Chachar**.
2. Sign in as **`audit`** → **Audit Trail** → search `MUT-0007`: every change, who made it and when. Click a row to see the old and new values of that change.

---

**If something is refused:**

| Message | Cause | Fix |
|---|---|---|
| Missing documents: … | Case documents not ticked | Open the case → **Document checklist** → tick all six → retry |
| Select the holdings to transfer. | The mutation was saved before Nazir's **Shares** were recorded | Record the shares (0.3 step 3), set the old mutation to **Cancelled**, create the mutation again |
| the … step is for: … | Wrong account for this step | Sign in as the account in the table |
| segregation of duties … | Same person on two steps of one record | Use the next account in the table |

**Repeat the demo:** restore the backup from Part 0 and restart the app. If a code number differs (e.g. REQ-2026-0005), carry on: only the number changes.
