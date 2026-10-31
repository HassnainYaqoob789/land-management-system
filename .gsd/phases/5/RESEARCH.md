---
phase: 5
researched_at: 2026-10-26
discovery_level: 3
---

# Phase 5 Research — Enterprise Security & Compliance Frameworks

## Objective
Establish the theoretical and operational foundations for aligning the Land Management System with OWASP ASVS v4.0.3 Level 2, ISO/IEC 27001:2022 ISMS, and SOC 2 Trust Services Criteria, distinguishing purely technical controls from organizational management processes.

## Key Decisions

### Decision 1: Scope of OWASP ASVS Verification
**Question:** Which ASVS verification level is appropriate for Mari Energies LMS?  
**Decision:** Target **ASVS Level 2 (Standard Applications)**. LMS handles sensitive land acquisition data, landowner national identity records (CNIC), legal disputes, and substantial corporate financial disbursements. Level 2 mandates defense-in-depth across authentication, access control, input validation, cryptographic storage, session handling, and communication security.  
**Confidence:** High (Industry standard for critical enterprise financial/operational systems).

### Decision 2: ISO/IEC 27001:2022 Technical Evidence Strategy
**Question:** Can code implementation alone constitute ISO 27001 compliance?  
**Decision:** No. ISO 27001 is an organizational Information Security Management System (ISMS). Code and database configurations provide technical controls under Annex A (e.g. A.8.2 Access Rights, A.8.9 Configuration Management, A.8.12 Data Leakage Prevention, A.8.20 Network Security, A.8.24 Use of Cryptography, A.8.28 Secure Coding). These technical artifacts serve as auditable evidence for external auditors, but organizational policies, management reviews, and risk acceptance remain mandatory company prerequisites.  
**Confidence:** High (Prevents misleading claims of instant ISO certification).

### Decision 3: SOC 2 Trust Services Criteria Mapping
**Question:** Which Trust Services Criteria are in scope?  
**Decision:** Focus on:
1. **Security (Common Criteria CC1–CC9)**: Access control, configuration baselines, perimeter defense, incident logging.
2. **Confidentiality (C1)**: Protection of landowner CNICs, dispute settlements, and proprietary wellsite coordinates.
3. **Availability (A1)**: Operational uptime, disaster recovery testing, backup integrity.
4. **Processing Integrity (PI1)**: Transaction completeness, mathematical share balance, non-destructive versioning.  
**Confidence:** High (Provides exact audit traceability).
