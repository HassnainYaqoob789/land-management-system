---
phase: 1
researched_at: 2026-10-10
discovery_level: 2
---

# Phase 1 Research — Provincial Revenue & Frontend Architecture

## Objective
Determine the exact statutory revenue structures, measurement unit conversion standards, and Content Security Policy architecture for the multi-provincial Land Management System.

## Key Decisions

### Decision 1: Provincial Hierarchy and Cadastral Keys
**Question:** How should the system structure administrative levels and cadastral search keys across four provinces?  
**Options Considered:**
1. Unified generic hierarchy (Country -> State -> City): Fails to capture Pakistani revenue law nuances (Deh vs Mouza; Taluka vs Tehsil).
2. Dynamic provincial schema mapping: Distinct tiers per province (Sindh, Balochistan, Punjab, KP).  
**Decision:** Adopt dynamic provincial schema mapping. Sindh uses District -> Taluka -> Deh (Survey/Block No.); Punjab uses District -> Tehsil -> Qanungo Halka -> Mouza (Khasra No.); Balochistan uses District -> Sub-Division -> Tehsil -> Sub-Tehsil -> Mouza (Khasra No.); KPK uses District -> Sub-Division -> Tehsil -> Mouza (Khasra/Survey No.).  
**Confidence:** High (Verified directly against provincial land revenue acts and reference presentation).

### Decision 2: Content Security Policy & Event Dispatching
**Question:** How can we ensure enterprise CSP compliance while retaining dynamic UI interactions?  
**Decision:** Eliminate all 137 inline `onclick` handlers and inline styles. Replace with `data-act` attributes routed through a static registry allowlist of 119 functions.  
**Confidence:** High (Eliminates XSS vectors and achieves A+ security posture).

## Findings
- Measurement units in Sindh center on Jireb (1/2 Acre) and Ghunta (1/40 Acre).
- Measurement units in Punjab center on Kanal (1/8 Acre) and Marla (1/160 Acre).
- Measurement units in Balochistan center on Rod (1/4 Acre) and Pole (1/160 Acre).
- Measurement units in KPK center on Kanal (1/8 Acre) and Bigha (1/2 Acre).
- All units resolve back to square feet (1 Acre = 43,560 sq ft) for unambiguous numeric calculations.

## Anti-Patterns Avoided
- Never store floating-point representation of land areas; use square feet or exact decimals.
- Never use inline `<script>` tags or `javascript:` pseudoprotocols.
