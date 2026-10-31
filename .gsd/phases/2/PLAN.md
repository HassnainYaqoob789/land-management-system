---
phase: 2
plan: 1
wave: 1
gap_closure: false
---

# Plan 2: Landowner & Cadastral Domain Modules

## Objective
Implement core cadastral data integrity controls: Computerized National Identity Card (CNIC: `XXXXX-XXXXXXX-X`) master uniqueness, mathematical 100.0% fractional share balancing (*Hissa-dari*), deceased landowner disbursement locks triggering succession mutations (*Wirasat / Intiqal*), and offline MapLibre GL vector GIS with KML/KMZ upload support.

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ARCHITECTURE.md`
- `app/assets/js/core/spec.js` (lines 64–133)
- `app/assets/js/core/calc.js`
- `app/assets/js/ui/gis.js`
- `app/assets/js/app/gis-map.js`

## Tasks

<task type="auto" effort="medium">
  <name>CNIC Validation & Master Uniqueness Enforcement</name>
  <files>
    app/assets/js/core/spec.js
  </files>
  <action>
    Enforce Pakistani CNIC regex pattern `^[0-9]{5}-[0-9]{7}-[0-9]$` on all landowner master records.
    Ensure unique CNIC indexing across the system to prevent phantom duplicate registrations.
    AVOID: Allowing duplicate landowner profiles across different blocks or projects.
    USE: CNIC as the immutable global master identifier.
  </action>
  <verify>
    grep -E "cnic" app/assets/js/core/spec.js
  </verify>
  <done>
    Landowner records strictly validate CNIC formatting and reject duplicate identity entries.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Mathematical 100.0% Fractional Share Balancing (Hissa-dari)</name>
  <files>
    app/assets/js/core/calc.js
    app/assets/js/core/spec.js
  </files>
  <action>
    Implement validation ensuring that the sum of fractional shares across all co-owners for any Survey/Khasra parcel equals exactly 100.0%.
    Flag under-allocated or over-allocated parcels and block compensation case submission until balanced.
  </action>
  <verify>
    grep -E "100" app/assets/js/core/calc.js
  </verify>
  <done>
    Parcels with share totals != 100.0% cannot proceed to compensation case creation or payment voucher issuance.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Deceased Landowner Succession Mutations & GIS Parcel Mapping</name>
  <files>
    app/assets/js/core/spec.js
    app/assets/js/ui/gis.js
    app/assets/js/app/gis-map.js
  </files>
  <action>
    1. Mark deceased landowners with an automated payment lock.
    2. Route deceased owner cases into succession mutation workflow (*Wirasat / Intiqal*) requiring legal clearance.
    3. Render parcel geometries in MapLibre GL with interactive attribute popups and KML/KMZ decompression via JSZip.
  </action>
  <verify>
    grep -E "mutations|gisBasemap" app/assets/js/app/registry.js
  </verify>
  <done>
    Deceased landowners are locked from direct disbursement, and GIS vector map renders parcels with KML/KMZ upload capabilities.
  </done>
</task>

## Must-Haves
- [x] CNIC master key format validation enforced.
- [x] Fractional co-ownership shares validated to sum to exactly 100.0%.
- [x] Deceased owner guardrails prevent ghost payments.
- [x] MapLibre GL vector engine renders interactive cadastral boundaries.

## Success Criteria
- [x] Form validation rejects non-compliant CNICs.
- [x] Share allocation error surfaces when co-owner shares != 100%.
- [x] GIS screen successfully decompresses and renders KMZ flowline corridors.
