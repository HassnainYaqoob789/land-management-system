# LMS Gap List (non-Implemented requirements)

> Generated 2026-10-30 by a read-only review of `requirments/` (35 files) and the working tree (Next.js `src/`, `db/migrations` 0001–0044, `tests/`, `db/tests`). Code is moving: other engineers were editing `src/` and `db/` during the review. Database facts come from read-only SQL on `lms_dev` (migrations applied to **0038**) and `lms_test` (0044). Statuses: Implemented | Partial | Missing | Simulated (fake/hardcoded/browser-only) | Defective | Superseded. REQ-01…REQ-24 keep their ids from `.gsd/REQUIREMENTS.md`; REQ-25 onward are new. Nothing in this review was run in a browser: UI claims marked "needs runtime verification" were not exercised.

Ordered by business impact (1 = blocks approval control / money / go-live; 5 = cosmetic), then Defective → Simulated → Missing → Partial. Superseded items are excluded.

76 gaps: Defective 5, Simulated 4, Missing 18, Partial 49


## Impact 1 — approval control, money, go-live blockers

### 1. REQ-36 — Defective: Approval order Initiator → Director Operations → Regional Manager (by concession/field) → DM/TL Land Affairs; each tier acted on only by a h…

- **Source:** WFPDF p1 §1, p2 §3 and §4.1-4.4
- **Gap:** On lms_dev (0038) any holder of requests:approve (roles case-approver, land-manager) can approve every tier; the route checks only the permission and the stage. 0042 (on disk; not applied to lms_dev) adds designation checks for the APPROVE columns only; no user holds Director Operations / Regional Manager / DM-TL Land Affairs; RM is not routed by concession.
- **Evidence:** src/app/api/requests/[id]/transition/route.ts:4 (protect requests:approve only), :65-101 (stage logic without designation); SQL iam.role_permission: requests:approve → case-approver, land-manager; db/migrations/0042_api_authorization.sql:1290-1325.
- **Smallest fix:** Apply 0042 to lms_dev; seed users holding the three positions; in the route pass the acting group and refuse when the actor lacks it (mirror api.advance_workflow p_as_group); add concession→RM mapping table.

### 2. REQ-42 — Defective: Compensation for new & ongoing projects (Lease, Crop, Trees, Structure, One-Time, Misc) is approved by designation in this order: Initiator …

- **Source:** PPSX slide 11 (media/image4.jpg); WFCC
- **Gap:** Configured chain is Prepared → Checked (Negotiation Group) → Reviewed (Legal Advisor) → Verified (Sr. Administrator LMS Field) → Field Approved (DM/TL Field) → HO Approved (Manager Land HO); payments Verified (Finance Officer) → Released (Manager Land HO). Regional Manager, Director OPS and TL Finance do not exist as approval groups or users (lms_dev and lms_test).
- **Evidence:** SQL: `SELECT * FROM lms.workflow_step_group WHERE workflow_code IN ('cases','payments')`; `SELECT code FROM lms.approval_group` → 9 groups, none of Regional Manager/Director OPS/TL Finance; db/migrations/0015_reference_data.sql:65-71, 194, 242-246.
- **Smallest fix:** Business decision first (REQ-48). Then migration: add approval groups TL/DM Land, Regional Manager, Director OPS, TL Finance; add a "cases_new_ongoing" stage set (Initiated→TL/DM Land→RM→Director OPS approved) and map payments Released → TL Finance via api.set_step_groups.

### 3. REQ-68 — Simulated: Historical pending payments and 50% balance payments are tracked as liabilities with tranches (paid 50%, remaining 50%).

- **Source:** EMAIL §4; PPSX slide 13; WF50; SS-CASENO misc "PAST/PENDING LEASE PAYMENT"
- **Gap:** No category or tranche model for past-pending/50% claims; report r6 selects vouchers by text heuristics (category ILIKE '%Pending%', remarks ILIKE '%50%', category 'Direct Purchase') — none of these categories exist, so the report is effectively empty or arbitrary.
- **Evidence:** src/app/api/analytics/reports/route.ts:332; SQL payment_category list has no pending/50% category.
- **Smallest fix:** Add payment category "Past Pending / Arrears" and a claim_tranche (pct, due, paid) on the case (REQ-44 type); rewrite r6 on that model.

### 4. REQ-43 — Missing: Flare-pit / flaring damage compensation and local complaints of crop damage after location hand-over (e.g. watercourse damage) follow: Initi…

- **Source:** PPSX slide 12 (media/image5.jpg); WFFP
- **Gap:** No flare-pit case type, no Manager Production designation, no separate stage chain.
- **Evidence:** Implementation located at: page /cases; API —; DB lms.workflow (no flare-pit workflow)
- **Smallest fix:** Add case_type on compensation_case and a workflow per type (lms.workflow rows "cases_flare_pit"), route by case_type in api.advance_workflow; add Manager Production group.

### 5. REQ-44 — Missing: Past pending claims and 50% remaining payments follow: Initiator → Advisor Land → TL/DM Land → TL Finance → Regional Manager → Director OPS …

- **Source:** PPSX slide 13 (media/image6.jpg, no CFO); WF50 (CFO after Director OPS)
- **Gap:** No past-pending/50% claim type, no Advisor Land / CFO / TL Finance designations, no workflow. Source conflict: WF50 JPG includes CFO, PPSX slide 13 does not.
- **Evidence:** Implementation located at: page /cases, /payments; API —; DB —
- **Smallest fix:** Confirm CFO step with Mari; then add case_type "Past pending / 50% balance" with its own workflow rows and groups (Advisor Land, TL Finance, CFO).

### 6. REQ-47 — Missing: Each compensation case is classified (New/Ongoing project head: Lease, Crop, Trees, Structure, One-Time, Misc; Flare-pit/crop-damage complai…

- **Source:** PPSX slides 11-13; EMAIL §3 (new/ongoing, historical cases)
- **Gap:** compensation_case has no case type; CaseForm has no type field; "Structure" exists only as free-text misc payment type.
- **Evidence:** src/components/cases/CaseForm.tsx (no flare/50%/type); SQL columns of lms.compensation_case.
- **Smallest fix:** Add case_type (FK lookup) + workflow_code derived from it; show in CaseForm and award sheet.

### 7. REQ-49 — Missing: Approvers can reject or return a case/payment for correction with mandatory remarks; corrections are resubmitted and re-approved.

- **Source:** EMAIL §2 ("approvals, rejections, corrections"), §3 ("correction and rejection remarks"); WFPDF p2 §4.2; PROTO canReturn()
- **Gap:** advance_workflow only moves forward one stage or to a terminal stage (Cancelled/Stopped); no return/reject-for-correction path; note is optional.
- **Evidence:** SQL pg_get_functiondef(api.advance_workflow): "stages advance one at a time"; src/app/api/cases/[id]/transition/route.ts:21 (to_stage, note, as_group only).
- **Smallest fix:** Add api.return_workflow(p_workflow, p_record, p_note NOT NULL) moving to the first stage, re-opening edits, logging action 'Returned'; require note for returns/rejections.

### 8. REQ-79 — Missing: Project Status Report (lmshnx03.rdf) per project: Lease File (e.g. DEMO-PL-001/0), Effective Date, Payee/Landowner (S/O father), Deh/Block/S…

- **Source:** PSR (TAJJAL-4 Gas Pipeline – Government Land); FIN pages 1-2 (North Field Gas Pipeline Project); PROTO REPORTS r9 "Project status report (Sc 20)"
- **Gap:** No such report: current r2/r9 are aggregates per project; delivery date and cheque requisition # are not stored (REQ-66); lease file numbering differs (REQ-101).
- **Evidence:** Implementation located at: page /reports; API /api/analytics/reports; DB —
- **Smallest fix:** Add report "Project Status (lmshnx03)" as a SQL view joining payment_request/payment_release to case lines by head (lease/crop/tree/misc) per payee; render with the PDF writer.


## Impact 2 — core business records, reports and controls

### 9. REQ-01 — Defective: Province-specific administrative hierarchy: Sindh Division→District→Taluka→Deh; Balochistan Division→District→Tehsil→Sub-Division→Sub-Tehsil…

- **Source:** PPSX slide 7 (table) and slide 8 (media/image3.jpg)
- **Gap:** No Division level in any province; Balochistan stored as District→Sub-Division→Tehsil→… and KPK as District→Sub-Division→Tehsil→Mouza, i.e. Tehsil and Sub-Division are swapped relative to slide 7/8 (unchanged in 0040–0044).
- **Evidence:** SQL lms_dev & lms_test: `SELECT province_code,string_agg(name,' > ' ORDER BY depth) FROM lms.province_level GROUP BY 1` → BAL "District > Sub-Division > Tehsil > Sub-Tehsil / Qanungo Halka > Mouza", KPK "District > Sub-Division > Tehsil > Mouza"; db/migrations/0015_reference_data.sql:21-25.
- **Smallest fix:** New migration: insert Division at depth 0 (shift depths) and reorder BAL/KPK to Tehsil→Sub-Division; re-parent existing admin_unit rows with a mapping script. Get Land Affairs to confirm the slide order first (prototype used the other order).

### 10. REQ-37 — Defective: Director Operations may approve or reject with mandatory remarks; a rejected request returns automatically to the original initiator for rev…

- **Source:** WFPDF p1 §1 ("If rejected — Return to original initiator"), p2 §4.2
- **Gap:** REJECT sets terminal "Rejected" (cannot be revised); RETURN exists but resubmission (APPROVE on Returned) can be done by any approver, not only the initiator; RM and Land Affairs can also reject/return although the PDF gives rejection to Director Ops.
- **Evidence:** src/app/api/requests/[id]/transition/route.ts:60-66 (REJECT→Rejected), :102-105 (Returned→Submitted by any approver).
- **Smallest fix:** Map Director-Ops REJECT to "Returned" with remarks; restrict resubmit to created_by; restrict reject/return to the Director Operations tier unless Mari confirms otherwise.

### 11. REQ-60 — Defective: Hold and Release of lease renewals (pending approvals, documentation, operational hold) with statuses Active, Hold, Released.

- **Source:** PPSX slide 15
- **Gap:** Placing a lease hold inserts a PROJECT-scope payment_hold, freezing every payment of the project, not just the lease; "Released" is not a retained status (only the last lift is kept, earlier holds overwritten).
- **Evidence:** src/app/api/leases/[id]/hold/route.ts:68-75 (scope 'project'), :84-95 (overwrites hold columns).
- **Smallest fix:** Use payment_hold scope 'lease' (add lease_id column / scope value) or check lease.is_on_hold in request_payment; record holds in a lease_hold history table.

### 12. REQ-83 — Simulated: Landowner_Detail.csv (Landowner Name, CNIC No., No. of Records, Total Area Acres, Total Amount, Total Paid, Remarks) is migrated and its tot…

- **Source:** CSV-LO (373 rows); EMAIL §1
- **Gap:** Ingestion keeps names but replaces every CNIC with a fabricated 45102-… value (all source CNICs are the placeholder 99999-0000001-1); record count, area, total amount and total paid are not loaded or reconciled.
- **Evidence:** scripts/ingest_reference_data.ts:170-173; SQL lms.migration_reconciliation count = 0.
- **Smallest fix:** Load CSV totals into lms.migration_reconciliation and report differences; keep placeholder CNICs flagged (data_provenance) instead of inventing valid-looking ones.

### 13. REQ-84 — Simulated: Lease_Register.csv (Name, Area "n Acre n Ghunta", Survey No., Deh, Taluka, Project, Lease Start/End, Amount, Payment Date, CNIC, Area Acre, …

- **Source:** CSV-LR (638 rows)
- **Gap:** Rate hard-coded to Rs 25,000/acre for all 638 leases; Deh/Taluka ignored (single synthetic Deh); Amount/Lease Payment/Crop/Misc/Amount Paid/Payment Date not loaded; lease end replaced by start+3y when invalid; owner falls back to the first landowner when not matched.
- **Evidence:** scripts/ingest_reference_data.ts:209-212, 245-256; SQL `SELECT rate_per_acre,count(*) FROM lms.lease GROUP BY 1` → 25000 × 638.
- **Smallest fix:** Rewrite ingestion through the existing staged import (lms.import_batch → validate → promote) with explicit column mapping and rejects instead of defaults.

### 14. REQ-87 — Simulated: Sample DPFC Government Land.csv is migrated with all its fields and statuses.

- **Source:** CSV-DPFC (48 rows)
- **Gap:** All 48 rows were loaded with area 12.50, estimated/fixed rate 150,000 and stage "Rate Fixed", ignoring the CSV values; extra CSV fields have no columns (REQ-09).
- **Evidence:** scripts/ingest_reference_data.ts:321-327; SQL dbpfc_estimate group by area/rate/stage → (12.5,150000,Rate Fixed) × 48.
- **Smallest fix:** After REQ-09 columns exist, re-ingest from CSV through the import pipeline.

### 15. REQ-59 — Missing: Lease renewal requires an approval workflow before the renewal takes effect.

- **Source:** PPSX slide 15 ("approval workflow for renewal of leases")
- **Gap:** Renewal is applied immediately by anyone with leases:update (data-entry roles lack it, case-approver/land-manager have it); no renewal approval step.
- **Evidence:** src/app/api/leases/[id]/renew/route.ts:4 (protect leases:update), :73-95 (immediate insert/update).
- **Smallest fix:** Insert lease_renewal rows with status Pending; apply term/rate only on approval by Manager Land (or designated group) via advance_workflow-style routine with SoD.

### 16. REQ-65 — Missing: Payment Receipt document: "RECEIPT OF PAYMENT", reference REF-…, received from company, Cheque/Draft No and date, amount in figures and word…

- **Source:** RCPT; PROTO printReceipt()/printReceiptUr()
- **Gap:** Receipts can only be recorded (receipt no, date, acknowledged by/CNIC); no printable receipt document, no amount-in-words, no breakdown by head, no Urdu/Sindhi version.
- **Evidence:** src/app/payments/page.tsx:332-345 (record receipt dialog only); grep "RECEIPT OF PAYMENT" in src → none.
- **Smallest fix:** Add printReceipt(release) using printDocument (as leases/cases do) fed by /api/payments?view=releases + case totals proportion.

### 17. REQ-74 — Missing: Master filter by CNIC.

- **Source:** PPSX slide 16
- **Gap:** No cnic parameter in the reports API.
- **Evidence:** src/app/api/analytics/reports/route.ts:22-30 (params: report, project, landowner, province, land_class, status, from, to, unit).
- **Smallest fix:** Add cnic filter to the master-filter view (respect pii masking).

### 18. REQ-76 — Missing: Master filter by Survey / Block / Khasra / Land parcel number → land owners, area, compensation paid, project category.

- **Source:** PPSX slide 16
- **Gap:** No survey/parcel filter in the reports API.
- **Evidence:** Implementation located at: page —; API —; DB —
- **Smallest fix:** Add survey_no/block filter to the master-filter view.

### 19. REQ-77 — Missing: Master filter by District / Taluka / Tehsil / Sub-Division / Sub-Tehsil / Deh / Mouza → land owner detail, area, compensation paid, project …

- **Source:** PPSX slide 16
- **Gap:** Only province filter; no admin-unit filter.
- **Evidence:** Implementation located at: page —; API —; DB —
- **Smallest fix:** Filter on lms.admin_unit_lineage (ancestor id) in the view.

### 20. REQ-88 — Missing: Project_Wise_Summary.csv and Payment_Status.csv totals reconcile with the migrated transactions (per category/project: records, area, lease …

- **Source:** CSV-PWS (60 rows); CSV-PS (4 rows); EMAIL §11 (reconciliation during transition)
- **Gap:** No reconciliation of the summary CSVs; category/land status not modelled (REQ-71).
- **Evidence:** Implementation located at: page —; API —; DB lms.migration_reconciliation (empty)
- **Smallest fix:** Load both CSVs as control totals into migration_reconciliation and compare.

### 21. REQ-07 — Partial: Lease register with start date, term, rate, escalation, expiry alerts (180/90/60/30 days) and reason-based holds.

- **Source:** PPSX slide 15; EMAIL §3; PROTO leaseInfo()/expiryBadge()
- **Gap:** See REQ-59..REQ-62 for renewal approval, hold scope and status gaps.
- **Evidence:** Implementation located at: page /leases, /calendar, /inbox; API /api/leases; DB lms.lease, api.v_lease_register (0025), api.v_lease_expiry_alert
- **Smallest fix:** —

### 22. REQ-09 — Partial: Government land reservation and DBPFC/DPFC process: application, revenue office, DPFC meeting & recommended rate, BOR reservation, payment h…

- **Source:** EMAIL §4; CSV-DPFC (Case ID, Concession/Field, Project/Facility, Project Type, Project Date, Province, District, Taluka/Tehsil, Deh/Moza, Private Acquired/Leased, Government Land, Total Area, Govt Land Category, DPFC Case Ref, Meeting Date, Recommended Rate, DPFC Status, Revenue Office Status, BOR Reservation Status, Application Date, Next Action, Responsible Role)
- **Gap:** Stages only Estimated / Referred to DBPFC / Rate Fixed / Stopped. Missing: concession, taluka/deh, private-acquired vs private-leased vs government area split, government-land category, revenue-office status, BOR reservation status, application date, next action, responsible role, the 8 DPFC statuses.
- **Evidence:** Implementation located at: page /dbpfc; API /api/dbpfc; DB lms.dbpfc_estimate, dbpfc_survey, dbpfc_rate_history (0033)
- **Smallest fix:** Migration adding these columns (+ lookup tables for the three status families) to dbpfc_estimate; re-ingest CSV-DPFC.

### 23. REQ-106 — Partial: Operational by 01 March 2027: day-one capabilities for new and ongoing cases; historical data migrated, reconciled and validated progressive…

- **Source:** EMAIL §11
- **Gap:** Plan exists in .gsd/ROADMAP.md; reconciliation controls unused (REQ-88); designation workflows (REQ-42..44) are day-one blockers.
- **Evidence:** Implementation located at: page —; API —; DB lms.migration_reconciliation, data_provenance
- **Smallest fix:** Gate go-live on REQ-42/43/44/49/79/65.

### 24. REQ-12 — Partial: Non-destructive versioning: every submitted/approved change creates a new version linked to the original record without overwriting history …

- **Source:** EMAIL §2 (Version Control and Audit Trail)
- **Gap:** Row snapshots exist; business records are still updated in place (no parent/child record versions) — acceptable if snapshots are the version store; see REQ-90 for restore.
- **Evidence:** Implementation located at: page /audit (Version Snapshots); API /api/audit; DB audit.record_version, api.v_record_version_history (0032), version columns
- **Smallest fix:** —

### 25. REQ-35 — Partial: Land lease request capture with mandatory fields: auto Request ID, Initiator/Department, system Request Date, Project/Well, Concession/Field…

- **Source:** WFPDF p1 §2 table, p2 table
- **Gap:** Missing: Initiator department field, District/Taluka (only free-text target_deh), Requirement Type, attachments (no document link), Concession defaults to literal "Mari Concession"; Purpose uses land_use lookup without Rig Camp / Flare Pit / Facility.
- **Evidence:** db/migrations/0024_land_lease_request.sql:8-40; src/app/api/requests/route.ts:105-121; src/app/requests/page.tsx:206-210; SQL land_use = Well Location|Access Road|Pipeline ROW|Flowline|Camp|Water Pond|Compressor Station|Other.
- **Smallest fix:** Migration: add requirement_type (CHECK new/extension/additional), department, admin_unit_id (Deh/Mouza FK, derive district/taluka), drop the concession default; add Rig Camp/Flare Pit/Facility to land_use; allow lms.document entity "land_request".

### 26. REQ-45 — Partial: Approver designations are province-specific (TL/DM Land, Regional Manager, Manager Production, TL Finance for Sindh / Balochistan / Punjab /…

- **Source:** PPSX slides 11-13; WFCC, WFFP, WF50 (each box labelled "Sindh/Balochistan/Punjab & KPK")
- **Gap:** Province scoping exists (RLS + province-scoped permissions), so a field approver only sees own province; but the designations themselves are missing (REQ-42/43/44).
- **Evidence:** Implementation located at: page —; API —; DB lms.app_user_group, lms.app_user_province, iam.role_permission.scope_level
- **Smallest fix:** Create the designations as approval groups and assign per-province users; existing province scope then enforces the province split.

### 27. REQ-48 — Partial: Oracle LMS sign-off chain on the case form — Prepared By, Checked By, Reviewed By, Verified By, Checked in Khi, Approved By, each with name …

- **Source:** SS-RIGHTS; SS-LOSEL; SS-PROJ; SS-CASENO signature blocks (Initiated/Prepared, Reviewed by Legal Advisor, Checked by Negotiation Group, Verified by Sr. Administrator LMS (Field), Approval 1, Approval 2)
- **Gap:** Prepared/Checked/Reviewed/Verified/Field Approved/HO(Kharat) Approved exist with group enforcement and SoD; "Checked in Khi" step is missing; per-step remarks are optional notes. Conflict with REQ-42: Mari must decide whether these sign-offs precede or replace the designation chain of slide 11.
- **Evidence:** Implementation located at: page /cases; API /api/cases/[id]/transition; DB lms.workflow_stage (cases), lms.workflow_transition.note / acted_as_group
- **Smallest fix:** Record the business decision in .gsd/DECISIONS.md; if both apply, model Oracle sign-offs as checks inside TL/DM Land stage and the PPSX designations as the approval stages; add "Checked in Khi" stage.

### 28. REQ-55 — Partial: Printable Compensation Case document (report c_case.rdf) with header, Landowner/Lease/Crop/Tree/Misc sections (with Deh/Taluka/District colu…

- **Source:** SS-CASENO; SS-CASECHG
- **Gap:** Award sheet omits Deh/Taluka/District columns, Total Area / Initial Tora columns, section remarks, effective/expiry dates, concession/delivery unit, documents-received list, total damage area, A-G areas; signature blocks are stage names rather than the sample captions.
- **Evidence:** src/app/cases/page.tsx:52-100 (awardSheetHtml).
- **Smallest fix:** Rework awardSheetHtml to the c_case.rdf layout using fields already returned by /api/cases?id= plus survey admin path (api.v_admin_unit_path).

### 29. REQ-58 — Partial: Changes to compensation being paid (e.g. Case No 7 re-issued 22-SEP-2024 with changed land use, lines and totals) are processed as a control…

- **Source:** SS-CASECHG vs SS-CASENO (same Case No 7, different data); EMAIL §2 (corrections via workflow)
- **Gap:** Only lump-sum award adjustments after HO approval (0043, not applied to lms_dev); no line-level amendment that re-enters the approval chain.
- **Evidence:** Implementation located at: page —; API —; DB api.adjust_case + lms.case_adjustment (0043, amount-only, on disk; lms_test)
- **Smallest fix:** Allow "amend" to clone an approved case as version n+1 (parent_case_id) in the first stage; on approval supersede the parent.

### 30. REQ-66 — Partial: After final approval TL Finance processes the cheque; each payment records Cheque No, Cheque Date, Delivery Date and Cheque Requisition #.

- **Source:** PPSX slides 11-13 ("TL Finance to process cheque"); FIN and PSR columns (Cheque No, Cheque Date, Delivery Date, Cheque Req. #)
- **Gap:** Release is assigned to Manager Land (HO) and verification to Finance Officer; no delivery date or cheque requisition number columns.
- **Evidence:** SQL workflow_step_group payments: Verified→Finance Officer, Released→Manager Land (HO); payment_release columns.
- **Smallest fix:** Add delivered_on and cheque_req_no to payment_release (or receipt); re-map Released step to a TL Finance group once created.

### 31. REQ-73 — Partial: Master-filter reporting by Landowner name → Land owner detail, Area in Acres, Compensation Paid, Project Category, Survey/Khasra/Land Parcel…

- **Source:** PPSX slide 16
- **Gap:** landowner filter exists on some reports; no report returns the slide-16 column set (area + compensation paid + project category + parcel) per landowner.
- **Evidence:** Implementation located at: page /reports; API /api/analytics/reports (landowner param); DB —
- **Smallest fix:** One "Master filter" report over a view (landowner, CNIC, project, category, active/de-leased, parcel, admin path, area, paid).

### 32. REQ-75 — Partial: Master filter by Project → land owners, area, compensation paid, Survey/Khasra/parcel, ACTIVE / DE-LEASED.

- **Source:** PPSX slide 16
- **Gap:** Project filter exists; no ACTIVE/DE-LEASED attribute (terminated_on exists but not reported as De-leased).
- **Evidence:** Implementation located at: page —; API /api/analytics/reports (project); DB —
- **Smallest fix:** Expose lease_status Active/De-leased (terminated_on or expired) in the view.

### 33. REQ-78 — Partial: Reports export to Excel and PDF (in addition to on-screen), with search, filters and sorting; exports are audited.

- **Source:** PPSX slide 16 ("exportable in standard formats (Excel/PDF)"); EMAIL §4
- **Gap:** Only CSV is served; src/lib/export/xlsx.ts and pdf.ts exist but no route uses them (import only in tests).
- **Evidence:** src/app/api/analytics/reports/route.ts:670 (format === 'csv' only); grep "lib/export" → tests only.
- **Smallest fix:** Add format=xlsx|pdf branches calling writeXlsx/renderPdf (already tested) and keep the existing export audit event.

### 34. REQ-80 — Partial: Landowner Lease Details report (lmsthkx6a): per landowner — Lease, Status (Y/N), Landowner name S/O father, Lease Expiry Date, Initial Area …

- **Source:** SS-LLDR; SS-LR (same format, anonymised); PROTO REPORTS r8 "Landowner lease details (Sc 18)", printOwner()
- **Gap:** Landowner statement is a financial statement of account, not the lease-details table; r8 is a lease register without initial/subsequent A-G and totals.
- **Evidence:** src/app/landowners/page.tsx:24-40 (statementHtml columns Date/Entry/Reference/Description/Amount).
- **Smallest fix:** Add the lease-details band to statementHtml (data already in v_lease_register: initial_area, current_area, end_date) with ag() formatting and totals.


## Impact 3 — important functional completeness

### 35. REQ-39 — Missing: Automatic system / e-mail notifications at approval, rejection and assignment stages (land requests and other workflows).

- **Source:** WFPDF p2 §4.5; EMAIL §2 (process approvals); PROTO notifyNext()
- **Gap:** No routine or route inserts into lms.notification; no workflow e-mail (mailer used only by IAM). Inbox shows pending assignments only.
- **Evidence:** SQL: `SELECT count(*) FROM pg_proc WHERE prosrc ILIKE '%insert into lms.notification%'` → 0; lms.notification empty.
- **Smallest fix:** AFTER INSERT trigger on lms.workflow_transition and land_request stage change → insert notification rows for holders of the next step group and the initiator; e-mail via existing src/lib/iam/mailer.ts outbox.

### 36. REQ-71 — Missing: Payment status summary by asset category (Lease Compressors, Lease Pipelines, Purchase Pipelines, Wells) and PR status with records, amount …

- **Source:** CSV-PS; CSV-PWS
- **Gap:** Asset category (Lease vs Purchase × Compressor/Pipeline/Well) and land status are not modelled (ingestion maps category to project type only, ignores Land Status); no PR status; no such report.
- **Evidence:** scripts/ingest_reference_data.ts:122-132.
- **Smallest fix:** Add project.asset_category + land_status columns (lookup) and a summary report grouped by them.

### 37. REQ-90 — Missing: Restoration of a previous version follows the authorised approval workflow with full auditability; access to version history is restricted t…

- **Source:** EMAIL §2
- **Gap:** No restore action anywhere (no route/routine).
- **Evidence:** grep restore_version/restoreVersion in src and db/migrations → none.
- **Smallest fix:** api.request_restore(record, version, reason) creating a pending change that an admin approves (SoD), applying the snapshot.

### 38. REQ-100 — Partial: Backup, disaster recovery and data portability with measurable RPO/RTO (tested vs contractual), restoration testing, document-storage covera…

- **Source:** EMAIL §8
- **Gap:** backup.sh verify passed at dev scale (RELEASE_ASSESSMENT:36); RPO/RTO not measured; document storage backup not covered.
- **Evidence:** Implementation located at: page —; API —; DB db/tools/backup.sh
- **Smallest fix:** Time a restore of a production-size dump; state RPO from WAL archiving config.

### 39. REQ-101 — Partial: Unique, convention-following identifiers: landowner code, case number, lease file (project-seq/renewal, e.g. DEMO-PL-001/0, AKHR-001-8), req…

- **Source:** EMAIL §3 (unique landowner and case IDs, numbering conventions); FIN/PSR (Lease File); SS-LLDR (Lease AKHR-001-8)
- **Gap:** Codes are unique but inconsistent: landowners LND-00001 (370, ingestion) vs SND-000001 (seed); leases LSE-000001 (ingestion) vs LSE-00001; no project-based lease file numbering with renewal suffix.
- **Evidence:** SQL: landowner prefixes LND 370 / SND 6 / BAL 2 / KPK 1 / PNJ 1; lease code lengths 10 (638) and 9 (2).
- **Smallest fix:** Decide one convention with Mari; generate lease file no as <project>-<seq>/<renewal_no> (view or stored column).

### 40. REQ-102 — Partial: Linked KML/KMZ uploads for cases/requests and ROW calculations (width × length).

- **Source:** EMAIL §3; WFPDF p2 (KMZ attachment)
- **Gap:** KML/KMZ is linked to projects only, not to cases or land requests. 513 survey polygons in lms_dev are synthetic 80 m boxes labelled source_file "Survey_Master_Cadastre.kml".
- **Evidence:** scripts/ingest_reference_data.ts:451-478.
- **Smallest fix:** Allow case_id/request_id on project_kml_import; mark synthetic geometries via data_provenance or remove them.

### 41. REQ-27 — Partial: Province unit sets: Sindh Acre→Ghunta→Sq Ft; Balochistan Acre→Rod→Pole→Sq Ft; Punjab and KPK Acre→Kanal→Marla→Sq Ft; International Acre→Deci…

- **Source:** PPSX slide 3 (table), slide 4 image2.jpg; MUJPG
- **Gap:** lms_dev (at 0038): SND Acre/Jireb/Ghunta, KPK Acre/Kanal/Bigha, no Sq Ft anywhere. 0040 (applied only to lms_test) adds Sq Ft and KPK Marla but keeps Jireb/Bigha (flagged legacy_prototype). No "Decimal"/"Acreage" unit for International.
- **Evidence:** SQL lms_dev: province_unit KPK "Acre, Kanal, Bigha"; lms_test KPK "Acre, Kanal, Bigha(legacy_prototype), Marla, Square Feet".
- **Smallest fix:** Apply 0040 to lms_dev; hide legacy_prototype units from pickers; add Decimal (1/100 acre) when REQ-25 is built.

### 42. REQ-28 — Partial: Areas on Sindh documents and reports are expressed as Acre–Ghunta ("A - G", 40 Ghunta = 1 Acre), e.g. "13 Acre(s) - 22 Ghunta(s)", totals "3…

- **Source:** SS-CASENO, SS-CASECHG (Lease/Crop details, totals); SS-LLDR; FIN p1-2 "Area (acres)"; RCPT ("2 - 9 acres"); PROTO ag()
- **Gap:** api.acre_ghunta exists and cases API returns lease_area_acre_ghunta, but the award sheet, lease deed and reports print decimal acres (fmtNum(..,4)).
- **Evidence:** src/app/cases/page.tsx:79-82 (fmtNum lease_area 4 dp); src/app/leases/page.tsx:43 (fmtNum(area,4) acres).
- **Smallest fix:** Add an `ag()` formatter in src/lib/domain.ts (reuse api.acre_ghunta semantics) and use it for SND rows in award sheet, lease deed, receipts and SoR-format reports.

### 43. REQ-33 — Partial: Landowner Detail register (screen c_owner_base_dta): Landowner code, Name/Father's name, CNIC, Location/Project, No. of leases renewed (year…

- **Source:** LOD; SS-CHAT (variant with Well/Contract ID, Area, Active Status); SS-LOPCT
- **Gap:** r4 has Owner code, name, CNIC, filer, survey no, area, share %, apportioned area only. Missing: father's name, project/well-contract ID, Deh/Taluka, leases-renewed count, active/file status, payment type, case #/status.
- **Evidence:** src/app/api/analytics/reports/route.ts r4 cols (line ~220).
- **Smallest fix:** Add an SoR-format "Landowner Detail" report backed by a view joining survey_ownership_share → survey path → lease_lessor/lease_renewal count → case_owner/case lines (payment type) → latest case code/stage.

### 44. REQ-40 — Partial: Initiator and authorised management can see current status and the responsible officer; all subsequent actions (survey, verification, negoti…

- **Source:** WFPDF p2 §4.7, §4.8, scope note
- **Gap:** Shows pending role, not officer; only survey/lease allocation link; compensation_case, payment_request have no request_id; no duplicate check.
- **Evidence:** Implementation located at: page /requests; API /api/requests; DB lms.land_request.allocated_survey_id / allocated_lease_id
- **Smallest fix:** Add nullable request_id FK to compensation_case/acquisition/payment_request; partial unique index on (project_id, purpose, admin_unit) for open requests; resolve officer names from app_user_group.

### 45. REQ-46 — Partial: Approval workflows are configurable: approvers per step and (later) new workflows such as International Boundaries / Offshore compensation c…

- **Source:** PPSX slide 10 (notes: workflow tentative; international/offshore not defined; flexible architecture)
- **Gap:** Approver groups per stage are configurable with history; stages and workflows themselves are fixed by migrations and compensation_case.workflow_code is a generated constant 'cases', so a second compensation workflow cannot be configured.
- **Evidence:** SQL \d lms.compensation_case: workflow_code generated always as ('cases').
- **Smallest fix:** Make workflow_code a normal column chosen from case_type (REQ-47); expose stage CRUD for non-locked workflows to System Administrator with audit.

### 46. REQ-52 — Partial: Lease details per line: Deh, Taluka, District, Block/Survey, Survey Share %, Total Area, Lease Area, Initial Tora Net Lease Area, Subsequent…

- **Source:** SS-CASENO, SS-CASECHG "LEASE DETAILS (Areas in Acres)"
- **Gap:** Only two area figures (lease_area, subsequent_area); "Initial Tora net lease area" is not separate from lease area; expiry date is not stored or printed; Deh/Taluka/District not on the line print.
- **Evidence:** Implementation located at: page /cases; API /api/cases; DB lms.case_lease_line (survey_share_pct, lease_area, subsequent_area), compensation_case (lease_rate, lease_term_months, effective_date), lms.case_term() (0043)
- **Smallest fix:** Add initial_tora_area to case_lease_line (default = lease_area); compute expiry with lms.case_term; extend award sheet (REQ-55).

### 47. REQ-61 — Partial: Lease start date entry and yearly renewal mechanism with automated tracking (per-year lease periods, e.g. "5 Aug 25 to 4 Aug 26").

- **Source:** PPSX slide 15; CSV-REN ("Lease Period")
- **Gap:** Expiry tracking exists; no per-year rent-due schedule linking lease years to Lease Rent payments (lease period of Renewal.csv not stored).
- **Evidence:** Implementation located at: page /leases, /calendar; API —; DB lms.lease (start_date, term_years, end_date), lms.lease_renewal, v_lease_expiry_alert
- **Smallest fix:** View api.v_lease_year_due generating yearly periods from start_date and left-joining payment_request(period_from/to).

### 48. REQ-62 — Partial: Landowner Lease Details – Per Last Lease Renewal (screen Active_Leases_lse): Landowner code, Name & Father's name, Active lease (Y/N), Lease…

- **Source:** SS-LLREN; SS-LT2
- **Gap:** r8 gives lease code, project, lessors, area, dates, rent, renewal count, hold; missing father's name, Y/N active flag, A-G areas, initial vs subsequent area split.
- **Evidence:** Implementation located at: page /leases, /reports r8; API /api/leases, report r8; DB api.v_lease_register
- **Smallest fix:** Add SoR-format view over v_lease_register + lease_lessor + landowner with initial_area/subsequent_area in A-G.

### 49. REQ-63 — Partial: Lease Agreement document: agreement number, date line, Lessor "XYZ S/O XYZ, resident of Deh/Taluka/District", Lessee company, recitals A-C w…

- **Source:** LAD (page 1); PROTO printAgreement()
- **Gap:** Lessor printed without S/O and residence; survey numbers printed as internal parcel codes without Deh/Taluka/District; rent not in words; area in decimal acres.
- **Evidence:** src/app/leases/page.tsx:21-48 (leaseDeedHtml uses l.lessors, l.parcels).
- **Smallest fix:** Return lessor father_name and survey admin path from /api/leases?id=; add amount-in-words helper (prototype words()).

### 50. REQ-82 — Partial: Reference prototype report catalogue: Acquired lands status, Acquisition progress, Lease land status, Government land status (incl. DBPFC), …

- **Source:** PROTO const REPORTS r1–r15
- **Gap:** Application r1–r15 is a different analytical set; no equivalents for Landowner lease details, Project status, Landowner detail register, Area statement, Budget statement, Payment register, Complaints, Encroachment risk. DB routine api.report_payment_register exists but no UI uses it.
- **Evidence:** Implementation located at: page /reports; API /api/analytics/reports r1–r15; DB api.report_payment_register, api.report_compensation_summary (unused by UI)
- **Smallest fix:** Add the SoR-format reports (REQ-79/80/33) and wire api.report_payment_register as a report; map remaining prototype reports or record them as superseded in DECISIONS.md.

### 51. REQ-85 — Partial: Renewal.csv (incl. Lease Period "d Mon yy to d Mon yy", Lease Payment, Amount Paid) is migrated as renewals and yearly payments.

- **Source:** CSV-REN (445 rows)
- **Gap:** Counts match; mapping fidelity (periods, amounts, link to the correct lease) not reconciled (no reconciliation rows).
- **Evidence:** Implementation located at: page —; API —; DB lms.lease_renewal (445), payment_request Lease Rent (446)
- **Smallest fix:** Add reconciliation queries (count/amount by project) to migration_reconciliation.

### 52. REQ-86 — Partial: Purchase_Acquired.csv is migrated as purchased (acquired) land with payment dates and amounts.

- **Source:** CSV-PA (166 rows)
- **Gap:** Payments created with a fixed period 2025-01-01..2025-12-31 instead of the CSV Payment Date; province forced to SND.
- **Evidence:** scripts/ingest_reference_data.ts:416, 432.
- **Smallest fix:** Map Payment Date to period_from/cheque_date; derive province from Deh.

### 53. REQ-89 — Partial: Bulk data upload (Excel/CSV) with validation, preview, auto-codes, and progressive historical migration after go-live.

- **Source:** PROTO "DATA UPLOAD — Excel / CSV bulk import"; EMAIL §11
- **Gap:** Accepts .csv/.json only (no .xlsx).
- **Evidence:** src/app/import/page.tsx:145 accept=".csv,.json".
- **Smallest fix:** Parse .xlsx client-side (SheetJS already vendored in the prototype) into the same CSV staging path.

### 54. REQ-94 — Partial: Microsoft Active Directory / SSO integration (validated approach), with dependencies and configuration responsibilities identified.

- **Source:** EMAIL §5
- **Gap:** OIDC/SAML implemented and tested against a test IdP; no provider configured in lms_dev; not validated against Mari AD.
- **Evidence:** Implementation located at: page /login; API /api/auth/oidc/*, /api/auth/saml/*, /api/auth/sso/*; DB iam.auth_provider (0 rows), iam.group_mapping, iam.external_identity
- **Smallest fix:** Configure an Entra ID test tenant provider and record the validation in docs.

### 55. REQ-97 — Partial: Performance and load-test evidence: response times, stability at volume, maximum supported concurrent users, scenarios, duration, bottleneck…

- **Source:** EMAIL §2
- **Gap:** docs/RELEASE_ASSESSMENT_2026-10-29.md:89 reports 1/10/25-user p50/p95; no maximum-concurrent-users finding, soak duration or stability result.
- **Evidence:** Implementation located at: page —; API —; DB db/tools/perf.py, perf_load.sql
- **Smallest fix:** Run a stepped load test to saturation and a 1-hour soak; append to the assessment.

### 56. REQ-98 — Partial: Separate UAT environment; entry/exit criteria, defect severity, retest and sign-off roles (Vendor / Mari IT / Land business users).

- **Source:** EMAIL §6
- **Gap:** Only databases (lms_test) — no documented UAT deployment, criteria or sign-off matrix found in docs/.
- **Evidence:** Implementation located at: page —; API —; DB lms_test database (0044)
- **Smallest fix:** Write docs/UAT_PLAN.md and provision a UAT deployment.

### 57. REQ-99 — Partial: Security controls and independent VAPT before go-live: encryption in transit/at rest, session timeout/invalidation, privileged account prote…

- **Source:** EMAIL §7
- **Gap:** docs/SECURITY_ARCHITECTURE.md, OWASP_ASVS_TRACEABILITY.md exist; VAPT scanner archived; no third-party VAPT plan.
- **Evidence:** Implementation located at: page —; API —; DB —
- **Smallest fix:** Document VAPT scope/responsibility; restore automated scanner into CI.


## Impact 4 — secondary functions

### 58. REQ-118 — Missing: Printable consent form and Urdu/Sindhi payment receipt.

- **Source:** PROTO printConsent(), printReceiptUr(); SS-CASECHG ("ORIGINAL CONSENT IN ENGLISH & SINDHI")
- **Gap:** No consent-form or vernacular receipt print in src/app.
- **Evidence:** Implementation located at: page —; API —; DB —
- **Smallest fix:** Port printConsent/printReceiptUr templates using printDocument.

### 59. REQ-25 — Missing: International jurisdiction: hierarchy Federal Authority→Local Autonomy→Regions/Municipalities, revenue key "Block No / Land Parcel"; Distric…

- **Source:** PPSX slide 7 (INTERNATIONAL row), slide 8 image3.jpg; SS-DIST (Pakistan/International dropdown)
- **Gap:** lms.province has only SND/BAL/PNJ/KPK; no country/international flag, no international levels or key label.
- **Evidence:** SQL: `SELECT code FROM lms.province` → BAL,KPK,PNJ,SND.
- **Smallest fix:** Add province row INT (or a country column) with levels Federal Authority / Local Autonomy / Regions-Municipalities and key label "Block No / Land Parcel"; keep it disabled for workflows until offshore/international workflow is defined (slide 10).

### 60. REQ-34 — Missing: Payment type per landowner holding (LAND / CROP / TREE / MISC) is recorded and reportable.

- **Source:** LOD and SS-LOPCT ("Payment Type" column)
- **Gap:** No stored or derived payment-type attribute on holdings; no report column.
- **Evidence:** Implementation located at: page —; API —; DB derivable from case_lease_line / case_crop_line / case_tree_line / case_misc_line
- **Smallest fix:** Derive in the REQ-33 view (EXISTS per line table) — no schema change.

### 61. REQ-103 — Partial: Case- or project-specific escalations of overdue approvals.

- **Source:** EMAIL §3
- **Gap:** Escalation flag only for grievances/encroachments; no SLA-based escalation for cases/payments/requests.
- **Evidence:** Implementation located at: page —; API —; DB lms.workflow_escalation, workflow.allows_escalation (grievances, encroachments only), api.v_approval_bottleneck
- **Smallest fix:** Add SLA days per stage and a scheduled job inserting workflow_escalation + notification.

### 62. REQ-104 — Partial: Configurable dashboards (project, landowner, financial) with search, filters, sorting and export.

- **Source:** EMAIL §4; PROTO dashboard/projdash
- **Gap:** Dashboards exist; export and user configuration need runtime verification.
- **Evidence:** Implementation located at: page /dashboard, /projdash; API /api/analytics/kpis; DB api.v_executive_kpis, api.v_project_portfolio
- **Smallest fix:** —

### 63. REQ-105 — Partial: APIs and SAP integration scope (data flows, interfaces, responsibilities).

- **Source:** EMAIL §9
- **Gap:** Outbox + worker (scripts/sap_outbox_worker.ts) exist; no SAP endpoint configured; scope document not found.
- **Evidence:** Implementation located at: page —; API —; DB lms.integration_outbox, lms.integration_endpoint
- **Smallest fix:** Write the SAP interface spec; configure a sandbox endpoint.

### 64. REQ-108 — Partial: Every requirement's evidence is classified Demonstrated / Documented / Pending Validation / Not Available; compliance matrix mapped to the s…

- **Source:** EMAIL §1, §12
- **Gap:** .gsd/REQUIREMENTS.md cites deleted sources (requirments/lms_project_analysis.md, prompt.md) and marks REQ-10/11 Complete although the source designation chains are not implemented; this inventory supersedes it.
- **Evidence:** Implementation located at: page —; API —; DB —
- **Smallest fix:** Replace the matrix with this inventory; add the email's evidence classification column.

### 65. REQ-19 — Partial: Versioned forward-only PostgreSQL migrations with checksum drift check.

- **Source:** GSD; EMAIL §10 (schema documentation)
- **Gap:** lms_dev, lms_iam_test, lms_perf are at 0038; 0039–0044 exist only on disk / lms_test, so authorization (0041/0042) and reporting (0040/0043) fixes are not in the demo database.
- **Evidence:** SQL max(version): lms_dev 0038, lms_test 0044.
- **Smallest fix:** Apply 0039–0044 to lms_dev after the concurrent work lands; re-run db tests.

### 66. REQ-29 — Partial: Master entry screens for District (code, name, by province and Pakistan/International), Taluka, Deh/Moza, Survey/Khasra, and mapping screens…

- **Source:** SS-MENU (Action menu: Private Master Entry, District/Taluka Master Entry, Deh/Moza Entry, Survey/Khasra Entry, Landowner No., Customer No., Deh-Taluka, Taluka-District); SS-DIST
- **Gap:** Generic admin-unit master covers create/parent; no Pakistan/International selector (REQ-25) and no Division level (REQ-01). Re-mapping (Deh–Taluka) needs runtime verification.
- **Evidence:** Implementation located at: page /units; API /api/units; DB lms.admin_unit (code, level, parent_id)
- **Smallest fix:** Covered by REQ-01/REQ-25 fixes; add an explicit "move to parent" action with audit if missing.

### 67. REQ-30 — Partial: Survey Master Entry per Deh: Survey code, Survey name, Total survey area (Acres, Ghunta) and Occupied survey area (Acres, Ghunta).

- **Source:** SS-SURV
- **Gap:** Committed/occupied area is computed, but shown in decimal acres; no separate "survey name"; Deh-first navigation needs runtime verification.
- **Evidence:** Implementation located at: page /surveys; API /api/surveys (committed_area); DB lms.survey, lms.survey_committed_area() (0043), api.v_survey_ownership
- **Smallest fix:** Show total and occupied area in A-G for SND (REQ-28); add optional survey_name column if Mari confirms it differs from survey_no.

### 68. REQ-38 — Partial: Request statuses: Draft; Submitted – Director Operations Approval Pending; Returned/Rejected by Director Operations; Approved – Regional Man…

- **Source:** WFPDF p2 §5
- **Gap:** Implemented values: Submitted, Under Review - Ops, Under Review - Regional, Under Review - Land Affairs, Returned, Rejected, Approved. No Draft; final "Approved" instead of "Land Processing Initiated"; stage_code has no CHECK/FK.
- **Evidence:** src/app/api/requests/route.ts:72-77; transition route.
- **Smallest fix:** Add CHECK constraint with the six PDF statuses (+Draft) and rename labels; keep codes stable via a lookup table.

### 69. REQ-50 — Partial: Case header: auto Case No, Case Date, Project ID / Well location, Concession / Delivery Unit (Business Unit), Project detail, Land used for,…

- **Source:** SS-CASENO; SS-LOSEL; SS-PROJ
- **Gap:** No Reference Lease link; Case No format "CC-2026-0001" (Oracle uses a sequential number) — acceptable but differs; business_unit/block_code null on imported/most cases.
- **Evidence:** SQL: compensation_case codes CC-2026-0001.., block_code empty for CC-2026-0021.
- **Smallest fix:** Add reference_lease_id FK (nullable) to compensation_case; default business_unit/block_code from project.

### 70. REQ-53 — Partial: Crop details per line: Deh, Taluka, District, Block/Survey, Owners Share %, Crop Type, Rate/Acre, Damage Area (acres), Amount; remarks; Tota…

- **Source:** SS-CASENO / SS-CASECHG "CROP DETAILS"
- **Gap:** No Owners Share % on crop lines; total damage area not printed in A-G.
- **Evidence:** Implementation located at: page /cases; API —; DB lms.case_crop_line (survey, crop_type, rate_per_acre, damage_area, amount)
- **Smallest fix:** Add owners_share_pct (default 100) to case_crop_line and tree line; print totals.

### 71. REQ-81 — Partial: Report presentation conventions: system name, "LAND MANAGEMENT SERVICES", report id, page x of y, print date/time, totals row; amounts with …

- **Source:** PSR; FIN; SS-LLDR; RCPT
- **Gap:** Formatting uses Intl en-PK which yields western grouping (13,800,000); report header/page numbering only in browser print.
- **Evidence:** node: new Intl.NumberFormat('en-PK').format(13800000) → "13,800,000"; reports/route.ts:9.
- **Smallest fix:** Use en-IN grouping (or a custom lakh formatter) for PKR in SoR-format documents; add header/footer in PDF writer.


## Impact 5 — cosmetic / documentation

### 72. REQ-119 — Missing: Landowner-detail and lease screens show the selected row's Case # and Case Status in a footer.

- **Source:** LOD, SS-CHAT, SS-LOPCT, SS-LLREN (footer "Case # / Case Status")
- **Gap:** Not present in landowner list/detail.
- **Evidence:** Implementation located at: page /landowners; API —; DB —
- **Smallest fix:** Add latest case code/stage per holding to the REQ-33 view and show in the detail drawer.

### 73. REQ-107 — Partial: Handover deliverables: source code, schema/data dictionary, deployment and configuration docs, backup/restore/migration procedures, admin tr…

- **Source:** EMAIL §10, §9
- **Gap:** Technical docs exist; data dictionary, training, SLA and cost documents not found in repo.
- **Evidence:** Implementation located at: page —; API —; DB db/README.md; docs/DATABASE_ENGINEERING_REPORT.md
- **Smallest fix:** Generate a data dictionary from information_schema; commercial items are outside code scope.

### 74. REQ-110 — Partial: Unit converter available from the header and "use converted value" in area inputs.

- **Source:** PROTO openConverter()/useConverted()
- **Gap:** Converter is on /units; header shortcut and insert-into-field need runtime verification.
- **Evidence:** Implementation located at: page /units (converter); API /api/units; DB —
- **Smallest fix:** —

### 75. REQ-31 — Partial: Business terminology is used consistently: Deh/Mouza, Taluka/Tehsil, Survey/Khasra, Tora (initial/subsequent lease year), Kharat approval, D…

- **Source:** PPSX slides 1-8; SS-CASENO ("Initial Tora / Subsequent Tora"); SS-RIGHTS ("Kharat Approved"); CSV-DPFC (BOR Reservation Status)
- **Gap:** Most terms are present; "Tora" is rendered as "Reduced area", BOR/Revenue Office statuses absent (REQ-76), no glossary page.
- **Evidence:** src/app/cases/page.tsx:79 header "Reduced area".
- **Smallest fix:** Rename award-sheet columns to "Initial Tora net lease area" / "Subsequent Tora net lease area"; add a glossary section to /arch or help.

### 76. REQ-54 — Partial: Tree details per line: Deh, Taluka, District, Block/Survey, Owners Share %, Tree (species + size e.g. BAIRI (LARGE), NIM, SHABAR (MEDIUM), B…

- **Source:** SS-CASENO / SS-CASECHG "TREE DETAILS"
- **Gap:** Species catalogue lacks Shabar and Khabar (Devi) (has Babul, Neem, Ber…); no owners share %.
- **Evidence:** SQL tree_species: Babul|Neem|Sheesham|Date Palm|Mango|Eucalyptus|Kikar|Ber|Other.
- **Smallest fix:** Insert Shabar, Khabar (Devi) with local aliases (Bairi=Ber, Nim=Neem, Babool=Babul).
