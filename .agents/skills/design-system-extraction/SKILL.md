---
name: design-system-extraction
description: Extract design tokens, color palettes, typography, layouts, and component specs from approved HTML references
---

# Design System Extraction Skill

<role>
You are Agent 2 — Design System & UI Compliance Specialist for the Mari Energies Limited Land Management System (LMS).
Your role is to extract and document design tokens and component specifications from the approved HTML references (`requirments/LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html` and `legacy-demo/`).
</role>

## Extracted Design Tokens

- **Core Palette**:
  - Background: `--bg: #0d1522`, `--bg-dark: #0B132B`
  - Surface: `--surface: #152133`, `--surface-2: #1a2940`, `--card: #1C2541`
  - Borders: `--border: #2a3b56`, `--border-light: #3A506B`
  - Navigation Sidebar / Header: `--side: #0f2d50`, `--primary: #16467a`, `--primary-2: #2368b0`
  - Accents:
    - Amber/Gold (Mari highlight): `--warn: #d98a06`, `#F59E0B`
    - Emerald Green (Success, Verified, Filer): `--accent: #0f9d58`, `#10B981`
    - Danger/Red (Deceased, Non-Filer, Hold, Overdue): `--danger: #d93a3a`, `#EF4444`
    - Purple (Renewals, Cadastral): `#8B5CF6`

- **Typography**:
  - Font Family: `Inter, system-ui, -apple-system, sans-serif`
  - Monospace (Identifiers, CNICs, PKR Currencies, Areas): `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
  - Hierarchy:
    - Page Titles: `text-2xl font-bold tracking-tight text-white`
    - Card Headers: `text-sm font-bold text-white`
    - Section Subtitles: `text-xs text-gray-400`
    - Monospace Data / PKR: `font-mono text-xs font-semibold`
    - Badges: `text-[10px] font-mono uppercase px-2 py-0.5 rounded-full font-bold`

- **Components & Layouts**:
  - Border Radii: `rounded-xl` (cards), `rounded-lg` (inputs, buttons), `rounded-full` (badges)
  - Shadows: `shadow-xl`, `shadow-2xl`
  - Shell: Top header banner + left sidebar collapsible navigation + main responsive viewport + corporate footer
  - Mari Energies Logo & Footprint: Official corporate badge + "Developed by Alisons Technology"
