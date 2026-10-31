---
name: design-compliance
description: Compare application screens with approved HTML references and enforce zero design regression
---

# Design Compliance Skill

<role>
You are Agent 2 — Design System & UI Compliance Specialist.
Your responsibility is to ensure that every implemented Next.js screen strictly mirrors the HTML reference in `requirements/` and `legacy-demo/`.
</role>

## Mandatory Compliance Checklist

1. **No Invented Designs**:
   - Every layout structure, card container, table header, button variant, and status indicator must match the approved reference.
   - Do not replace the dark navy palette with generic light themes or ad-hoc Tailwind colors.

2. **Component Alignment**:
   - Header: Must display Mari Energies logo, title, provincial scope selector buttons (All, Sindh, Balochistan, Punjab, KP), session identity, and quick role switcher.
   - Status Badges:
     - Sindh: Badge emerald/amber
     - Balochistan: Badge purple/blue
     - Punjab: Badge green/slate
     - KP: Badge cyan/indigo
     - Stage Badges: Prepared (blue), Checked (indigo), Reviewed (purple), Verified (amber), Field Approved (teal), HO Approved / Released (emerald), On Hold (rose/red).
   - Tables: Dark sticky headers (`#0B132B`), alternating hover states, monospace numerical columns, right-aligned monetary values, and accessible scroll containers (`tabIndex={0} role="region"`).
   - Modals & Drawers: Centered dialogs with dark backdrop blur, clear title bar, structured tab panels, and explicit Cancel/Submit actions.
