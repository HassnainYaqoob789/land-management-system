---
phase: 3
plan: 1
wave: 1
gap_closure: false
---

# Plan 3: Acquisition, Leases, ROW & Compensation Workflow Engine

## Objective
Deliver complete lifecycle automation for:
1. Statutory land acquisitions under the *Land Acquisition Act 1894* (Sections 4, 6, 9, 11).
2. Surface well leases with escalation schedules, expiry alerts, and payment holds.
3. Right-of-Way (ROW) linear corridors for pipelines and flowlines.
4. Sindh Government Land reservations and District Base Price Fixing Committee (DBPFC) pricing workflows.
5. Multi-tier designation-based approval hierarchy (6 sequential tiers) governing compensation cases (Crop, Tree, Land, Flare Pit damages, and 50% Remaining Past Pending Balance payments).

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ARCHITECTURE.md`
- `app/assets/js/core/spec.js` (acquisitions, cases, leases, rows, payments, dbpfc)
- `app/assets/js/core/engine.js` (workflow engine: `wfAdvance`, `wfReturn`, `wfEscalate`)
- `app/assets/js/core/calc.js` (WHT calculation, lease rent escalation)
- `requirments/email.txt` (sections 3 & 4)
- `requirments/Workflow references.zip`

## Tasks

<task type="auto" effort="medium">
  <name>Implement Land Acquisition Act 1894 Statutory Workflow</name>
  <files>
    app/assets/js/core/spec.js
  </files>
  <action>
    Model statutory stages for compulsory land acquisition:
    - Section 4: Preliminary Notification by Revenue Department.
    - Section 6: Formal Declaration of Public Purpose.
    - Section 9: Notice to Interested Persons & Landowners.
    - Section 11: Collector Land Acquisition Award & Compensation Determination.
    Enforce sequential progression; a case cannot leap to Section 11 without Section 4 and 6 dates recorded.
  </action>
  <verify>
    grep -E "acquisitions" app/assets/js/core/spec.js
  </verify>
  <done>
    Statutory acquisition module accurately models procedural requirements under the 1894 Act.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Surface Leases, Escalation Formulas & Expiry Alerts</name>
  <files>
    app/assets/js/core/spec.js
    app/assets/js/core/calc.js
  </files>
  <action>
    Implement surface well lease management:
    - Track lease terms, commencement dates, and expiration milestones.
    - Apply annual rent escalation percentages (e.g. 5% or 10% annual compound).
    - Provide expiry status flags: Active, Expiring within 90 days, Expired, On Hold.
  </action>
  <verify>
    grep -E "leaseRenew|leaseRent" app/assets/js/app/registry.js
  </verify>
  <done>
    Lease renewals and escalations compute correctly and trigger automated alerts.
  </done>
</task>

<task type="auto" effort="medium">
  <name>6-Tier Segregation of Duties Approval Hierarchy</name>
  <files>
    app/assets/js/core/engine.js
    app/assets/js/core/spec.js
  </files>
  <action>
    Configure designation-based multi-tier approval stages:
    1. Field Officer (Case initiation and cadastral linking)
    2. Negotiation Lead (Rate negotiation and landowner consent)
    3. Legal Clearance (Title verification, succession, dispute check)
    4. Senior Admin - Field (Administrative vetting)
    5. Manager Land - Head Office (Executive corporate approval)
    6. Finance Department (Voucher generation, WHT deduction, fund release)
    Include special case workflows: Flare Pit damages and 50% Remaining Past Pending Balance releases.
  </action>
  <verify>
    grep -E "wfAdvance|wfReturn|wfEscalate" app/assets/js/app/registry.js
  </verify>
  <done>
    Cases transition sequentially across the 6 approval tiers with mandatory audit logging and role restrictions.
  </done>
</task>

## Must-Haves
- [x] Land Acquisition Act 1894 sequential stages (Sec 4, 6, 9, 11).
- [x] Lease renewal calendar with escalation calculations.
- [x] 6-tier designation approval hierarchy enforced.
- [x] FBR Withholding Tax calculation (Filers vs. Non-Filers 2x rate).

## Success Criteria
- [x] Case workflow advances only when current user possesses authorized designation.
- [x] Rejection or return requires mandatory remarks.
- [x] Payment vouchers calculate net payable after automated WHT deduction.
