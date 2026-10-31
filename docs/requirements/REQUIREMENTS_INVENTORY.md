# LMS Requirements Inventory

> Generated 2026-10-30 by a read-only review of `requirments/` (35 files) and the working tree (Next.js `src/`, `db/migrations` 0001–0044, `tests/`, `db/tests`). Code is moving: other engineers were editing `src/` and `db/` during the review. Database facts come from read-only SQL on `lms_dev` (migrations applied to **0038**) and `lms_test` (0044). Statuses: Implemented | Partial | Missing | Simulated (fake/hardcoded/browser-only) | Defective | Superseded. REQ-01…REQ-24 keep their ids from `.gsd/REQUIREMENTS.md`; REQ-25 onward are new. Nothing in this review was run in a browser: UI claims marked "needs runtime verification" were not exercised.

## Status summary

| Status | Count |
|---|---|
| Implemented | 42 |
| Partial | 49 |
| Missing | 18 |
| Simulated | 4 |
| Defective | 5 |
| Superseded | 2 |
| **Total** | **120** |

## Source key

- **EMAIL** — `requirments/email.txt`
- **PPSX** — `requirments/Measurement Units, Adminitrative Hierarchy, Terminology & Work Flow (12-March-2026).ppsx`
- **MUJPG** — `requirments/Measurement Units.jpg`
- **PROTO** — `requirments/LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html`
- **WFPDF** — `requirments/Workflow references/Sample Approval Workflow.pdf`
- **WFCC** — `requirments/Workflow references/Workflow Approval for Compensation Case.jpg`
- **WFFP** — `requirments/Workflow references/Work Flow Approval for Flare Pit.jpg`
- **WF50** — `requirments/Workflow references/50% Remaining Past Pending Approval Workflow.jpg`
- **RCPT** — `requirments/Reports and documents/Sample Payment Receipt.png`
- **LOD** — `requirments/Reports and documents/Sample Landowner Details.png`
- **LAD** — `requirments/Reports and documents/Sample Lease Agreement Document.png`
- **PSR** — `requirments/Reports and documents/Sample Project Status Report.png`
- **FIN** — `requirments/Reports and documents/Financial Project Sample.pdf`
- **SS-CHAT** — `requirments/Sample Screen Shots/ChatGPT Image Oct 27, 2026, 04_09_55 PM.png`
- **SS-CASENO** — `requirments/Sample Screen Shots/Sample  Compensation Case with Case No.png`
- **SS-CASECHG** — `requirments/Sample Screen Shots/Sample  Compensation Case with Change Data for Compensation Being Paid.png`
- **SS-DIST** — `requirments/Sample Screen Shots/Sample District Master Entry Entry Form.png`
- **SS-MENU** — `requirments/Sample Screen Shots/Sample LMS System Interface.png`
- **SS-LOSEL** — `requirments/Sample Screen Shots/Sample Land Owner Selection for Creating Compensation Case.png`
- **SS-LOPCT** — `requirments/Sample Screen Shots/Sample Landowner Detail with Percentage.png`
- **SS-LLDR** — `requirments/Sample Screen Shots/Sample Landowner Lease Details Report.png`
- **SS-LLREN** — `requirments/Sample Screen Shots/Sample Landowner Lease Details and Renewal.png`
- **SS-LT2** — `requirments/Sample Screen Shots/Sample Lease Details Table-2.png`
- **SS-LR** — `requirments/Sample Screen Shots/Sample Lease Report.png`
- **SS-SURV** — `requirments/Sample Screen Shots/Sample Master Key Deh Entry.png`
- **SS-PROJ** — `requirments/Sample Screen Shots/Sample Selecting Project for Comepnsation Being Created.png`
- **SS-RIGHTS** — `requirments/Sample Screen Shots/Sample Showing Approval Rights against each deisgnation.png`
- **CSV-LO** — `requirments/CSV Datasets/Landowner_Detail.csv`
- **CSV-LR** — `requirments/CSV Datasets/Lease_Register.csv`
- **CSV-PS** — `requirments/CSV Datasets/Payment_Status.csv`
- **CSV-PWS** — `requirments/CSV Datasets/Project_Wise_Summary.csv`
- **CSV-PA** — `requirments/CSV Datasets/Purchase_Acquired.csv`
- **CSV-REN** — `requirments/CSV Datasets/Renewal.csv`
- **CSV-DPFC** — `requirments/CSV Datasets/Sample DPFC Government Land.csv`
- **GSD** — `.gsd/REQUIREMENTS.md (prior matrix)`

## Source conflicts and ambiguities (need a Mari decision)

1. **Past pending / 50% workflow**: `WF50` JPG has a **CFO** step after Director OPS; PPSX slide 13 (image6) does not. (REQ-44)
2. **Compensation approval chain**: Oracle LMS screenshots (SS-RIGHTS, SS-CASENO) use Prepared → Checked (Negotiation Group) → Reviewed (Legal Advisor) → Verified (Sr. Administrator LMS Field) → Checked in Khi → Approved (Approval 1 / Approval 2, Field/Kharat flags). PPSX slide 11 uses designations Initiator → TL/DM Land → Regional Manager → Director OPS → TL Finance. The application implements the Oracle chain only. (REQ-42, REQ-48)
3. **Slide 5 conversion table, "Pole / Marla" row**: values (Acre 0.00025; Jireb 160, Rod 80, Kanal 40) contradict the Acre row (1 acre = 160 Pole). The system uses 1 Pole/Marla = 1/160 acre = 272.25 sq ft (consistent with the Sq Feet column). (REQ-02)
4. **Administrative order**: slide 7/8 list Balochistan District → Tehsil → Sub-Division and KPK District → Tehsil → Sub Division, and Division above District everywhere; the prototype and the DB use District → Sub-Division → Tehsil and no Division. (REQ-01)
5. **Units**: PPSX gives Sindh Acre/Ghunta/Sq Ft and KPK Acre/Kanal/Marla/Sq Ft; the prototype added Jireb (Sindh) and Bigha (KPK), which are not in the PPSX province flows. (REQ-27)
6. **Land request vs compensation order**: the land-request PDF puts Director Operations before the Regional Manager; the compensation flows put the Regional Manager before Director OPS. Both are taken literally (different processes).
7. **CSV data quality**: every CNIC in the CSVs is the placeholder `99999-0000001-1`; `Rate per Acre` is 0 in the sampled rows; `Lease End` equals `Lease Start` in many rows. CNIC uniqueness and rent cannot be validated from these files. (REQ-83/84)
8. **Name**: email says "DBPFC", the CSV says "DPFC" (District Price Fixation Committee). Treated as the same process.
9. **Landowner Detail sample** has a "Khasra No." column holding YES/NO next to "Survey No." — meaning unclear (likely "Khasra/Survey verified"). (REQ-33)

## A. Measurement units, administrative hierarchy & terminology

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-01 | Province-specific administrative hierarchy: Sindh Division→District→Taluka→Deh; Balochistan Division→District→Tehsil→Sub-Division→Sub-Tehsil/Qanungo Halka→Mouza; Punjab Division→District→Tehsil→Qanungo Halka→Mouza; KPK Division→District→Tehsil→Sub-Division→Mouza. | PPSX slide 7 (table) and slide 8 (media/image3.jpg) | Every survey is placed under the province's exact level chain, in the slide order, including Division. | Defective |
| REQ-25 | International jurisdiction: hierarchy Federal Authority→Local Autonomy→Regions/Municipalities, revenue key "Block No / Land Parcel"; District Master Entry offers a Pakistan / International selector. | PPSX slide 7 (INTERNATIONAL row), slide 8 image3.jpg; SS-DIST (Pakistan/International dropdown) | An "International" jurisdiction with its own levels and key label can be selected wherever a province is selected. | Missing |
| REQ-26 | Province revenue-key terminology: Sindh "Survey No / Block No"; Balochistan & Punjab "Khasra No"; KPK "Khasra No (Rural) / Survey No (Urban)". | PPSX slide 7; slide 4 image2.jpg; MUJPG | Forms, lists and reports label the parcel key with the province term. | Implemented |
| REQ-02 | Unit conversion engine using the slide-5 matrix: Murabba=25 Acre; Acre/Killa=2 Jireb/Bega=4 Rod=8 Kanal=40 Ghunta/Wiswa=160 Pole/Marla=4,840 Sq Yd=43,560 Sq Ft (plus Sq m). | PPSX slide 5 (table); slide 3 | Converting any listed unit to any other reproduces slide 5 exactly; conversions are exact (no float drift). | Implemented |
| REQ-27 | Province unit sets: Sindh Acre→Ghunta→Sq Ft; Balochistan Acre→Rod→Pole→Sq Ft; Punjab and KPK Acre→Kanal→Marla→Sq Ft; International Acre→Decimal→Acreage, Sq Ft (Sq m). | PPSX slide 3 (table), slide 4 image2.jpg; MUJPG | Area entry/display offers exactly the province units; KPK uses Marla (not Bigha). | Partial |
| REQ-28 | Areas on Sindh documents and reports are expressed as Acre–Ghunta ("A - G", 40 Ghunta = 1 Acre), e.g. "13 Acre(s) - 22 Ghunta(s)", totals "36 - 15". | SS-CASENO, SS-CASECHG (Lease/Crop details, totals); SS-LLDR; FIN p1-2 "Area (acres)"; RCPT ("2 - 9 acres"); PROTO ag() | Every Sindh area on case sheet, receipt, lease and project-status reports shows A-G and totals in A-G. | Partial |
| REQ-29 | Master entry screens for District (code, name, by province and Pakistan/International), Taluka, Deh/Moza, Survey/Khasra, and mapping screens Deh–Taluka and Taluka–District. | SS-MENU (Action menu: Private Master Entry, District/Taluka Master Entry, Deh/Moza Entry, Survey/Khasra Entry, Landowner No., Customer No., Deh-Taluka, Taluka-District); SS-DIST | Admin can create each level with a code and parent, and re-map a child to another parent. | Partial |
| REQ-30 | Survey Master Entry per Deh: Survey code, Survey name, Total survey area (Acres, Ghunta) and Occupied survey area (Acres, Ghunta). | SS-SURV | For any Deh the screen lists each survey with total and occupied (committed) area split into acres and ghunta. | Partial |
| REQ-31 | Business terminology is used consistently: Deh/Mouza, Taluka/Tehsil, Survey/Khasra, Tora (initial/subsequent lease year), Kharat approval, DBPFC/DPFC, BOR, Record of Rights (Form A, VII-B), Murabba/Killa/Jireb/Bega/Wiswa. | PPSX slides 1-8; SS-CASENO ("Initial Tora / Subsequent Tora"); SS-RIGHTS ("Kharat Approved"); CSV-DPFC (BOR Reservation Status) | UI labels and printed documents use these terms; a glossary is available. | Partial |

## B. Master data (projects, surveys, landowners)

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-32 | Project / well-location master with location code (e.g. AASU-001, AASU-10P), name, project detail, concession/business unit and block code (e.g. 01 BADIN-1), selected through a searchable "Well Location List" (Find%). | SS-PROJ (Well Location List popup); SS-LOSEL; SS-CASENO header | Case creation picks a project by code/name search; block code and business unit auto-fill. | Implemented |
| REQ-03 | Landowner master with unique landowner ID per CNIC (XXXXX-XXXXXXX-X), name and father's name, owner status, bank/IBAN, tax status. | SS-LOPCT, LOD (Landowner Code/ID, Name/Father's Name, CNIC); EMAIL §3 (unique landowner IDs); PROTO SPEC.landowners | Duplicate CNIC is refused; every case/lease/payment references the landowner ID. | Implemented |
| REQ-04 | Ownership shares per survey/khasra (Owner %) must total 100% before a case can proceed. | SS-LOPCT ("Status Owner %"); LOD ("Share %"); EMAIL §3 (ownership shares); PROTO titleIssues() | A survey whose shares do not total 100% cannot be used in an approved case. | Implemented |
| REQ-33 | Landowner Detail register (screen c_owner_base_dta): Landowner code, Name/Father's name, CNIC, Location/Project, No. of leases renewed (years), Deh/Moza, Taluka/Tehsil, Survey No., Khasra No., Share %, Activity Active (Y/N), File status (Active/Not Active), Payment type (LAND/CROP/TREE/MISC), with Case # and Case Status of the selected row. | LOD; SS-CHAT (variant with Well/Contract ID, Area, Active Status); SS-LOPCT | A register/report returns one row per landowner-holding with all listed columns and can be filtered by project/landowner. | Partial |
| REQ-34 | Payment type per landowner holding (LAND / CROP / TREE / MISC) is recorded and reportable. | LOD and SS-LOPCT ("Payment Type" column) | Each landowner-survey row shows which compensation heads apply. | Missing |

## C. Land lease request (initiation & approval)

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-35 | Land lease request capture with mandatory fields: auto Request ID, Initiator/Department, system Request Date, Project/Well, Concession/Field, Location (Province, District, Taluka/Tehsil, Deh/Moza), Land Area (Acres & Ghunta), Land Purpose (Well, Rig Camp, Flare Pit, ROW, Pipeline, Access Road, Facility…), Requirement Type (new lease / extension / additional area), Required Possession Date, Justification, Attachments (location map, KMZ, layout, survey, supporting docs). | WFPDF p1 §2 table, p2 table | A request cannot be submitted without every mandatory field; attachments are stored against the Request ID. | Partial |
| REQ-36 | Approval order Initiator → Director Operations → Regional Manager (by concession/field) → DM/TL Land Affairs; each tier acted on only by a holder of that designation; no request reaches the RM without Director Operations approval. | WFPDF p1 §1, p2 §3 and §4.1-4.4 | A user who does not hold the tier's designation is refused; RM is chosen by concession/field. | Defective |
| REQ-37 | Director Operations may approve or reject with mandatory remarks; a rejected request returns automatically to the original initiator for revision and resubmission. | WFPDF p1 §1 ("If rejected — Return to original initiator"), p2 §4.2 | Rejection by Director Ops moves the request to "Returned/Rejected by Director Operations" and only the initiator can resubmit. | Defective |
| REQ-38 | Request statuses: Draft; Submitted – Director Operations Approval Pending; Returned/Rejected by Director Operations; Approved – Regional Manager Action Pending; Forwarded to Land Affairs; Land Processing Initiated. | WFPDF p2 §5 | Status values and wording match the PDF. | Partial |
| REQ-39 | Automatic system / e-mail notifications at approval, rejection and assignment stages (land requests and other workflows). | WFPDF p2 §4.5; EMAIL §2 (process approvals); PROTO notifyNext() | Next-tier officers and the initiator receive an in-app and e-mail notification on every decision. | Missing |
| REQ-40 | Initiator and authorised management can see current status and the responsible officer; all subsequent actions (survey, verification, negotiation, lease, compensation, PR/PO, payment, possession) stay linked to the original Request ID; duplicate requests are prevented. | WFPDF p2 §4.7, §4.8, scope note | Request detail shows the named pending officer; cases/leases/payments carry request_id; a second open request for the same project/location/purpose is refused. | Partial |
| REQ-41 | Request audit trail captures Request ID, user, date/time, action, remarks and full approval history. | WFPDF p2 §4.6 | Every decision (including repeated cycles after return) is retrievable with remarks. | Implemented |

## D. Compensation approval workflows by designation

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-42 | Compensation for new & ongoing projects (Lease, Crop, Trees, Structure, One-Time, Misc) is approved by designation in this order: Initiator → TL/DM Land (Sindh/Balochistan/Punjab/KPK) → Regional Manager (province) → Director OPS → Approve → TL Finance processes the cheque. | PPSX slide 11 (media/image4.jpg); WFCC | A case can only advance through these designations in this order; the cheque is processed by TL Finance after Director OPS approval. | Defective |
| REQ-43 | Flare-pit / flaring damage compensation and local complaints of crop damage after location hand-over (e.g. watercourse damage) follow: Initiator → TL/DM Land → Manager Production (province) → Regional Manager → Director OPS → Approve → TL Finance processes cheque. | PPSX slide 12 (media/image5.jpg); WFFP | A flare-pit case requires Manager Production approval between TL/DM Land and RM. | Missing |
| REQ-44 | Past pending claims and 50% remaining payments follow: Initiator → Advisor Land → TL/DM Land → TL Finance → Regional Manager → Director OPS → (CFO) → Approve → TL Finance processes cheque. | PPSX slide 13 (media/image6.jpg, no CFO); WF50 (CFO after Director OPS) | The 50%/past-pending claim requires the listed sequence; CFO step per confirmed source. | Missing |
| REQ-45 | Approver designations are province-specific (TL/DM Land, Regional Manager, Manager Production, TL Finance for Sindh / Balochistan / Punjab / KPK); Director OPS (and CFO) are company-wide. | PPSX slides 11-13; WFCC, WFFP, WF50 (each box labelled "Sindh/Balochistan/Punjab & KPK") | A Sindh case can only be approved by the Sindh holder of the designation. | Partial |
| REQ-46 | Approval workflows are configurable: approvers per step and (later) new workflows such as International Boundaries / Offshore compensation can be configured without redevelopment. | PPSX slide 10 (notes: workflow tentative; international/offshore not defined; flexible architecture) | Admin can change the approver group per stage and add a new stage set through configuration. | Partial |
| REQ-47 | Each compensation case is classified (New/Ongoing project head: Lease, Crop, Trees, Structure, One-Time, Misc; Flare-pit/crop-damage complaint; Past pending / 50% remaining) and routed to the matching workflow. | PPSX slides 11-13; EMAIL §3 (new/ongoing, historical cases) | Case form requires a case type; the workflow shown on the case follows the type. | Missing |
| REQ-48 | Oracle LMS sign-off chain on the case form — Prepared By, Checked By, Reviewed By, Verified By, Checked in Khi, Approved By, each with name and remarks — plus "Field/Land Approved" and "Kharat Approved" Yes/No flags. | SS-RIGHTS; SS-LOSEL; SS-PROJ; SS-CASENO signature blocks (Initiated/Prepared, Reviewed by Legal Advisor, Checked by Negotiation Group, Verified by Sr. Administrator LMS (Field), Approval 1, Approval 2) | Each sign-off is recorded by a holder of the right designation with remarks; the printed case shows the sign-offs. | Partial |
| REQ-49 | Approvers can reject or return a case/payment for correction with mandatory remarks; corrections are resubmitted and re-approved. | EMAIL §2 ("approvals, rejections, corrections"), §3 ("correction and rejection remarks"); WFPDF p2 §4.2; PROTO canReturn() | A case at any stage can be returned to the preparer with remarks; history keeps both cycles. | Missing |
| REQ-11 | Segregation of duties in approvals: the preparer cannot approve; one person cannot approve two steps; approver must hold the step's designation. | EMAIL §5 (separation of duties); PROTO advanceBlock(); WFPDF p2 §4 | SoD violations are refused by the database. | Implemented |

## E. Compensation case content & case document

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-10 | Compensation case engine with Lease, Crop, Tree and Miscellaneous heads; total = lease + crop + tree + misc. | SS-CASENO, SS-CASECHG; PROTO caseTotals(); EMAIL §3 | Totals are computed in the database and equal the sum of the line amounts. | Implemented |
| REQ-50 | Case header: auto Case No, Case Date, Project ID / Well location, Concession / Delivery Unit (Business Unit), Project detail, Land used for, Block code, Lease No, Case Status, Reference Lease. | SS-CASENO; SS-LOSEL; SS-PROJ | All header fields are stored and printed; Reference Lease links the case to the lease it renews/adjusts. | Partial |
| REQ-51 | Case landowners: selection popup with Code, Land Owner, Owner Status (Owner / Buyer / Attorney…); case landowner list printed with Code, Name, NIC, Status. | SS-LOSEL ("Landowners" popup, "0 OWNER"); SS-CASENO "LANDOWNER DETAILS" | Owners with status are attached to a case and printed. | Implemented |
| REQ-52 | Lease details per line: Deh, Taluka, District, Block/Survey, Survey Share %, Total Area, Lease Area, Initial Tora Net Lease Area, Subsequent Tora Net Lease Area; plus remarks, Total lease area (A-G), Rate/acre/year, Lease term (months), Effective Date, Expiry Date, Total Lease Amount. | SS-CASENO, SS-CASECHG "LEASE DETAILS (Areas in Acres)" | Each line stores the three area figures; expiry = effective + term; printed exactly. | Partial |
| REQ-53 | Crop details per line: Deh, Taluka, District, Block/Survey, Owners Share %, Crop Type, Rate/Acre, Damage Area (acres), Amount; remarks; Total damage area (A-G); Crop amount. | SS-CASENO / SS-CASECHG "CROP DETAILS" | Crop amount = rate × damage area (× owners share where applicable). | Partial |
| REQ-54 | Tree details per line: Deh, Taluka, District, Block/Survey, Owners Share %, Tree (species + size e.g. BAIRI (LARGE), NIM, SHABAR (MEDIUM), BABOOL, KHABAR (DEVI)), Rate, Qty, Amount; remarks; Tree amount. | SS-CASENO / SS-CASECHG "TREE DETAILS" | Species list includes the species used in Sindh samples. | Partial |
| REQ-55 | Printable Compensation Case document (report c_case.rdf) with header, Landowner/Lease/Crop/Tree/Misc sections (with Deh/Taluka/District columns), section remarks, totals, Total Compensation Amount, and signature blocks: Initiated/Prepared By (with documents received), Reviewed by Legal Advisor, Checked by Negotiation Group, Verified by Senior Administrator LMS (Field), Approval 1, Approval 2. | SS-CASENO; SS-CASECHG | Printed case is field-for-field equivalent to the sample. | Partial |
| REQ-56 | Supporting documents received are recorded per case (original consent form in English & Sindhi/Urdu, measurement report, CNIC copies, Record of Rights Form A / VII-B, POA, DC report). | SS-CASENO/SS-CASECHG "INITIATED / PREPARED BY" notes; PROTO CASE_DOCS; EMAIL §3 | Case shows a checklist of received documents and they appear on the printed case. | Implemented |
| REQ-57 | A submitted case cannot be edited (cancel only); approved cases are locked. | PROTO WF.cases editOnlyFirst/noDeleteAfterSubmit (SoR Sc14) | Edits after the first stage are refused. | Implemented |
| REQ-58 | Changes to compensation being paid (e.g. Case No 7 re-issued 22-SEP-2024 with changed land use, lines and totals) are processed as a controlled amendment that keeps the earlier version. | SS-CASECHG vs SS-CASENO (same Case No 7, different data); EMAIL §2 (corrections via workflow) | An amended case has a new version, the old one remains viewable, and the amendment is approved through the workflow. | Partial |

## F. Leases, renewals, holds

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-07 | Lease register with start date, term, rate, escalation, expiry alerts (180/90/60/30 days) and reason-based holds. | PPSX slide 15; EMAIL §3; PROTO leaseInfo()/expiryBadge() | Leases show status bands and expiry alerts. | Partial |
| REQ-59 | Lease renewal requires an approval workflow before the renewal takes effect. | PPSX slide 15 ("approval workflow for renewal of leases") | A renewal request is created, approved by the designated approver, then applied. | Missing |
| REQ-60 | Hold and Release of lease renewals (pending approvals, documentation, operational hold) with statuses Active, Hold, Released. | PPSX slide 15 | A hold blocks renewal/payment of that lease only; release records reason; status history shows Active→Hold→Released. | Defective |
| REQ-61 | Lease start date entry and yearly renewal mechanism with automated tracking (per-year lease periods, e.g. "5 Aug 25 to 4 Aug 26"). | PPSX slide 15; CSV-REN ("Lease Period") | Each lease shows the current lease year, next due date and whether the year's rent was paid. | Partial |
| REQ-62 | Landowner Lease Details – Per Last Lease Renewal (screen Active_Leases_lse): Landowner code, Name & Father's name, Active lease (Y/N), Lease as Well/Project, Lease reference (no. of years), Last lease expiry date, Net lease area under company (Acres-Ghuntas), Subsequent net lease area after first year in case of reduction; Case # and status. | SS-LLREN; SS-LT2 | A screen/report lists each landowner's latest lease with these columns. | Partial |
| REQ-63 | Lease Agreement document: agreement number, date line, Lessor "XYZ S/O XYZ, resident of Deh/Taluka/District", Lessee company, recitals A-C with Survey Number(s), Deh, Taluka, District, Term (years, start, auto-extension), Rent per acre per annum in figures and words, payment clauses 2.2–2.3, schedule. | LAD (page 1); PROTO printAgreement() | Printed agreement reproduces the sample wording with the record's values. | Partial |
| REQ-64 | Lease escalation applied on each renewal. | PROTO SPEC.leases (Escalation % per renewal); EMAIL §3 (escalations) | Renewal raises the rate by the escalation %. | Implemented |

## G. Payments, liabilities & financial controls

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-65 | Payment Receipt document: "RECEIPT OF PAYMENT", reference REF-…, received from company, Cheque/Draft No and date, amount in figures and words, land area (A-G) and survey/block numbers in Deh/Taluka/District, Lease Agreement #; breakdown 1 Rental for 12 months (period), 2 Crop, 3 Tree, 4 Miscellaneous (one-time), 5 Others, Total; full-and-final settlement text; recipient name & NIC; date; two witnesses with NIC; revenue stamp/thumb area. | RCPT; PROTO printReceipt()/printReceiptUr() | For any released cheque the system prints the receipt with these fields and the payee signs it. | Missing |
| REQ-66 | After final approval TL Finance processes the cheque; each payment records Cheque No, Cheque Date, Delivery Date and Cheque Requisition #. | PPSX slides 11-13 ("TL Finance to process cheque"); FIN and PSR columns (Cheque No, Cheque Date, Delivery Date, Cheque Req. #) | Release is performed by TL Finance; delivery date and cheque requisition number are captured. | Partial |
| REQ-14 | Withholding tax by filer status (non-filer double rate) on landowner payments. | PROTO payOwners() (whtPct non-filer ×2) | Net = gross − WHT at the landowner's filer rate. | Implemented |
| REQ-15 | Duplicate-payment prevention and validation controls. | EMAIL §4; PROTO SPEC.payments.validate | A second live voucher for the same payee/category/period is refused; idempotent release. | Implemented |
| REQ-67 | One-time and recurring (yearly lease) compensation are distinguished in payments and reports. | EMAIL §4; RCPT (Rental for 12 months vs one-time heads) | Each voucher has a pay type and period. | Implemented |
| REQ-68 | Historical pending payments and 50% balance payments are tracked as liabilities with tranches (paid 50%, remaining 50%). | EMAIL §4; PPSX slide 13; WF50; SS-CASENO misc "PAST/PENDING LEASE PAYMENT" | Report shows each claim's original amount, paid tranche(s) and remaining balance. | Simulated |
| REQ-69 | Pending and outstanding liabilities, payment status, transaction history and reconciliation of figures to cases, approvals and payments. | EMAIL §4 | Approved − released = outstanding per case/project/landowner; reconciliation exceptions listed. | Implemented |
| REQ-70 | Project-wise and landowner-wise financial summaries. | EMAIL §4; CSV-PWS; CSV-LO (Total Amount, Total Paid) | Per project and per landowner totals of approved, paid and remaining. | Implemented |
| REQ-71 | Payment status summary by asset category (Lease Compressors, Lease Pipelines, Purchase Pipelines, Wells) and PR status with records, amount paid and remaining amount; project-wise summary by category and land status (Leased / Purchased) with area, lease payment, crop/compensation and total. | CSV-PS; CSV-PWS | Report reproduces these two summaries from transactional data. | Missing |
| REQ-72 | Reason-based payment holds and releases with remarks (including DBPFC / government-land payment hold and release). | EMAIL §3, §4 | Holds at landowner/survey/case/payment/project scope block release; lifting requires reason. | Implemented |
| REQ-09 | Government land reservation and DBPFC/DPFC process: application, revenue office, DPFC meeting & recommended rate, BOR reservation, payment hold/release, with remarks and responsible role. | EMAIL §4; CSV-DPFC (Case ID, Concession/Field, Project/Facility, Project Type, Project Date, Province, District, Taluka/Tehsil, Deh/Moza, Private Acquired/Leased, Government Land, Total Area, Govt Land Category, DPFC Case Ref, Meeting Date, Recommended Rate, DPFC Status, Revenue Office Status, BOR Reservation Status, Application Date, Next Action, Responsible Role) | Every CSV field has a home; statuses follow the 8 DPFC statuses. | Partial |

## H. Reports & documents

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-73 | Master-filter reporting by Landowner name → Land owner detail, Area in Acres, Compensation Paid, Project Category, Survey/Khasra/Land Parcel. | PPSX slide 16 | Choosing a landowner returns those columns. | Partial |
| REQ-74 | Master filter by CNIC. | PPSX slide 16 | Entering a CNIC returns the same column set. | Missing |
| REQ-75 | Master filter by Project → land owners, area, compensation paid, Survey/Khasra/parcel, ACTIVE / DE-LEASED. | PPSX slide 16 | Project filter shows lease active vs de-leased. | Partial |
| REQ-76 | Master filter by Survey / Block / Khasra / Land parcel number → land owners, area, compensation paid, project category. | PPSX slide 16 | Parcel filter works. | Missing |
| REQ-77 | Master filter by District / Taluka / Tehsil / Sub-Division / Sub-Tehsil / Deh / Mouza → land owner detail, area, compensation paid, project category, parcel. | PPSX slide 16 | Selecting any admin unit includes all parcels beneath it. | Missing |
| REQ-78 | Reports export to Excel and PDF (in addition to on-screen), with search, filters and sorting; exports are audited. | PPSX slide 16 ("exportable in standard formats (Excel/PDF)"); EMAIL §4 | Each report downloads as .xlsx and .pdf with the same rows and totals. | Partial |
| REQ-79 | Project Status Report (lmshnx03.rdf) per project: Lease File (e.g. DEMO-PL-001/0), Effective Date, Payee/Landowner (S/O father), Deh/Block/Survey, Area (acres A-G), Lease, Crop, Tree, Misc and Total Amounts, Cheque No, Cheque Date, Delivery Date, Cheque Req. #; totals row; header with company, "LAND MANAGEMENT SERVICES / PROJECT STATUS", Project Name, Report id, Page x/y, Print Date. | PSR (TAJJAL-4 Gas Pipeline – Government Land); FIN pages 1-2 (North Field Gas Pipeline Project); PROTO REPORTS r9 "Project status report (Sc 20)" | For a project the report lists every payee line with these columns and grand totals, exportable to PDF/Excel. | Missing |
| REQ-80 | Landowner Lease Details report (lmsthkx6a): per landowner — Lease, Status (Y/N), Landowner name S/O father, Lease Expiry Date, Initial Area and Subsequent Area in "n Acre(s) - n Ghunta(s)", Total row in A-G; header with date/time, report id, Page x of y. | SS-LLDR; SS-LR (same format, anonymised); PROTO REPORTS r8 "Landowner lease details (Sc 18)", printOwner() | Selecting a landowner prints this table. | Partial |
| REQ-81 | Report presentation conventions: system name, "LAND MANAGEMENT SERVICES", report id, page x of y, print date/time, totals row; amounts with Pakistani digit grouping (e.g. 1,38,000) and dates as DD-MON-YYYY. | PSR; FIN; SS-LLDR; RCPT | Printed/exported reports use these conventions. | Partial |
| REQ-82 | Reference prototype report catalogue: Acquired lands status, Acquisition progress, Lease land status, Government land status (incl. DBPFC), Financial commitments & liabilities, Complaints & IIR status, Encroachment risk exposure, Landowner lease details, Project status report, Landowner detail register, Landowner statement, Area (survey) statement, Budget statement, Payment register, Lease & ROW expiry schedule. | PROTO const REPORTS r1–r15 | Each prototype report has an equivalent in the application. | Partial |

## I. Reference datasets (CSV) & migration

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-83 | Landowner_Detail.csv (Landowner Name, CNIC No., No. of Records, Total Area Acres, Total Amount, Total Paid, Remarks) is migrated and its totals reconcile with the system. | CSV-LO (373 rows); EMAIL §1 | Per landowner, system record count/area/amount/paid equals the CSV. | Simulated |
| REQ-84 | Lease_Register.csv (Name, Area "n Acre n Ghunta", Survey No., Deh, Taluka, Project, Lease Start/End, Amount, Payment Date, CNIC, Area Acre, Area Ghunta, Total Area, Rate per Acre, Lease Payment, Crop/Compensation Amount, Misc Compensation, Amount Paid, Remarks) is migrated with leases, parcels, admin units and payments. | CSV-LR (638 rows) | Every column maps to a field; amounts paid become payments; Deh/Taluka become admin units. | Simulated |
| REQ-85 | Renewal.csv (incl. Lease Period "d Mon yy to d Mon yy", Lease Payment, Amount Paid) is migrated as renewals and yearly payments. | CSV-REN (445 rows) | Each renewal row creates a renewal and its rent payment for the stated period. | Partial |
| REQ-86 | Purchase_Acquired.csv is migrated as purchased (acquired) land with payment dates and amounts. | CSV-PA (166 rows) | Purchased parcels and their payments match the CSV. | Partial |
| REQ-87 | Sample DPFC Government Land.csv is migrated with all its fields and statuses. | CSV-DPFC (48 rows) | DBPFC records show the CSV areas, rates and statuses. | Simulated |
| REQ-88 | Project_Wise_Summary.csv and Payment_Status.csv totals reconcile with the migrated transactions (per category/project: records, area, lease payment, crop/compensation, total; per category: paid, remaining). | CSV-PWS (60 rows); CSV-PS (4 rows); EMAIL §11 (reconciliation during transition) | Reconciliation report shows zero or explained differences. | Missing |
| REQ-89 | Bulk data upload (Excel/CSV) with validation, preview, auto-codes, and progressive historical migration after go-live. | PROTO "DATA UPLOAD — Excel / CSV bulk import"; EMAIL §11 | Excel and CSV files can be staged, validated, previewed and promoted. | Partial |

## J. Versioning, audit, IAM & security

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-12 | Non-destructive versioning: every submitted/approved change creates a new version linked to the original record without overwriting history (version number, relation to original). | EMAIL §2 (Version Control and Audit Trail) | Prior versions of any record are retrievable with version numbers. | Partial |
| REQ-90 | Restoration of a previous version follows the authorised approval workflow with full auditability; access to version history is restricted to designated administrators. | EMAIL §2 | An authorised user can request "restore version n"; it is approved by another authorised user; both actions are audited. | Missing |
| REQ-13 | Audit history with user identity, timestamp, reason/remarks, before-and-after values, approval/rejection/restoration/admin actions. | EMAIL §2, §5, §7 | Every change and decision is in an append-only log. | Implemented |
| REQ-91 | Role-based access control with designation-based permissions; privileged administrator controls; user creation, modification, deactivation and access revocation; access reviews. | EMAIL §5; PROTO ROLES/GROUPS | Admin manages users/roles/positions; deactivation revokes sessions. | Implemented |
| REQ-92 | Separation of duties across data entry, verification, approval and administration. | EMAIL §5 | SoD rules refuse conflicting role/permission combinations and actions. | Implemented |
| REQ-93 | Audit logging of authentication, user management and privileged actions; report exports recorded. | EMAIL §5, §7 | Login, MFA, user/role changes and exports appear in the audit. | Implemented |
| REQ-94 | Microsoft Active Directory / SSO integration (validated approach), with dependencies and configuration responsibilities identified. | EMAIL §5 | Users sign in with corporate AD/Entra ID; group→role mapping works. | Partial |
| REQ-95 | Province-scoped data access (row-level security) so field users see only their province; Head Office consolidated view. | PROTO inCtx()/province screen; PPSX (province split) | Out-of-province records return 404/none. | Implemented |

## K. Non-functional, delivery & operations (email)

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-96 | Working interface on a demo database covering create, edit, save, retrieve and search across modules. | EMAIL §2 | Each module supports CRUD + search against PostgreSQL. | Implemented |
| REQ-97 | Performance and load-test evidence: response times, stability at volume, maximum supported concurrent users, scenarios, duration, bottlenecks; verified vs proposed separated. | EMAIL §2 | A report states measured p50/p95 at stated concurrency, max users, duration and bottlenecks. | Partial |
| REQ-98 | Separate UAT environment; entry/exit criteria, defect severity, retest and sign-off roles (Vendor / Mari IT / Land business users). | EMAIL §6 | UAT environment exists with documented process. | Partial |
| REQ-99 | Security controls and independent VAPT before go-live: encryption in transit/at rest, session timeout/invalidation, privileged account protection, patching, logging/retention; VAPT scope, timing, responsibilities. | EMAIL §7 | Controls documented and evidenced; VAPT plan agreed. | Partial |
| REQ-100 | Backup, disaster recovery and data portability with measurable RPO/RTO (tested vs contractual), restoration testing, document-storage coverage, export/archival. | EMAIL §8 | Backup/restore drill evidence and RPO/RTO stated. | Partial |
| REQ-101 | Unique, convention-following identifiers: landowner code, case number, lease file (project-seq/renewal, e.g. DEMO-PL-001/0, AKHR-001-8), request ID, voucher. | EMAIL §3 (unique landowner and case IDs, numbering conventions); FIN/PSR (Lease File); SS-LLDR (Lease AKHR-001-8) | Codes are unique, consistent and follow the agreed convention. | Partial |
| REQ-102 | Linked KML/KMZ uploads for cases/requests and ROW calculations (width × length). | EMAIL §3; WFPDF p2 (KMZ attachment) | A KML/KMZ can be attached to a case or request and shown on the map; ROW area computed. | Partial |
| REQ-08 | Right-of-Way (ROW) corridors: width × length area, tenure, yearly renewal alerts, stop, violations. | EMAIL §3; PROTO rowInfo() | ROW area and renewal dates computed. | Implemented |
| REQ-103 | Case- or project-specific escalations of overdue approvals. | EMAIL §3 | Overdue steps escalate to the next authority. | Partial |
| REQ-104 | Configurable dashboards (project, landowner, financial) with search, filters, sorting and export. | EMAIL §4; PROTO dashboard/projdash | Dashboards filter by province/project and export. | Partial |
| REQ-105 | APIs and SAP integration scope (data flows, interfaces, responsibilities). | EMAIL §9 | Payment release posts to SAP through a documented interface. | Partial |
| REQ-106 | Operational by 01 March 2027: day-one capabilities for new and ongoing cases; historical data migrated, reconciled and validated progressively after launch with integrity controls. | EMAIL §11 | Milestone plan and day-one scope agreed; reconciliation controls in place. | Partial |
| REQ-107 | Handover deliverables: source code, schema/data dictionary, deployment and configuration docs, backup/restore/migration procedures, admin training, warranty/support SLAs, cost clarifications. | EMAIL §10, §9 | Documents delivered. | Partial |
| REQ-108 | Every requirement's evidence is classified Demonstrated / Documented / Pending Validation / Not Available; compliance matrix mapped to the supplied references. | EMAIL §1, §12 | Matrix exists and statuses are evidence-based. | Partial |

## L. Reference prototype modules & UI expectations

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-109 | Province selection after login with Head-Office "All provinces" consolidated view; province chip to switch. | PROTO #prov screen, enterProvince('ALL') | User chooses a permitted province or HO view. | Implemented |
| REQ-110 | Unit converter available from the header and "use converted value" in area inputs. | PROTO openConverter()/useConverted() | Converter converts any listed unit. | Partial |
| REQ-111 | Acquisition & title process: Identification → Negotiation → Approval → Acquisition/Lease → Handover with title-completeness checklist. | PROTO WF.acquisitions, TITLE_CHECKS | Stages enforced; checklist recorded. | Implemented |
| REQ-05 | Deceased landowner: payments/cases blocked until succession mutation; mutation transfers shares to heirs and updates lessors. | PROTO applyMutation(), titleIssues() | Deceased owner cannot be paid; approved mutation moves shares. | Implemented |
| REQ-112 | Court cases with stay orders automatically block payments to affected landowners/surveys. | PROTO stayFor(), SPEC.legal | Release refused while a stay is in force. | Implemented |
| REQ-113 | Grievances / IIR and Encroachment / ROW violation registers with assignment, escalation and resolution workflows. | PROTO SPEC.grievances, SPEC.encroachments | Workflows advance with designated groups. | Implemented |
| REQ-114 | Budgets per project per year: approved vs committed vs spent vs balance, with budget check on payments. | PROTO SPEC.budgets | Budget utilisation shown; overspend flagged. | Implemented |
| REQ-115 | Documents repository linked to records, with access logging. | PROTO documents; EMAIL §3 (supporting documents) | Documents attach to records; downloads are logged. | Implemented |
| REQ-116 | Calendar of lease/ROW expiries, hearings and due dates; Approvals & Alerts inbox. | PROTO NAV calendar/inbox | Calendar and inbox list due items. | Implemented |
| REQ-117 | Approval matrix screen assigning positions/departments to each workflow step; strict segregation-of-duties setting. | PROTO MATRIX_DEFAULT, settings.sod | Admin edits step groups with history. | Implemented |
| REQ-118 | Printable consent form and Urdu/Sindhi payment receipt. | PROTO printConsent(), printReceiptUr(); SS-CASECHG ("ORIGINAL CONSENT IN ENGLISH & SINDHI") | Consent and vernacular receipt print from the record. | Missing |
| REQ-119 | Landowner-detail and lease screens show the selected row's Case # and Case Status in a footer. | LOD, SS-CHAT, SS-LOPCT, SS-LLREN (footer "Case # / Case Status") | Selecting a holding shows its case number and status. | Missing |
| REQ-120 | Responsive, accessible UI (keyboard, contrast, loading/empty/error states) with print stylesheets. | EMAIL §2 (interface testing); PROTO responsive layout | Screens pass axe checks on desktop and mobile. | Implemented |

## M. Technical requirements carried from the prior matrix

| ID | Requirement | Source | Acceptance notes | Status |
|---|---|---|---|---|
| REQ-06 | Land Acquisition Act 1894 lifecycle (Sections 4, 6, 9, 11). | GSD (source: requirments/lms_project_analysis.md — deleted from working tree; not in the 35 authoritative files) | — | Superseded |
| REQ-16 | GIS land map with streets/satellite layers, KML/KMZ/GeoJSON ingestion, parcel correlation. | PROTO GIS section (SoW §3.1); EMAIL §3 | Map shows parcels/projects; KML/KMZ upload works safely. | Implemented |
| REQ-17 | Strict Content Security Policy (nonce-based). | GSD | — | Implemented |
| REQ-18 | data-act event routing allowlist (static prototype). | GSD | — | Superseded |
| REQ-19 | Versioned forward-only PostgreSQL migrations with checksum drift check. | GSD; EMAIL §10 (schema documentation) | — | Partial |
| REQ-20 | Database routines for shares, conversion, workflow transitions, reconciliation. | GSD | — | Implemented |
| REQ-21 | Triggers for audit, version bump, financial consistency. | GSD | — | Implemented |
| REQ-22 | Province RLS policies. | GSD | — | Implemented |
| REQ-23 | Least-privilege DB roles. | GSD | — | Implemented |
| REQ-24 | Compliance traceability documents (OWASP ASVS, ISO 27001, SOC 2). | GSD | — | Implemented |
