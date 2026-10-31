---
name: lms-auth-rbac-security
description: Enterprise authentication, 6-tier Segregation of Duties (SoD) authorization, session cookie security, and OWASP ASVS Level 2 compliance
---

# LMS Authentication, RBAC & Application Security Skill

<role>
You are an Application Security Architect and Identity/Access Specialist adhering to OWASP ASVS 4.0.3 Level 2 and ISO 27001 Annex A guidelines.
</role>

---

## 1. Purpose & Scope

Govern identity, session management, and authorization across the LMS:
- **Authentication**: Bcrypt password hashing (`bcryptjs`, minimum 10 rounds), HTTP-only SameSite session cookies (`lms_user_id`), session invalidation on logout.
- **6-Tier Segregation of Duties (SoD)**:
  1. `lofield` (Land Officer Field): Creates case (`Prepared`).
  2. `nego` (Negotiation Group): Agrees rates (`Checked`).
  3. `legal` (Legal Advisor): Validates title deeds and searches litigation (`Reviewed`).
  4. `sradmin` (Sr. Administrator Field): Field admin verification (`Verified`).
  5. `dmfield` (DM / Team Lead Field): Operational field approval (`Field Approved`).
  6. `mgrho` (Manager Land HO): Executive head-office approval (`HO Approved`).
  7. `finance` (Finance Officer): Voucher verification and crossed cheque release.
- **Self-Approval Prohibition**: The user who prepared or checked a case cannot perform senior field approval or HO release.
- **Provincial Jurisdiction RBAC**: Field staff cannot see or modify records belonging to other provinces (`SND`, `BAL`, `PNJ`, `KPK`).

---

## 2. Activation Criteria

Invoke this skill whenever:
- Modifying authentication routes (`src/app/api/auth/*`) or session validation (`src/lib/auth.ts`).
- Implementing or modifying workflow transitions (`src/app/api/cases/[id]/transition/route.ts`).
- Authorizing API routes or protecting frontend pages.
- Auditing security controls against OWASP ASVS L2, ISO 27001, or SOC 2 criteria.

---

## 3. Prerequisites

1. Seed user accounts and group mappings in `lms.app_user` and `lms.app_user_group`.
2. Account and password bootstrap in `scripts/iam/bootstrap.ts` (passwords from the environment, Argon2id).
3. Security architecture references in `docs/security/SECURITY_ARCHITECTURE.md` and `docs/DATABASE_SECURITY_REVIEW.md`.

---

## 4. Execution Procedure

### Step 1: Session Verification
- All authenticated API routes must extract and verify `lms_user_id` from request cookies.
- If missing or invalid, immediately return `401 Unauthorized`.
- Ensure cookies use `HttpOnly`, `SameSite=Lax`, and `Path=/`.

### Step 2: SoD Authorization Validation
Before advancing any stage in `api.advance_workflow`:
1. Check that the actor belongs to the required group in `lms.app_user_group`.
2. Confirm the actor has jurisdiction over the record's `province_code`.
3. Confirm all prerequisite document checklists (`lms.case_document_check`) are satisfied.
4. Record transition into `lms.workflow_transition` and `audit.audit_event`.

### Step 3: Security Review Checklist
- [ ] No plaintext passwords stored in database or logs.
- [ ] Parameterized SQL queries used exclusively (prevent SQL injection).
- [ ] Input data sanitized and validated before execution.
- [ ] No client-side bypasses for server-side authorization gates.

---

## 5. Expected Deliverables

- Hardened route handlers and middleware.
- Test cases validating unauthorized access attempts (`401` / `403`).
- Security review evidence in compliance documents.

---

## 6. Validation Steps

```bash
# Verify session security and SoD workflow transitions
node scripts/test_e2e.js

# Test unauthorized transition rejection
node -e "
  fetch('http://localhost:3030/api/cases/test-id/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_stage: 'Field Approved' })
  }).then(r => console.log('Expected 401:', r.status));
"
```

---

## 7. Failure Handling

- If an unauthorized user attempts an action, return HTTP `403 Forbidden` with a structured error `{ error: 'Insufficient permissions for this stage', code: 'SOD_VIOLATION' }`.
- Never weaken SoD checks or allow admin overrides in production workflows without explicit audit logging.
