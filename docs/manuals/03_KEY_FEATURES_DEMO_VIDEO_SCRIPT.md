# Key Features Demo Video Script

**Deliverable 3 of 5.** A recording script for the key-features demo of the Mari Energies Land Management System.

- **Follows:** [Key Features User Manual](02_KEY_FEATURES_USER_MANUAL.md), chapters 2–11, in the same order.
- **Values to type:** [Demo Recording Data](05_DEMO_RECORDING_DATA_AND_SCENARIOS.md). The section number in brackets (e.g. *Data §3c*) points to the exact table.
- **Target length:** 18–22 minutes. Scenes marked *(optional)* can be cut for a 12-minute version.

**Before you press record:** do the checklist in *Data §0*:
- rebuild and restart the server
- demo sign-in list visible
- map tiles loading
- one browser window per user, or sign out between users

**Recording tips:**
- Pause recording while you switch users, and cut the sign-in screens in editing. The script marks each switch with 🔁.
- Move the mouse slowly to what you are describing, and hover for a second before clicking.
- Read the voiceover at a calm pace.
- **Expected Result** is what you should see before moving on. If it differs, stop and re-take that scene.

---

## Scene 0: Opening (≈1 min)

**On-Screen Actions**
1. Start on the sign-in page (`http://localhost:3040/login`), showing the Mari Energies logo.
2. Slowly scroll the demo account list once (or show a title card with the role list from Manual §1).

**Voiceover / What to Say**
> "This is the Land Management System built for Mari Energies. It manages land work in Sindh, Balochistan, Punjab and Khyber Pakhtunkhwa: from the moment exploration needs a piece of land, through approvals, owner identification and compensation, to the cheque in the landowner's hand.
>
> Every person signs in with their own role. A role decides what they can see, which approval step they may take, and in which provinces. Today we'll follow one real-world case from start to finish: a new exploratory well, Daharki Well-03, near the village of Jarwar in District Ghotki."

**Expected Result:** the sign-in page is visible, and the narration sets the scene.

---

## Scene 1: Projects / Well Locations (≈1.5 min) · *Manual §2 · Data §2*

🔁 **Sign in as `lofield`** (Sanaullah Khoso, Land Officer, Sindh).

**On-Screen Actions**
1. Point to the header: user name, role badge, the province chip "Sindh".
2. Sidebar: **Master Data → Projects / Well Locations**.
3. Click **+ Add Project** and fill in *Data §2*: `DHRK-301`, Sindh, *Daharki Well-03 Exploratory Location*, Well Location, Daharki D&PL, Ghotki, 20, and the description.
4. Click **Save**.
5. *(Optional)* Open **Project Dashboard** and select DHRK-301.

**Voiceover / What to Say**
> "Our Land Officer, Sanaullah, works only in Sindh. The system shows him only Sindh records.
>
> Every piece of land starts with a reason: a project. Here he registers the new well as project DHRK-301: its type, block, district and the area we expect to need. From now on every parcel, request, case and payment is filed under this code, so management can see the full land cost of each well."

**Expected Result:**
- DHRK-301 appears in the list as **Active**.
- *(Optional)* The Project Dashboard opens for DHRK-301, still empty.

---

## Scene 2: Landowners and the Khasra Register (≈3 min) · *Manual §3 · Data §3*

**On-Screen Actions**
1. **Master Data → Landowners → + Add Landowner**. Enter *Data §3a* (Ghulam Rasool Mahar).
   - While typing the CNIC digits, pause to show the dashes appear by themselves.
   - Click **Save**.
2. Add the second owner, *Data §3b* (Nazir Ahmed Mahar, **Non-Filer**). Click **Save**.
3. **Master Data → Survey / Khasra Register → + Add Survey**. Enter *Data §3c* (451/2, 12 **Acre**, lat/long). Click **Save**.
4. Add *Data §3d* (452/1, **64 Kanal**). Point at the area column after saving: **8.00 acres**.
5. On AREA-000034, click **Shares**:
   - add both owners, 60 and 40
   - show that **Save shares** stays disabled at 60 + 30
   - fix it to 40, then **Save shares**
6. Repeat for AREA-000035 with 50 / 50 (you can cut this in editing).

**Voiceover / What to Say**
> "Next, the people and the parcels. A landowner is identified by CNIC, which is the master key: one person, one record across the whole company, so we never pay a duplicate. Tax status matters too. Ghulam Rasool is a filer; his brother Nazir is not, and you'll see later that the system deducts withholding tax accordingly, without anyone typing a rate.
>
> Parcels are recorded the way the revenue record writes them: here a khasra in Deh Jarwar, Taluka Daharki. Notice that the second khasra is recorded in Kanal, sixty-four Kanal, and the system converts it to eight acres while keeping the original unit. Each khasra also gets its GPS position, which puts it on the map.
>
> Finally, ownership shares. The system will only save shares that add up to exactly one hundred percent. Once registered, shares can only change through a formal mutation, for example inheritance, and never by simply overwriting them."

**Expected Result:**
- SND-000047 and SND-000048 are created.
- AREA-000034 (12.00 ac) and AREA-000035 (8.00 ac) are created, both **Proposed**.
- The shares column shows **100.0% · 2 owner(s)** for each.

---

## Scene 3: GIS Land Map (≈1 min) · *Manual §4 · Data §4*

**On-Screen Actions**
1. **Overview → GIS Land Map**.
2. Click **⤢ Show all**, then zoom to Jarwar (north-east of Daharki). Point at the two new grey markers.
3. Click one marker; the side panel shows code, status, area and location.
4. Point at the legend: Proposed, Under Acquisition, Acquired, Leased, Disputed, and the land-request colours.

**Voiceover / What to Say**
> "Everything with coordinates appears on the map. Each dot is a khasra, coloured by its land status: grey is proposed, amber under acquisition, green acquired, blue leased, red disputed. Our two new parcels are here, near Jarwar. Operations, the land team and management all look at the same picture."

**Expected Result:** the two grey markers are visible, and the side panel shows AREA-000034's details.

---

## Scene 4: Explorer draws the land requirement (≈2.5 min) · *Manual §5 · Data §5*

🔁 **Sign in as `explorer`** (Usman Ghani, Exploration Planner).

**On-Screen Actions**
1. Point out that the planner lands **directly on the GIS map**, and that the menu has no Landowners, Payments or Cases.
2. Click **✎ Draw land request**. Point at the yellow "Drawing mode" banner.
3. *(Optional)* Click three or four points on the map to show live drawing. Then click **Clear**.
4. Click **Paste lat/long**, paste the four corners from *Data §5*, then **Use these corners**.
5. Point at the panel, in turn:
   - the corner table (lat / long)
   - the **Area 20.19 acres · 8.17 ha**
   - the **Centre**
   - **Parcels inside: 2: AREA-000034, AREA-000035**
6. Drag one corner on the map slightly, show the area change, then **Undo** (or re-paste).
7. Click **Continue: request details** and fill in *Data §5*: project DHRK-301, Well Location, **Urgent**, 2027-01-15, Jarwar (pre-filled), Daharki D&PL, and the justification.
8. Click **Submit to Director Operations**.

**Voiceover / What to Say**
> "Now the most important new capability. Exploration no longer describes land in words. The Exploration Planner marks it on the map. This role sees projects, parcels and land status, but no owner names, CNICs or payments. That's least privilege by design.
>
> He can click the corners on the map, drag them, or, as most field teams do, paste the coordinates straight from a GPS. The system instantly measures the area, twenty point one nine acres, shows the centre point, and finds the recorded khasras inside: our two Mahar parcels. If the shape touched disputed land, land we already lease, government land, or another open request, a warning would appear right here before anything is submitted.
>
> He adds the purpose, the priority and the date the land is needed, and why, and sends it to the Director Operations. The server measures the shape again itself; it never trusts figures from the browser."

**Expected Result:**
- "Created **REQ-2026-0004** and sent it to Director Operations."
- The polygon is now **orange** on the map.

---

## Scene 5: Three-tier approval, with one return (≈3.5 min) · *Manual §6 · Data §6*

### 5a. Director Operations approves

🔁 **Sign in as `dirops`** (Javed Akhtar, Director Operations).

**On-Screen Actions**
1. **Land Operations → Land Requests**. Point at the KPI "Pending Director Ops: 1" and the workflow column (step 2 highlighted).
2. Click **Details**. Scroll through:
   - stage
   - requested by
   - drawn area
   - centre lat/long
   - warnings (if any)
   - decisions (empty)
   - polygon versions (v1)
   - **Show the 4 corners**
   - parcels inside
3. Close it, and click **Map**: the GIS map frames the polygon. Click it, then **Open request**.
4. Back on Land Requests, click **Review**, choose **Approve**, enter the comment from *Data §6, 5.1*, then click **Approve**.

**Voiceover / What to Say**
> "The request now waits for the Director Operations, the first of three independent approvals. He sees exactly what's asked: the polygon, every corner, the area, the parcels it covers and any warnings. And he can jump straight to it on the map. His question is simple: is the operational need real? He approves, and his comment is recorded permanently."

**Expected Result:** stage **Under Review - Regional**.

### 5b. Regional Manager returns it

🔁 **Sign in as `regmgr`** (Sadia Memon, Regional Manager, Sindh).

**On-Screen Actions**
1. Land Requests → **Review** → **Return**. Enter the comment from *Data §6, 5.2*, then **Return for revision**.

**Voiceover / What to Say**
> "The Regional Manager looks at it from the region's side, and asks for a change: move the north boundary away from the link road. Instead of a phone call and a new paper form, she returns it with a comment."

**Expected Result:** stage **Returned**, and the polygon turns **yellow**.

### 5c. The planner redraws (version 2)

🔁 **Sign in as `explorer`.**

**On-Screen Actions**
1. Land Requests → REQ-2026-0004 shows **Returned**. Click **Edit on map**.
2. Click **Clear**, then **Paste lat/long** with the v2 corners (*Data §6, 5.3*). The area becomes **15.83 acres**.
3. **Continue: review and save**. Type "What changed", then **Save and send to Director Operations**.
4. Open **Details → Polygon versions**: **v2 (current)** and **v1**.

**Voiceover / What to Say**
> "The planner adjusts the boundary on the map. Now fifteen point eight three acres, still covering both parcels. He explains what changed and sends it again. The first version is never lost; reviewers can compare both. And because the land changed, every approver decides again from the start."

**Expected Result:** stage **Submitted**, with two polygon versions listed.

### 5d. Final approvals

**On-Screen Actions**
1. 🔁 `dirops`: **Review → Approve** (*5.4*).
2. 🔁 `regmgr`: **Review → Approve** (*5.5*).
3. 🔁 `landaffairs`: **Review → Approve** (*5.6*). Point at the workflow column, which now has "5. Land work" highlighted.
4. *(Optional)* Show that `regmgr` had no **Review** button while the request was with Director Operations.

**Voiceover / What to Say**
> "Director Operations confirms the revised boundary, the Regional Manager agrees, and finally the DM Land Affairs answers the last question: can this land actually be obtained? Private land, two known owners, no litigation. Approved.
>
> Three rules hold this together, and they're enforced in the database itself, not just on the screen. Only the holder of each position can decide that step. The person who asked can never approve. And no one can decide two steps of the same request."

**Expected Result:** stage **Approved**, and the polygon is **green** on the map.

---

## Scene 6: Hand-over and Acquisition (≈2 min) · *Manual §7 · Data §7*

🔁 **Sign in as `lofield`.**

**On-Screen Actions**
1. Land Requests → REQ-2026-0004 → **Start land work**.
2. Choose Land work **Acquisition**, keep "Mark the recorded parcels…" ticked, type the comment, then **Take it up**.
3. Read the green message aloud: "2 parcel(s) marked Under Acquisition: AREA-000034, AREA-000035".
4. *(Optional)* Open the Survey register or the GIS map to show both khasras now **Under Acquisition** (amber).
5. Click **Create acquisition**. Point at the pre-filled fields:
   - project
   - **15.83** acres
   - target date
   - both khasra chips
   - remarks "From land request REQ-2026-0004"
6. Choose Mode **Private Lease**, rate **60000**, then **Save**.
7. *(Optional)* On ACQ-2026-0004, click **Title** and tick the first three checks.

**Voiceover / What to Say**
> "An approved request comes back to the land team. The Land Officer takes it up as an acquisition, and with one tick the parcels inside the approved boundary are marked 'under acquisition' across the whole system.
>
> Then 'Create acquisition' opens the acquisition already filled in: the project, the approved area, the date and the exact khasras. Nothing is retyped. The two records are linked both ways, so anyone can trace this acquisition back to the request and the people who approved it. The title checklist records who verified the revenue record, the mutation and every owner's CNIC."

**Expected Result:**
- REQ-2026-0004 is **Handed over** (blue on the map).
- **ACQ-2026-0004** is created at **Identification**.

---

## Scene 7: Compensation Case and its approval chain (≈3 min) · *Manual §8 · Data §8*

**On-Screen Actions** (as `lofield`)
1. **Land Operations → Compensation Cases → + Add Compensation Case**.
2. Fill in *Data §8a*:
   - header (DHRK-301, Well Location, 60000, 36)
   - owners (60 / 40)
   - lease line (AREA-000034, 100, 12)
   - crop (AREA-000035, Wheat, 45000, 5)
   - tree (Kikar, Medium, 8000, 6)
   - other (Disturbance allowance, 25000)
   - tick all six documents
3. Click **Create case**. In the detail, point at the computed **Total Rs 2,458,000** and the absence of an approve button.
4. *(Optional)* Click **Print award sheet**.

**Voiceover / What to Say**
> "With the owners and parcels known, the Land Officer prepares the compensation case: a three-year surface lease on twelve acres, five acres of standing wheat, six Kikar trees and a disturbance allowance. He enters rates and quantities; the database calculates the award itself, two million four hundred fifty-eight thousand rupees. And the person who prepares a case can never approve it, so he has no approve button."

**Expected Result:** **CC-2026-0012**, stage **Prepared**.

**On-Screen Actions: the chain** (use *Data §8b*; cut each sign-in in editing)
1. 🔁 `nego` → open CC-2026-0012 → **→ Checked** (note).
2. 🔁 `legal` → **→ Reviewed**.
3. 🔁 `sradmin` → **→ Verified**.
4. 🔁 `dmfield` → **→ Field Approved**.
5. 🔁 `mland` → **→ HO Approved**. Point at the lock: the lines can no longer be edited.

**Voiceover / What to Say**
> "Now five different people approve it, each in their own capacity. Negotiation confirms the rates, Legal reviews the title, the Senior Administrator verifies the field records, the DM approves at field level, and the Manager Land approves at head office. One person, one step. And the field and head-office approvals are refused automatically if the case has no owners or a required document is missing. Once approved at head office, the award is locked."

**Expected Result:** stage **HO Approved**, with the award locked.

---

## Scene 8: Payment, withholding tax, cheque and receipt (≈3 min) · *Manual §9 · Data §9*

### 8a. Request (`lofield`)

🔁 **Sign in as `lofield`.**

**On-Screen Actions**
1. **Finance → Payments & Cheques → + Request Payment**.
2. Fill in *Data §9a*:
   - project DHRK-301
   - case CC-2026-0012 (point at "Rs 2,458,000 outstanding")
   - payee Ghulam Rasool Mahar (Filer)
   - Lease Rent, Advance Lease (multi-year), Cross Cheque, Private
   - 2026-11-01 → 2029-10-31
   - gross **1000000**
3. Click **Request**. Point at the voucher row: **WHT 10%**, net **900,000**.
4. *(Optional)* Over-award check: try gross **2500000** to show the refusal message, then cancel.

**Voiceover / What to Say**
> "Payment starts with a voucher against the approved case. The payee has to be one of the case's owners. You can't type in any name, so the right tax and any holds always apply. Ghulam Rasool is a filer, so the system deducts ten percent withholding tax by itself; for his non-filer brother it would be twenty. And the system will never let vouchers exceed the approved award. Watch: asking for more than the award is simply refused."

**Expected Result:** **VCH-2026-00034**, stage **Requested**, net Rs 900,000.

### 8b. Verify (`finance`) and release (`mland`)

**On-Screen Actions**
1. 🔁 `finance` → Vouchers → **Verify** (note) → stage **Verified**.
2. 🔁 `mland` → **Release cheque**: cheque date and note. Re-enter the password if asked.
3. Point at the cheque number and the net amount.

**Voiceover / What to Say**
> "Three different people touch every payment. Finance verifies it, checking the budget, any court stay or hold, and that the owner is alive. Then the Manager Land releases the cheque, after confirming his identity again because this is a sensitive action. The cheque is for the net amount, and the posting is queued for SAP."

**Expected Result:** stage **Released**, cheque **CHQ-25186412**, **Rs 900,000**.

### 8c. Receipt (`finance`)

**On-Screen Actions**
1. 🔁 `finance` → **Cheques** tab → **Record receipt**. Enter *Data §9d* and save.
2. In the Receipts table, click **Print receipt**. Scroll the printed page:
   - parcel and location
   - heads
   - gross / less WHT / total
   - amount in words
   - settlement table
   - declaration and signatures

**Voiceover / What to Say**
> "When the owner collects the cheque, Finance records who received it, and prints a formal receipt of payment. It names the parcel and the revenue location, shows the gross amount, the tax withheld and the net, the amount in words, what this owner is owed in total and what remains, and carries the declaration and signatures."

**Expected Result:** a printable *Receipt of Payment* for Ghulam Rasool Mahar, Rs 900,000 net.

*(Optional, Data §9e)* Liabilities → **Allocate voucher** to CC-2026-0012 (900000). The case shows **Part paid**.

---

## Scene 9: Statements, Landowner Register and Dashboard (≈2 min) · *Manual §10 · Data §10*

**On-Screen Actions**
1. 🔁 `mland` → **Records & Reports → Landowner Register**:
   - Province Sindh → District Ghotki → Taluka Daharki → Deh Jarwar
   - Area unit **All in Kanal**
   - Show **One row per owner**
   - The report refreshes as you choose; point at 12 ac = **96 Kanal**
2. Click the **PDF** export button (or **Excel** / **CSV**).
3. **Overview → Executive Dashboard**: province chart, approved vs paid, approvals waiting.
4. *(Optional)* 🔁 `audit` → **Audit Trail** filtered to `REQ-2026-0004`. Show the full history of who did what and when.

**Voiceover / What to Say**
> "For management and finance, every figure comes from the same records. The Landowner Register lists every owner and their khasras, province by province, filtered down to a single deh, in the province's own unit or any unit you choose, and exported in one click. The executive dashboard summarises approved and paid compensation by province. And the audit trail shows every change, every approval and every comment: who, what and when, and it cannot be edited."

**Expected Result:** the register shows both Mahar owners with Kanal areas, and the dashboard reflects the new case and payment.

---

## Scene 10: Close (≈45 s) · *Manual §11*

**On-Screen Actions**
1. Return to the GIS map (as `mland`, all provinces). Show the blue *Handed over* polygon over the amber khasras.
2. *(Optional)* A title card listing the controls from Manual §11.

**Voiceover / What to Say**
> "So in one continuous flow we went from a line on a map to a receipted payment: exploration marked the land, three managers approved it, the land team took it up with nothing retyped, five people approved the award, and three people controlled the payment, with tax calculated automatically and every step on record.
>
> Province isolation, separation of duties, approval positions, protected personal data and a permanent audit trail run underneath every screen. That's the Land Management System for Mari Energies. Thank you."

**Expected Result:** the final frame shows the map with the completed request.

---

## Appendix: Scene timing and the users in each scene

| Scene | Users (in order) | Minutes | Cut for 12-min version |
|---|---|---|---|
| 0 Opening | — | 1 | keep, shorter |
| 1 Projects | lofield | 1.5 | keep |
| 2 Owners & khasras | lofield | 3 | show 1 owner, 1 khasra, 1 shares dialog |
| 3 GIS map | lofield | 1 | merge into 4 |
| 4 Explorer draws | explorer | 2.5 | keep |
| 5 Approvals + return | dirops, regmgr, explorer, dirops, regmgr, landaffairs | 3.5 | skip the return (5b–5c) |
| 6 Hand-over & acquisition | lofield | 2 | keep |
| 7 Case + chain | lofield, nego, legal, sradmin, dmfield, mland | 3 | show create + final approval only |
| 8 Payment & receipt | lofield, finance, mland, finance | 3 | keep |
| 9 Reports | mland, audit | 2 | register only |
| 10 Close | mland | 0.75 | keep |
