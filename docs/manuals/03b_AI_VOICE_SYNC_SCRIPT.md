# AI Voice Sync Script

Each segment: **Before you press play** (screen ready) · **Voice** (one clip) · **Sync** (what to do as you hear it).

---

### S01 · Opening · ≈40 s

**Before you press play:** the sign-in page at `localhost:3040/login`.

**Voice**
```
This is the Land Management System built for Mari Energies. <break time="1s" /> It runs the company's land work in Sindh, Balochistan, Punjab and Khyber Pakhtunkhwa, from the moment exploration needs a piece of land, through approvals, owners and compensation, to the cheque in the landowner's hand. <break time="1s" /> Every person signs in with their own role. The role decides what they see, which approval step they may take, and in which provinces. <break time="1s" /> Today we follow one case from start to finish: a new exploratory well, Daharki Well-03, near the village of Jarwar in District Ghotki.
```

**Sync:** stay on the sign-in page. Slowly scroll the demo account list while the voice talks about roles.

---

### S02 · Projects: why and where · ≈25 s

**Before you press play:** signed in as `lofield`, on any page.

**Voice**
```
Our Land Officer, Sanaullah, works only in Sindh, and the system shows him only Sindh records. <break time="1s" /> Every piece of land starts with a reason: a project. <break time="1s" /> He opens Projects and Well Locations, and clicks Add Project.
```

| When you hear | Do |
|---|---|
| "works only in Sindh" | Point at the province chip **Sindh** in the header |
| "opens Projects and Well Locations" | Sidebar → **Projects / Well Locations** |
| "clicks Add Project" | Click **+ Add Project** |

---

### S03 · Create the project · ≈50 s

**Before you press play:** the *Add Project* form is open and empty.

**Voice**
```
Project code: D-H-R-K, three-zero-one. <break time="2s" /> Province: Sindh. <break time="1s" /> The name: Daharki Well-03, Exploratory Location. <break time="2s" /> Type: Well Location. <break time="1s" /> Block: Daharki D and P L. <break time="2s" /> District: Ghotki. <break time="1s" /> We expect to need about twenty acres. <break time="1s" /> And a short description of the work: a well pad, a rig camp and an access road. <break time="2s" /> Save. <break time="2s" /> The project is now registered and active. From here on, every parcel, request, case and payment is filed under this code, so management can see the full land cost of each well.
```

| When you hear | Do |
|---|---|
| "Project code" | Paste `DHRK-301` |
| "Province: Sindh" | Province → **Sindh** |
| "The name" | Paste the name |
| "Type" | Type → **Well Location** |
| "Block" | Paste `Daharki D&PL` |
| "District" | District → **Ghotki** |
| "twenty acres" | Required area `20` |
| "a short description" | Paste the description |
| "Save" | Click **Save** |
| "registered and active" | Point at the new **DHRK-301** row, **Active** |

---

### S04 · Landowner 1 · ≈55 s

**Before you press play:** **Landowners** page, *Add Landowner* form open.

**Voice**
```
Next, the people. A landowner is identified by CNIC: one person, one record across the whole company, so we never pay a duplicate. <break time="1s" /> Province: Sindh. <break time="1s" /> The CNIC. Watch the dashes appear by themselves. <break time="2s" /> Full name: Ghulam Rasool Mahar. <break time="2s" /> Father's name: Muhammad Bux Mahar. <break time="2s" /> He is the owner. <break time="1s" /> Tax status: Filer. This matters later: the system will deduct withholding tax by itself, based on this. <break time="1s" /> Phone, bank branch, and his IBAN, which the system checks for the correct format. <break time="2s" /> The address, and save.
```

| When you hear | Do |
|---|---|
| "Province: Sindh" | Province → **Sindh** |
| "The CNIC" | Paste `4510420000113` (it shows `45104-2000011-3`) |
| "Full name" | Paste `Ghulam Rasool Mahar` |
| "Father's name" | Paste `Muhammad Bux Mahar` |
| "He is the owner" | Owner type → **O — Owner** |
| "Tax status: Filer" | Tax status → **Filer** |
| "Phone, bank branch, and his IBAN" | `0301-2345678`, `HBL Daharki`, paste the IBAN |
| "The address, and save" | Type `Village Jarwar, Taluka Daharki, District Ghotki` → **Save** |

---

### S05 · Landowner 2 · ≈35 s

**Before you press play:** *Add Landowner* form open again.

**Voice**
```
His brother, Nazir Ahmed Mahar, owns land with him. <break time="1s" /> Same province, his own CNIC. <break time="2s" /> His name. <break time="1s" /> The same father. <break time="1s" /> But Nazir is a non-filer, so his tax will be double. <break time="1s" /> His bank details. <break time="2s" /> And save. Both owners are now registered.
```

**Sync:** Province **Sindh** → paste `4510420000121` → paste `Nazir Ahmed Mahar` → paste `Muhammad Bux Mahar` → Owner → Tax **Non-Filer** → `Meezan Bank Daharki` and paste the IBAN → **Save**. The address is optional; skip it for speed.

---

### S06 · Khasra 451/2 · ≈55 s

**Before you press play:** **Survey / Khasra Register**, *Add Survey* form open.

**Voice**
```
Now the parcels. A khasra is recorded exactly as the revenue record writes it. <break time="1s" /> Province: Sindh. <break time="1s" /> Revenue location: District Ghotki, Taluka Daharki, Deh Jarwar. <break time="2s" /> It belongs to our project, D-H-R-K three-zero-one. <break time="1s" /> Khasra number: four-fifty-one, slash two. Block nine. <break time="2s" /> Rural, private land. <break time="1s" /> Twelve acres. <break time="1s" /> And its GPS position, latitude and longitude, which puts it on the map. <break time="2s" /> Save. The new khasra starts as Proposed.
```

| When you hear | Do |
|---|---|
| "Province" | **Sindh** |
| "Revenue location" | **Ghotki → Daharki → Jarwar** |
| "our project" | Project → **DHRK-301** |
| "Khasra number" | `451/2`, block `9` |
| "Rural, private land" | Khasra type **Rural**, Land class **Private** |
| "Twelve acres" | Area `12`, unit **Acre / Killa** |
| "GPS position" | Latitude `28.0710`, longitude `69.7050` |
| "Save" | **Save**, then point at **AREA-000034 · Proposed · 12.00** |

---

### S07 · Khasra 452/1 (Kanal) · ≈40 s

**Before you press play:** *Add Survey* form open again.

**Voice**
```
The second khasra, four-fifty-two, slash one, in the same deh. <break time="2s" /> This one is recorded in Kanal: sixty-four Kanal. <break time="2s" /> Its position. <break time="2s" /> Save. <break time="1s" /> The system converts it to eight acres, and keeps the original unit, Kanal, for the record.
```

**Sync:** Province **Sindh** → **Ghotki → Daharki → Jarwar** → **DHRK-301** → `452/1`, block `9` → **Rural**, **Private** → `64` with unit **Kanal** → `28.0703`, `69.7062` → **Save** → point at **8.00** acres.

---

### S08 · Owner shares · ≈45 s

**Before you press play:** the Survey register list, with both new khasras visible.

**Voice**
```
Finally, who owns what. <break time="1s" /> On khasra four-fifty-one, open Shares, and add both brothers. <break time="2s" /> Sixty percent and thirty percent. <break time="1s" /> Notice that Save stays disabled. The system only accepts shares that add up to exactly one hundred percent. <break time="1s" /> Forty percent. Now it saves. <break time="2s" /> The second khasra is shared fifty-fifty. <break time="2s" /> Once registered, shares can only change through a formal mutation, such as inheritance, and never by simply overwriting them.
```

| When you hear | Do |
|---|---|
| "open Shares" | AREA-000034 → **Shares** → add Ghulam, then Nazir |
| "Sixty… thirty" | Type `60` and `30` |
| "Save stays disabled" | Point at the disabled **Save shares** |
| "Forty percent" | Change 30 to `40` → **Save shares** |
| "fifty-fifty" | AREA-000035 → **Shares** → add both → `50` / `50` → **Save shares** |

Tip: to save time, do AREA-000035's shares off camera before this segment, and let the voice line cover it.

---

### S09 · GIS map · ≈30 s

**Before you press play:** **GIS Land Map** open and zoomed to Jarwar, so the two grey markers are visible.

**Voice**
```
Everything with coordinates appears on the map. <break time="1s" /> Each dot is a khasra, coloured by its land status: grey for proposed, amber under acquisition, green acquired, blue leased, and red disputed. <break time="1s" /> Here are our two new parcels near Jarwar. <break time="1s" /> Operations, the land team and management all look at the same picture.
```

**Sync:** point at the legend as the colours are read, then click a grey marker. The side panel shows its details.

---

### S10 · The Explorer role · ≈25 s

**Before you press play:** signed in as `explorer` and already on the **GIS map**. Signing in lands there by itself.

**Voice**
```
Now the most important new capability. <break time="1s" /> This is the Exploration Planner. He lands straight on the map. He can see projects, parcels and land status, but no owner names, CNICs or payments. That's least privilege, by design. <break time="1s" /> He clicks Draw land request.
```

**Sync:** run the mouse down the short sidebar menu, then click **✎ Draw land request**.

---

### S11 · Paste the corners · ≈40 s

**Before you press play:** drawing mode is on, and the polygon v1 corners are in your clipboard:
```
28.07200, 69.70400
28.07200, 69.70700
28.06950, 69.70700
28.06950, 69.70400
```

**Voice**
```
He can click corners on the map, drag them, or remove them. <break time="2s" /> But most field teams carry GPS coordinates, so he pastes them. <break time="1s" /> Paste lat-long, <break time="1s" /> the four corners, <break time="1s" /> and use these corners. <break time="2s" /> The shape appears on the map instantly.
```

| When you hear | Do |
|---|---|
| "click corners on the map" | Click 3 points on the map, then **Clear** |
| "Paste lat-long" | Click **Paste lat/long** |
| "the four corners" | Paste into the box |
| "use these corners" | Click **Use these corners** |

---

### S12 · Read the panel · ≈30 s

**Before you press play:** the polygon is drawn and the panel is visible.

**Voice**
```
The system measures it straight away: twenty point one nine acres, about eight hectares, with its centre point. <break time="1s" /> And it finds the recorded khasras inside: our two Mahar parcels. <break time="1s" /> If this shape touched disputed land, land we already lease, government land, or another open request, a warning would appear right here, before anything is submitted.
```

**Sync:** point in turn at **Area**, **Centre**, **Parcels inside: 2**, then at the empty warning area.

---

### S13 · Request details and submit · ≈50 s

**Before you press play:** the same screen. The justification text is in your clipboard.

**Voice**
```
Continue to the request details. <break time="1s" /> The project: D-H-R-K three-zero-one. <break time="1s" /> Purpose: well location. <break time="1s" /> Priority: urgent. <break time="1s" /> Needed by the fifteenth of January. <break time="2s" /> The deh, Jarwar, is filled in from the parcels inside. <break time="1s" /> And the justification: why this land, what will be built, and by when. <break time="2s" /> Submit to Director Operations. <break time="2s" /> Request four is created and sent. On the map it turns orange: under review. The server measured the shape again itself. It never trusts figures from the browser.
```

| When you hear | Do |
|---|---|
| "Continue" | **Continue: request details** |
| "The project" | Project → **DHRK-301** |
| "Purpose" | **Well Location** |
| "Priority" | **Urgent** |
| "fifteenth of January" | Required by `2027-01-15` |
| "The deh" | Point at **Jarwar** (pre-filled); type `Daharki D&PL` in Concession |
| "the justification" | Paste the justification |
| "Submit" | **Submit to Director Operations** |
| "turns orange" | Point at the message and the orange polygon |

---

### S14 · Director Ops opens it · ≈40 s

**Before you press play:** signed in as `dirops`, on **Land Requests**.

**Voice**
```
The request now waits for the Director Operations, the first of three independent approvals. <break time="1s" /> He opens the details. <break time="1s" /> He sees exactly what is asked: the drawn area, every corner's latitude and longitude, the parcels it covers, and any warnings. <break time="2s" /> And with one click, he sees it on the map. <break time="2s" /> His question is simple: is the operational need real?
```

| When you hear | Do |
|---|---|
| "first of three" | Point at the workflow column, step 2 |
| "opens the details" | **Details** on REQ-2026-0004 |
| "every corner's latitude" | **Show the 4 corners**; scroll to the parcels |
| "on the map" | Close → **Map** (the polygon is framed) |

---

### S15 · Director Ops approves · ≈20 s

**Before you press play:** back on **Land Requests** as `dirops`.

**Voice**
```
He approves, with a comment that is recorded permanently: <break time="2s" /> operational need confirmed. <break time="1s" /> It moves to the Regional Manager.
```

**Sync:** **Review** → **Approve** → paste `Operational need confirmed: Well-03 is in the 2027 drilling plan.` → **Approve** → point at **Under Review - Regional**.

---

### S16 · Regional Manager returns it · ≈25 s

**Before you press play:** signed in as `regmgr`, on **Land Requests**.

**Voice**
```
The Regional Manager looks at it from the region's side, and asks for a change. <break time="1s" /> Instead of a phone call and a new paper form, she returns it, with a comment: <break time="2s" /> move the north boundary away from the link road. <break time="1s" /> It goes back to the planner.
```

**Sync:** **Review** → **Return** → paste `Pull the north boundary about 45 m south to keep clear of the Jarwar link road, then resubmit.` → **Return for revision** → point at **Returned**.

---

### S17 · Explorer redraws (v2) · ≈45 s

**Before you press play:** signed in as `explorer`, on **Land Requests**. The polygon v2 corners are in your clipboard:
```
28.07160, 69.70400
28.07160, 69.70680
28.06950, 69.70680
28.06950, 69.70400
```

**Voice**
```
The planner sees it was returned, and edits it on the map. <break time="2s" /> He clears the shape, and pastes the revised corners. <break time="2s" /> Now fifteen point eight three acres, still covering both parcels. <break time="1s" /> He says what changed, and sends it again. <break time="2s" /> The first version is never lost. Reviewers can compare both. And because the land changed, every approver decides again from the start.
```

| When you hear | Do |
|---|---|
| "edits it on the map" | **Edit on map** |
| "clears the shape, and pastes" | **Clear** → **Paste lat/long** → paste → **Use these corners** |
| "fifteen point eight three" | Point at the area |
| "says what changed" | **Continue: review and save** → What changed: `North boundary moved 45 m south and east edge 20 m west, as asked by the Regional Manager.` → **Save and send to Director Operations** |
| "never lost" | Optional: **Details → Polygon versions** (v2, v1) |

---

### S18 · Director Ops approves again · ≈12 s

**Before you press play:** `dirops`, on **Land Requests**.

**Voice**
```
The Director Operations confirms the revised boundary. <break time="2s" />
```

**Sync:** **Review → Approve** → `Revised boundary acceptable.` → **Approve**.

---

### S19 · Regional Manager approves · ≈12 s

**Before you press play:** `regmgr`, on **Land Requests**.

**Voice**
```
And the Regional Manager agrees. <break time="2s" />
```

**Sync:** **Review → Approve** → `Region supports it; no conflict with other activity.` → **Approve**.

---

### S20 · Land Affairs, final approval · ≈25 s

**Before you press play:** `landaffairs`, on **Land Requests**.

**Voice**
```
Finally, the DM Land Affairs answers the last question: can this land actually be obtained? <break time="1s" /> Private land, two known owners, no litigation. Approved. <break time="2s" /> Three rules hold this together, enforced in the database itself: only the holder of each position decides that step, the person who asked can never approve, and no one decides two steps.
```

**Sync:** **Review → Approve** → `Private land, two owners identified, no litigation recorded. Approved.` → **Approve** → point at **Approved** and at step 5, *Land work*.

---

### S21 · Hand-over · ≈35 s

**Before you press play:** `lofield`, on **Land Requests**.

**Voice**
```
The approved request comes back to the land team. <break time="1s" /> The Land Officer takes it up, as an acquisition. <break time="1s" /> With one tick, the parcels inside the approved boundary are marked under acquisition, everywhere in the system. <break time="1s" /> A short comment, <break time="1s" /> and take it up. <break time="2s" /> Two parcels marked. The request is now handed over.
```

**Sync:** **Start land work** → Land work **Acquisition** → keep the tick → Comment `Negotiation with the Mahar family starts 10 Nov 2026.` → **Take it up** → point at the green message.

---

### S22 · Create acquisition · ≈35 s

**Before you press play:** the same page, after the hand-over.

**Voice**
```
Now, Create acquisition. <break time="2s" /> It opens already filled in: the project, the approved area, the target date, and the exact khasras. Nothing is retyped. <break time="1s" /> He chooses private lease, and the negotiated rate. <break time="2s" /> Save. The acquisition and the request are linked both ways.
```

**Sync:** **Create acquisition** → point at the pre-filled fields and the khasra chips → Mode **Private Lease** → Rate `60000` → **Save**.

---

### S23 · Case header and owners · ≈50 s

**Before you press play:** `lofield`, **Compensation Cases** → **+ Add Compensation Case** open.

**Voice**
```
With the owners and parcels known, the Land Officer prepares the compensation case. <break time="1s" /> Project: D-H-R-K three-zero-one. <break time="1s" /> Land used for: well location. <break time="1s" /> A lease rate of sixty thousand rupees per acre, per year, <break time="1s" /> for thirty-six months. <break time="2s" /> The owners: Ghulam Rasool with sixty percent, <break time="2s" /> and Nazir Ahmed with forty. <break time="2s" /> Again, the shares must total exactly one hundred.
```

**Sync:** Project **DHRK-301** → **Well Location** → `60000` → `36` → owner line 1: Ghulam, `60`, **O** → **+ Add line** → Nazir, `40`, **O**.

---

### S24 · Case lines · ≈60 s

**Before you press play:** the same form, scrolled to the lines.

**Voice**
```
Now what they're owed. <break time="1s" /> A lease line: khasra four-fifty-one, all of it, twelve acres. <break time="3s" /> Crop damage on the second khasra: <break time="1s" /> wheat, forty-five thousand rupees an acre, five acres damaged. <break time="3s" /> Six medium Kikar trees, at eight thousand each. <break time="3s" /> And a disturbance allowance of twenty-five thousand. <break time="3s" /> He enters rates and quantities only. The database calculates the award itself.
```

| When you hear | Do |
|---|---|
| "A lease line" | Lease: **AREA-000034**, `100`, `12` |
| "Crop damage" | Crop: **AREA-000035**, `Wheat`, `45000`, `5` |
| "Six medium Kikar" | Tree: **AREA-000035**, **Kikar**, **Medium**, `8000`, `6` |
| "disturbance allowance" | Other: **AREA-000034**, `Disturbance allowance`, `25000` |

---

### S25 · Documents and create · ≈35 s

**Before you press play:** the same form, scrolled to *Documents seen*.

**Voice**
```
He confirms the documents he has seen: CNIC copies, the revenue record, the signed consent, bank details, photographs, and the joint survey. <break time="3s" /> Create case. <break time="2s" /> The award: two million, four hundred and fifty-eight thousand rupees. <break time="1s" /> And notice: the person who prepares a case can never approve it, so he has no approve button.
```

**Sync:** tick all 6 documents → **Create case** → point at **Total Rs 2,458,000** and at the missing approve button.

---

### S26 · Approval chain (five short clips) · ≈10 s each

Record five clips, one per user. **Before each:** sign in as that user and open **CC-2026-0012**.

| Clip | User | Voice | Do |
|---|---|---|---|
| S26a | `nego` | `Negotiation confirms the agreed rates. <break time="2s" />` | **→ Checked** (note `Rates agreed with both owners on site.`) |
| S26b | `legal` | `Legal reviews the title. <break time="2s" />` | **→ Reviewed** |
| S26c | `sradmin` | `The Senior Administrator verifies the field records. <break time="2s" />` | **→ Verified** |
| S26d | `dmfield` | `The DM approves it at field level. If a document were missing, this step would be refused. <break time="2s" />` | **→ Field Approved** |
| S26e | `mland` | `And the Manager Land approves it at head office. Five people, one step each. The award is now locked. <break time="2s" />` | **→ HO Approved**, then point at the lock |

---

### S27 · Payment voucher · ≈60 s

**Before you press play:** `lofield`, **Payments & Cheques** → **+ Request Payment** open.

**Voice**
```
Payment starts with a voucher against the approved case. <break time="1s" /> The project, <break time="1s" /> and the case, showing two point four five eight million outstanding. <break time="2s" /> The payee has to be one of the case's owners: Ghulam Rasool. You can't type in any other name, so the right tax and any holds always apply. <break time="2s" /> Lease rent, paid in advance for several years, <break time="2s" /> by crossed cheque, private land. <break time="2s" /> From November twenty twenty-six to October twenty twenty-nine. <break time="2s" /> Gross amount: one million rupees. <break time="2s" /> Request. <break time="2s" /> He's a filer, so the system deducts ten percent withholding tax by itself. The cheque will be for nine hundred thousand.
```

| When you hear | Do |
|---|---|
| "The project" | **DHRK-301** |
| "the case" | **CC-2026-0012** |
| "Ghulam Rasool" | Payee → Ghulam Rasool Mahar |
| "Lease rent" | Category **Lease Rent**, Pay type **Advance Lease (multi-year)** |
| "crossed cheque" | Mode **Cross Cheque**, Land class **Private** |
| "From November" | `2026-11-01` → `2029-10-31` |
| "one million" | Gross `1000000` |
| "Request" | **Request**, then point at **WHT 10%** and net **900,000** |

---

### S28 · Over-award check (optional) · ≈20 s

**Before you press play:** a new *Request Payment* form, with project and case chosen and payee Ghulam.

**Voice**
```
And the system will never let vouchers exceed the approved award. <break time="1s" /> Two and a half million? <break time="2s" /> Refused.
```

**Sync:** Gross `2500000` → **Request** → point at the refusal message → **Cancel**.

---

### S29 · Finance verifies · ≈15 s

**Before you press play:** `finance`, **Payments → Vouchers**.

**Voice**
```
Three different people touch every payment. Finance verifies it, checking the budget, any court stay or hold, and that the owner is alive. <break time="2s" />
```

**Sync:** **Verify** on VCH-2026-00034 → note `Payee, WHT and case checked.` → confirm.

---

### S30 · Manager Land releases · ≈25 s

**Before you press play:** `mland`, **Payments → Vouchers**. Sign in fresh, so no password prompt appears.

**Voice**
```
Then the Manager Land releases the cheque. <break time="1s" /> The cheque date, a note, <break time="2s" /> and release. <break time="2s" /> The cheque is for the net amount, nine hundred thousand, and the posting is queued for SAP.
```

**Sync:** **Release cheque** → date (today) → note `Released to the owner at Daharki field office.` → confirm → point at the **CHQ-** number and **900,000**.

---

### S31 · Receipt · ≈40 s

**Before you press play:** `finance`, **Payments → Cheques** tab.

**Voice**
```
When the owner collects the cheque, Finance records who received it: <break time="1s" /> the receipt number, the date, <break time="2s" /> Ghulam Rasool Mahar, and his CNIC. <break time="2s" /> Then prints a formal receipt of payment. <break time="2s" /> It names the parcel and its revenue location, shows the gross, the tax withheld and the net, the amount in words, what he is owed and what remains, with the declaration and signatures.
```

**Sync:** **Record receipt** → `RCPT-2026-0101`, date → `Ghulam Rasool Mahar`, `45104-2000011-3` → save → **Print receipt** → scroll the receipt slowly as each part is named.

---

### S32 · Landowner Register · ≈40 s

**Before you press play:** `mland`, **Records & Reports → Landowner Register**.

**Voice**
```
For management and finance, every figure comes from the same records. <break time="1s" /> The landowner register lists every owner and their khasras, province by province. <break time="1s" /> Filtered down to District Ghotki, Taluka Daharki, Deh Jarwar. <break time="2s" /> Shown in Kanal, the unit of the revenue record, <break time="1s" /> one row per owner. <break time="1s" /> And exported in one click.
```

**Sync:** Province **Sindh** → District **Ghotki** → Taluka **Daharki** → Deh **Jarwar** → Area unit **All in Kanal** → Show **One row per owner** → point at **96 Kanal** → click **PDF**.

---

### S33 · Dashboard and audit · ≈25 s

**Before you press play:** `mland`, **Executive Dashboard**.

**Voice**
```
The executive dashboard summarises approved and paid compensation, by province. <break time="2s" /> And the audit trail shows every change, every approval and every comment: who, what and when. It cannot be edited.
```

**Sync:** point at the province chart and the paid figures. *(Optional: cut to **Audit Trail** filtered by `REQ-2026-0004`, recorded as `audit`.)*

---

### S34 · Close · ≈35 s

**Before you press play:** `mland` on the **GIS map**, zoomed to Jarwar, showing the blue polygon.

**Voice**
```
So in one continuous flow, we went from a line on a map to a receipted payment. <break time="1s" /> Exploration marked the land. Three managers approved it. The land team took it up, with nothing retyped. Five people approved the award, and three people controlled the payment, with tax calculated automatically and every step on record. <break time="1s" /> That's the Land Management System for Mari Energies. Thank you.
```

**Sync:** hold on the map. Click the blue polygon at "a line on a map", then rest.
