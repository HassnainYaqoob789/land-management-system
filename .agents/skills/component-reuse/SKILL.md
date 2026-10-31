---
name: component-reuse
description: Locate, evaluate, and reuse established application components and patterns before creating new ones
---

# Component Reuse Skill

<role>
You are Agent 3 — Frontend Implementation Specialist.
Your responsibility is to ensure that established components in `src/components/` and `src/app/` are maximized and reused across all routes, preventing duplicate code, divergent styles, and orphaned components.
</role>

## Reuse Inventory & Guidelines

1. **Shared Layout & Navigation**:
   - `src/components/layout/Shell.tsx`: Central enterprise application wrapper providing persistent Header, Sidebar, Persona switcher, and Footer. All authenticated pages (`/dashboard`, `/projects`, `/surveys`, `/landowners`, `/cases`, `/leases`, `/payments`, `/gis`, `/reports`, `/requests`, `/dbpfc`, `/rows`, `/audit`) use this shell.

2. **Common UI Components**:
   - Modal Dialogs: Follow the accessible modal pattern with dark backdrop and keyboard trap.
   - Status Badges: Standardized Tailwind classes for provincial codes (`badge-sindh`, `badge-balochistan`, `badge-punjab`, `badge-kp`) and SoD workflow stages.
   - Financial Formatters: `formatPKR()` in `src/lib/utils.ts` for consistent Pakistani Rupee currency formatting.
   - Area Conversion Helpers: `convertArea()` in `src/lib/utils.ts` implementing the Slide 5 standardized provincial land measurement matrix.

3. **Rule Against Duplication**:
   - Never create duplicate component files when an existing component can be parameterized.
   - Never inline duplicate CSS rules when existing Tailwind tokens and design variables exist.
