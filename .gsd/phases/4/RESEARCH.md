---
phase: 4
researched_at: 2026-10-24
discovery_level: 3
---

# Phase 4 Research — PostgreSQL Database Architecture & Integrity Controls

## Objective
Establish the technical architecture for PostgreSQL 16 as an independently secured enterprise system of record, evaluating constraint mechanisms, numeric precision standards, stored procedure boundaries, trigger overhead, view security, and Row-Level Security (RLS) performance.

## Key Decisions

### Decision 1: Numeric Precision & Decimal Safety
**Question:** Which data types should represent currency, land areas, and fractional shares?  
**Decision:** Prohibit IEEE 754 floating-point types (`float4`, `float8`, `double precision`). Enforce `numeric(18,4)` across all monetary columns (PKR), parcel areas (Sq Ft / Acres / Kanals), and ownership percentages.  
**Confidence:** High (Eliminates catastrophic rounding drift).

### Decision 2: Stored Routine Security Model
**Question:** When to use `SECURITY INVOKER` vs `SECURITY DEFINER` for stored procedures?  
**Decision:** Standardize on `SECURITY INVOKER` by default to preserve the caller's privileges and Row-Level Security policies. Where elevated privileges are strictly necessary (e.g. audit logging by restricted app roles), use `SECURITY DEFINER` with fixed schema search paths (`SET search_path = lms_audit, pg_catalog, pg_temp;`) and explicit execution grants to prevent search-path hijacking.  
**Confidence:** High (Prevents privilege escalation vulnerabilities).

### Decision 3: Audit Log Immutability via Database Triggers
**Question:** How can audit logs be protected against tampering by application credentials?  
**Decision:** Attach a trigger (`trg_audit_log_immutability`) on `lms_audit.audit_log` that raises an exception on any `UPDATE` or `DELETE` statement unless executed by the schema owner during emergency maintenance.  
**Confidence:** High (Guarantees non-repudiation for regulatory audits).

### Decision 4: Row-Level Security (RLS) Architecture
**Question:** How to prevent cross-provincial data leakage between field offices?  
**Decision:** Enable Row-Level Security on core cadastre and land agreement tables. Define policies checking `current_setting('lms.current_province', true)` or joined user province assignments. Ensure runtime role `lms_app` does not have bypass privileges (`BYPASSRLS`).  
**Confidence:** High (Multi-tenant data isolation at the storage layer).
