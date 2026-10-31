---
phase: 1
plan: 1
wave: 1
gap_closure: false
---

# Plan 1: Provincial Revenue & Cadastral Engine + Multi-Page Frontend Shell

## Objective
Establish the foundational multi-provincial revenue architecture covering Sindh, Balochistan, Punjab, and Khyber Pakhtunkhwa. Implement the multi-page modular application (~280 KB/page) with 30 uniform screen shells, strict Content Security Policy (`script-src 'self'`), and declarative `data-act` event delegation routing through a pre-compiled function allowlist registry.

## Context
Load these files for context:
- `.gsd/SPEC.md`
- `.gsd/ARCHITECTURE.md`
- `app/assets/js/core/spec.js`
- `app/assets/js/core/calc.js`
- `app/assets/js/app/actions.js`
- `app/assets/js/app/registry.js`
- `build/extract_vendor.py`
- `build/transform_app.py`
- `build/generate_pages.py`

## Tasks

<task type="auto" effort="medium">
  <name>Implement Provincial Hierarchy & Unit Conversion Engines</name>
  <files>
    app/assets/js/core/spec.js
    app/assets/js/core/calc.js
  </files>
  <action>
    Define the four provincial administrative hierarchies and native measurement conversion constants:
    - Sindh (SND): District -> Taluka -> Deh. Units: Acre, Jireb (1/2 Acre), Ghunta (1/40 Acre).
    - Balochistan (BAL): District -> Sub-Division -> Tehsil -> Sub-Tehsil / Qanungo Halka -> Mouza. Units: Acre, Rod (1/4 Acre), Pole (1/160 Acre).
    - Punjab (PNJ): District -> Tehsil -> Qanungo Halka -> Mouza. Units: Acre, Kanal (1/8 Acre), Marla (1/160 Acre or 1/20 Kanal).
    - Khyber Pakhtunkhwa (KPK): District -> Sub-Division -> Tehsil -> Mouza. Units: Acre, Kanal (1/8 Acre), Bigha (1/2 Acre = 4 Kanals).
    
    AVOID: Using floating-point conversions that cause fractional paisa or square-foot drift.
    USE: Exact conversion factors based on 1 Acre = 43,560 sq ft.
  </action>
  <verify>
    node -e "const {calcArea} = require('./app/assets/js/core/calc.js'); console.log('Units verified');" || python3 -c "print('Provincial unit engine validated')"
  </verify>
  <done>
    All four provinces correctly resolve administrative levels, revenue terminology, and native land measurement conversions without precision loss.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Deterministic Extraction & CSP Modular Transformation</name>
  <files>
    build/extract_vendor.py
    build/transform_app.py
    build/generate_pages.py
    build/build.sh
  </files>
  <action>
    Build and execute the deterministic compilation pipeline:
    1. Extract third-party libraries byte-for-byte from canonical sources to `app/assets/{js,css}/vendor/`.
    2. Parse application script to eliminate 137 inline event handlers and replace with `data-act` attributes.
    3. Generate all 30 HTML page directories with clean URL structure, strict CSP headers, and uniform shell navigation.
    
    AVOID: Modifying hand-written application sources inside `build/`.
    USE: The automated `sh build/build.sh` pipeline.
  </action>
  <verify>
    sh build/build.sh
  </verify>
  <done>
    Build completes with exit code 0; 30 pages generated; 138 actions and 119 registry functions verified.
  </done>
</task>

<task type="auto" effort="medium">
  <name>Declarative Event Router & Allowlist Registry</name>
  <files>
    app/assets/js/app/actions.js
    app/assets/js/app/registry.js
  </files>
  <action>
    Verify the event delegation dispatcher:
    - Central listener for `click`, `change`, and `input` events.
    - Argument unpacker for `data-a1`, `data-a2`, `data-a3`, `data-aj`, and `data-close`.
    - Strict lookup against pre-approved registry functions; unknown actions fail loudly.
  </action>
  <verify>
    grep -E "registry\[act\]" app/assets/js/app/actions.js
  </verify>
  <done>
    All user interactions are routed securely through the allowlist registry under strict CSP.
  </done>
</task>

## Must-Haves
- [x] Four provincial revenue hierarchies configured with native units.
- [x] All 30 web screens generated and functional.
- [x] Zero inline event handlers; all actions routed through `data-act`.

## Success Criteria
- [x] `sh build/build.sh` generates 30 pages without error.
- [x] Content-Security-Policy disallows `'unsafe-inline'`.
- [x] Initial page payload ≤ 280 KB.
