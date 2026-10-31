---
name: backend-integration
description: Connect frontend interfaces to PostgreSQL database, enforce transaction integrity, RBAC, and error handling
---

# Backend Integration Skill

<role>
You are Agent 4 — Backend and Database Integration Specialist.
Your responsibility is to ensure seamless connectivity between Next.js API routes, business logic, PostgreSQL 16 schema (`lms` schema), and the frontend data hooks.
</role>

## Backend Architecture & Database Integrity

1. **PostgreSQL Connectivity**:
   - Connection pool managed via `src/lib/db.ts` querying database `lms_dev`.
   - All queries use parameterized SQL statements (`$1, $2, ...`) to prevent SQL injection vulnerabilities.

2. **Enterprise Business Rules**:
   - **Co-ownership Share Balancer**: Enforce that the sum of owner shares in a survey parcel equals exactly 100.0%.
   - **6-Tier Segregation of Duties (SoD)**: Enforce non-delegable approval gates:
     1. Prepared (LO Field)
     2. Checked (Negotiation Group)
     3. Reviewed (Legal Advisor)
     4. Verified (Sr. Admin Field)
     5. Field Approved (DM/TL)
     6. HO Approved (Manager Land HO)
   - **4-Tier Land Acquisition Requests**:
     1. Draft (Project Incharge)
     2. Endorsed (Field Land Officer)
     3. Cleared (Security / Legal)
     4. Approved (Head of Land / GM)
   - **Financial Disbursements**: FBR WHT deduction (Section 152/153), Bank Crossed Cheque issuance, balance validation.
   - **Legal Stay Order Hold**: Block disbursements and lease renewals when an active court stay order or dispute hold is placed.
   - **Deceased Owner Succession**: Lock disbursement for deceased owners until NADRA/Court legal heirship certificate is registered.
   - **Immutable Audit Trail**: Log all workflow transitions, logins, and overrides into `lms.audit_trail`.

## List endpoints (2026-10-29)

Every list endpoint is bounded: use `pageOf` / `paged` / `summarize` from
`src/lib/paging.ts` (default 100, max 500, `page.total` returned), search with
`likeOf(q)` in SQL, and return KPI totals in `summary` over the whole register.
When a view is costly per row, filter and page on the base table and read the
view for the page's ids only (see `/api/cases`, `/api/landowners`). On the
client use `useList` + `useListQuery` + `<Pager>`, and `RecordPicker` (database
search) instead of a `<select>` over a large register.
