# Landowner Statement — How It Works and How to Test It

Prepared 2026-10-30 against `lms_dev` (migration 0048), server `http://localhost:3040`.

---

## Part A — What the statement is

Screen: **Landowners → Statement** (button on each row) → **Print**.

The statement is **one landowner's account with the company**. It shows:

- how much compensation the company **owes** them, on approved cases;
- how much the company has **paid** them;
- the **balance still owed**.

### A1. Where each part comes from

| Part of the screen | Source (database) | Rule |
|---|---|---|
| Name, s/o, CNIC | `lms.landowner` | CNIC is masked unless the viewer holds `pii:read` |
| **Holdings** "2 · 46.85 ac" | `api.v_landowner_summary` | number of parcels owned, and Σ (parcel area × owner's share %) |
| **Active leases** | same view | leases at stage *Approved*, not terminated, end date ≥ today |
| **Paid to date** | same view | Σ `released_amount` of every cheque to this landowner. This is the **net** amount, after withholding tax. |
| Table rows and **Balance** | `api.report_landowner_statement(id)` | see A2 |

### A2. The 5 kinds of row

| Entry | When it appears | Amount shown | Effect on Balance |
|---|---|---|---|
| **Compensation approved** | a case this person owns reaches **HO Approved** | their share of the award (award × share %) | **+** (company owes more) |
| **Award adjustment** | an adjustment is made on an approved case | their share of the adjustment | **+ / −** |
| **Compensation paid** | a released cheque that is **allocated to that case** | **gross** = net cheque + withholding tax | **−** (owed less) |
| **Payment reversed** | a released cheque is reversed | gross | **+** |
| **Other payment (not compensation)** | a released cheque to this person that is **not allocated** to any case (lease rent, unallocated crop …) | **gross** = net cheque + withholding tax (since migration 0049; the description shows both) | **no effect** |

**Balance = (approved compensation + adjustments) − compensation paid.**
It is the compensation still owed. Rows are sorted by date, and the balance is a running total.

### A3. Not on the statement (by design)

- Cases not yet at **HO Approved**. Example: SND-000002 owns 100% of **CC-2026-0002**, Rs 1,248,000, which is only at *Checked*.
- Vouchers that are raised or verified but **not released**. SND-000002 has 5 of these, totalling Rs 456,300 net.
- Payments to anyone else.

### A4. Worked check: SND-000002, Mukhtiar Ali Jarwar (verified in the DB)

| Figure | Calculation | Result |
|---|---|---|
| Holdings | AREA-000008: 31.25 ac × 100% + AREA-000009: 26.00 ac × 60% | 2 parcels · **46.85 ac** ✔ |
| CC-2026-0001 approved | 3,281,875 × 60% | **1,969,125** ✔ |
| CC-2026-0009 approved | 72,000 × 60% | **43,200** ✔ |
| Compensation paid VCH-2026-00001 | net 937,406.25 + WHT 104,156.25 (10%, filer) | **1,041,562.50** (shown 1,041,563) ✔ |
| Other payments (since 0049, gross) | Lease rent 112,500 + 12,500 tax = 125,000 (×2); crop 45,000 + 5,000 tax = 50,000 (×2) | no effect on the balance ✔ |
| Final balance | 1,969,125 + 43,200 − 1,041,562.50 | **970,762.50** (shown 970,763) ✔ |
| Paid to date | 937,406.25 + 112,500 + 112,500 + 45,000 + 45,000 (all net) | **1,252,406.25** ✔ |

All figures reconcile. Amounts are stored to 2 decimals and shown rounded to whole rupees.

### A5. Findings to put in the report (SND-000002 and the statement design)

| # | Finding | Type |
|---|---|---|
| # | Finding | Status (2026-10-30) |
|---|---|---|
| F1 | The **Amount** column mixed bases: "Compensation paid" gross, "Other payment" net, so the column total matched nothing. | **FIXED**, migration 0049: every payment line is gross, and the description shows "net … + withholding tax …". "Paid to date" is now labelled *(cheques, after tax)*. SND-000002 now shows 125,000 / 125,000 / 50,000 / 50,000, with the balance unchanged at 970,763. |
| F2 | **Cheque dated 22 Jul 2026, before the case was approved (30 Oct 2026)**, so the first balance line is negative. Cause: the demo seed released the cheque at `current_date − 100` while approving the case "now". | **FIXED in the seed** (`seed_demo_transactions.sql`: cheque and receipt dated the seed day). Existing `lms_dev` rows are append-only and keep the old date until the demo DB is rebuilt. |
| F3 | VCH-2026-00001 categorised "Lease Rent" on compensation case CC-2026-0001. | **Not a defect**: CC-2026-0001 is a *lease* compensation case (pay type "Yearly Lease"), so Lease Rent is the right category. |
| F4 | Two Crop Compensation cheques (VCH-2026-00009 / 00010) are not allocated to a case. | **Not a defect**: these vouchers name no case (raised as stand-alone crop payments), so they are correctly "Other payment" and do not touch the case balance. |
| F5 | Users **without** `payments:read` (e.g. Legal Advisor) received payment rows and amounts (the page filtered on a value that never occurs, and the API sent them anyway). | **FIXED**: `/api/landowners` now drops payment lines, running balance and paid-to-date unless the caller may read payments in the owner's province (`payments_shown` flag). The page and print follow that flag. |
| F6 | Pending vouchers and non-approved cases are not shown. | **By design**, and now stated in a note on screen and on the print. |
| F7 | Payments search matched a CNIC for users without `pii:read`; the Mutations search box offered CNIC / type / revenue no. but searched only code and name. | **FIXED**: CNIC search needs `pii:read` everywhere; Mutations now searches CNIC (with `pii:read`), mutation type and revenue mutation no. |

---

## Part B — Test from zero: new landowner → statement

**Accounts:** password from the login page "Use" button. **Province: Sindh. Project: DHRK-001.**

**SoD reminder:** the person who prepares a record cannot approve it, and one person cannot approve two steps. Always use a different account for each step, exactly as listed.

### Test data (fixed so the expected figures are known)

| Item | Value |
|---|---|
| Landowner | **Test Owner Alpha** s/o Test Father, CNIC **45102-9990001-1**, Owner, **Filer**, SND, bank any |
| Parcel | new survey in DHRK-001, area **10 acres**, Test Owner Alpha **100%** |
| Case | on DHRK-001, owner Test Owner Alpha **100%**, one "other compensation" line **Rs 100,000** |
| Voucher | gross **Rs 100,000**, category **Crop Compensation** → WHT 10% = 10,000 → **net 90,000** |

### Steps and expected results

| # | Login as | Do | Expected | ✔/✘ |
|---|---|---|---|---|
| 1 | **lofield** | Landowners → **+ Add Landowner** with the data above | Saved, code `SND-0000xx`. Typing a wrong CNIC (e.g. `451029990001`) turns the field red and Save stays disabled. | |
| 2 | lofield | Same CNIC again as a second landowner | **Refused** (duplicate CNIC) | |
| 3 | lofield | Landowners → **Statement** on Test Owner Alpha | Holdings 0 · 0 ac, leases 0, Paid 0, "No transactions" | |
| 4 | lofield | Survey / Khasra Register → new parcel, 10 ac, share Test Owner Alpha 100% (Share Balancer must show 100.0%) | Saved. Trying 90% must be refused (shares ≠ 100%). | |
| 5 | lofield | Statement again | Holdings **1 · 10.00 ac** | |
| 6 | lofield | Compensation Cases → new case (data above). Tick all 6 documents: CNIC copies, Fard, Consent, Bank, Site photos, Joint survey. | Case `CC-2026-00xx` at **Prepared** | |
| 7 | lofield | Try to approve own case | **Refused**: no approval position / SoD | |
| 8 | **nego** | Advance case → **Checked** | OK | |
| 9 | **legal** | Advance → **Reviewed** | OK | |
| 10 | **sradmin** | Advance → **Verified** | OK | |
| 11 | sradmin | Try → Field Approved | **Refused** (step is for DM / Team Lead) | |
| 12 | **dmfield** | Advance → **Field Approved** | OK. Remove one document first to see "Missing documents: …", then re-tick it. | |
| 13 | **mland** | Advance → **HO Approved** | OK | |
| 14 | lofield | Statement | Row **Compensation approved 100,000**, Balance **100,000**, Paid 0 | |
| 15 | lofield | Payments → **Request voucher**: DHRK-001, the case, payee Test Owner Alpha, Crop Compensation, gross 100,000 | Voucher at *Requested*, WHT **10,000**, net **90,000** (filer) | |
| 16 | lofield | Try to verify own voucher | **Refused** | |
| 17 | **finance** | **Verify** voucher | OK | |
| 18 | finance | Try **Release** | **Refused** (release is Manager Land) | |
| 19 | **mland** | **Release**: cheque no `CHQ-TEST-0001`, today's date (re-enter password if asked) | Released | |
| 20 | lofield | Statement | **Other payment (not compensation) 100,000** ("net 90000.00 + withholding tax 10000.00"), Balance still **100,000**, Paid to date **90,000** (not allocated yet, see A2) | |
| 21 | **finance** | Payments → liabilities tab → case → **Allocate voucher**, amount **90,000** | Allocated | |
| 22 | lofield | Statement | Row becomes **Compensation paid 100,000** ("net 90000 + withholding tax 10000"), Balance **0**, Paid to date **90,000** | |
| 23 | lofield | **Print** | PDF/print matches the screen, marked "CONFIDENTIAL — PERSONAL DATA", printed-by name correct | |

### Extra checks (add to the report)

| # | Login as | Check | Expected |
|---|---|---|---|
| X1 | **viewer** (Analyst) | open Landowners | not in the menu / no access (no `landowners:read`) |
| X2 | **audit** | open the statement | CNIC masked (last 4 only); read-only |
| X3 | **admin** | open Landowners | no access (admin holds no business data) |
| X4 | **loquetta** (BAL) | search `45102-9990001-1` | not found (Sindh record, other province) |
| X5 | lofield | set Test Owner Alpha to **Non-filer**, raise a 100,000 voucher | WHT **20,000** (2 × 10%), net 80,000 |
| X6 | lofield | mark Test Owner Alpha **Deceased**, then try a new voucher or release | **blocked** until a succession mutation is recorded |
| X7 | finance | put a **landowner hold**, then try to verify a voucher | "Payment is on hold: …" |
| X8 | **legal** | open the statement | only **Compensation approved** rows; no payment rows, no Balance column, no Paid to date; the note says payments need `payments:read` (F5 fix) |
| X9 | **audit** / **viewer** | Payments search with a full CNIC | no match (CNIC search needs `pii:read`) (F7 fix) |
| X10 | lofield | Mutations search with a transferor's CNIC, a mutation type (e.g. "Inheritance") or a revenue mutation no. | matching mutations listed (F7 fix) |

### Recording results

For each step, write ✔ or ✘. On a ✘, add the screenshot and the error text, and keep the correlation ID if one is shown. The audit trail (**Audit Trail** page, logged in as **audit**) should list every create, approve and release above with the actor's name. Attach that as evidence.

---

## Part C — Test an existing landowner (already in the system)

1. Pick a landowner with payments, e.g. **SND-000002**, and open the Statement.
2. Check **Holdings**: Survey register, filter the owner, then Σ area × share %.
3. Each **Compensation approved** line = case award × share %. The case is on Compensation Cases.
4. Each **Compensation paid** line = the voucher's gross on Payments. Its net + WHT appear in the description.
5. **Balance** = Σ approved − Σ compensation paid (A2).
6. **Paid to date** = Σ net cheques (all released vouchers for this payee on Payments).
7. Note anything like F2–F4 (dates out of order, wrong category, unallocated cheques).
