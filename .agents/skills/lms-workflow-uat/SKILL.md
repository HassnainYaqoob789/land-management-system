---
name: lms-workflow-uat
description: End-to-end user acceptance testing (UAT) and realistic business workflow validation across Pakistani E&P land management scenarios
---

# LMS Workflow User Acceptance Testing (UAT) Skill

<role>
You are the Lead User Acceptance Testing (UAT) Specialist and E&P Business Domain Expert for Mari Energies.
Your role is to orchestrate realistic multi-persona business journeys that validate the end-to-end flow from initial land survey to cheque disbursement.
</role>

---

## 1. Purpose & Scope

Validate that the application faithfully delivers the operational workflows used by Mari Energies field and head-office teams:
1. **Cadastral Acquisition & Survey**:
   - Field Joint Measurement Survey verification.
   - Deh / Mauza Khasra parcel registration.
   - Live 100.0% share balancing across co-owners.
2. **6-Tier Compensation Pipeline**:
   - Land Officer initiates case with 6 mandatory document checklist items.
   - Negotiation Officer verifies rates agreement.
   - Legal Advisor completes non-encumbrance title search.
   - Sr. Administrator verifies field records.
   - DM / Team Lead Field approves field operational clearance.
   - Manager Land (HO) grants executive approval.
3. **Financial Disbursement & Compliance**:
   - Finance Officer reviews approved case.
   - System checks budget allocation balance.
   - System checks legal stay order holds.
   - Cross Cheque issued with unique number (`CHQ-...`).
   - Integration outbox record queued for corporate SAP/ERP.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Performing UAT sign-off for a milestone or release.
- Validating multi-user persona handoffs.
- Testing realistic business exceptions (e.g. disputed parcel, missing documents, non-filer tax penalty).
- Preparing demo scenarios for corporate leadership.

---

## 3. Prerequisites

1. A production build (`npm run build && npm start`) against the test database
   (`lms_iam_test`), never against production data.
2. Fixture accounts whose passwords were set with `scripts/iam/bootstrap.ts` and
   written to a JSON file named by `IAM_TEST_PASSWORDS` (outside the repository).
   There are no shared or default passwords.
3. Each persona signs in in its own browser context. There is no role switcher:
   separation of duties is enforced on the person, so one account cannot act as two.

---

## 4. Execution Procedure

### Step 1: Persona Journey Execution
Walk through the canonical E&P operational journey:
1. **Land Officer (`lofield`)**:
   - Log into portal.
   - Navigate to Cadastral Surveys & verify parcel `AREA-000001`.
   - Initiate compensation case for well location.
   - Confirm mandatory documents attached (CNIC, Fard, Consent, Photos, Survey).
2. **Negotiation Officer (`nego`)**:
   - Sign in as `nego` in a separate browser context.
   - Advance stage: `Prepared` &rarr; `Checked`.
3. **Legal Advisor (`legal`)**:
   - Sign in as `legal` in a separate browser context.
   - Advance stage: `Checked` &rarr; `Reviewed`.
4. **Sr. Administrator Field (`sradmin`)**:
   - Advance stage: `Reviewed` &rarr; `Verified`.
5. **DM / Team Lead Field (`dmfield`)**:
   - Advance stage: `Verified` &rarr; `Field Approved`.
6. **Manager Land Head Office (`mgrho`)**:
   - Advance stage: `Field Approved` &rarr; `HO Approved`.
7. **Finance Officer (`finance`)**:
   - Request payment voucher with FBR WHT rate.
   - Perform pre-disbursement verification.
   - Release crossed cheque and verify outbox record.

### Step 2: Exception Handling Journeys
- **Attempting skip-level approval**: Verify DM/TL cannot approve before Legal Advisor.
- **Attempting approval with missing documents**: Verify system blocks transition to `Field Approved`.
- **Attempting payment on stay-ordered parcel**: Verify `lms.wf_guard_payments` blocks release.

---

## 5. Expected Deliverables

- Completed `UAT.md` report with step-by-step evidence.
- Persona test logs capturing session IDs and record codes.

---

## 6. Validation Steps

```bash
# Execute full automated E2E journey script
node scripts/test_e2e.js
```

---

## 7. Failure Handling

- If any persona is unable to perform their assigned duty, inspect `lms.app_user_group` and `lms.workflow_step_group`.
- If an unauthorized persona succeeds in performing a restricted action, raise a critical security violation.
