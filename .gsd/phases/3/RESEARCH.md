---
phase: 3
researched_at: 2026-10-20
discovery_level: 2
---

# Phase 3 Research — Acquisition, Leases, ROW & Compensation Workflow Engine

## Objective
Structure the complex legal, financial, and administrative workflows required for Mari Energies land operations: statutory acquisitions (Land Acquisition Act 1894), surface leases, pipeline corridors (ROW), DBPFC Sindh government pricing, and 6-tier Segregation of Duties approval governance.

## Key Decisions

### Decision 1: Land Acquisition Act 1894 Lifecycle
**Question:** How should compulsory land acquisitions be structured in the system?  
**Decision:** Model the statutory milestones defined in the *Land Acquisition Act 1894*:
- **Section 4**: Initial notification published in the official provincial gazette authorizing preliminary survey.
- **Section 6**: Formal declaration of public purpose after objections under Section 5-A are heard.
- **Section 9**: Public notice issued to interested parties and occupants to submit land title and compensation claims.
- **Section 11**: Final award announced by the Land Acquisition Collector (LAC) specifying true area, market value, 15% compulsory acquisition charges (Solatium), and apportionment.  
**Confidence:** High (Directly aligned with Pakistani legal doctrine).

### Decision 2: 6-Tier Segregation of Duties Approval Engine
**Question:** How should high-value compensation disbursements be governed to eliminate single-user approval fraud?  
**Decision:** Implement a strict, non-bypassable 6-stage sequential state machine:
`Field Officer -> Negotiation Lead -> Legal Clearance -> Sr. Admin -> Manager Land -> Finance`.
Returning a case requires documented justification remarks; escalating alerts higher management.
Special workflows are provided for Flare Pit compensation and historical 50% past pending balance payments.  
**Confidence:** High (Satisfies internal audit and corporate governance).

### Decision 3: FBR Withholding Tax (WHT) Automation
**Question:** How should income tax deductions be applied to land compensation payments?  
**Decision:** FBR Active Taxpayer List (ATL) status determines withholding rates:
- Verified Filers: Standard withholding rate (e.g. 5% on purchase / 10% on compensation).
- Non-Filers: Punitive 2x rate (e.g. 10% / 20%).
LMS automatically computes Gross Amount, WHT Deducted, and Net Payable, generating an auditable tax deduction certificate.  
**Confidence:** High (Complies with FBR Income Tax Ordinance 2001).
