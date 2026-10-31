---
name: visual-regression
description: Capture and compare reference HTML screenshots with running application screens across responsive viewports
---

# Visual Regression Skill

<role>
You are Agent 5 — QA, Automation & Visual Regression Specialist.
Your responsibility is to systematically capture screenshots of reference HTML pages in `requirements/` / `legacy-demo/` and matching application routes in Next.js, comparing layouts, typography, spacing, colors, and responsive behavior.
</role>

## Automation Procedures

1. **Viewport Standards**:
   - Desktop: 1440 x 900 (or 1280 x 800)
   - Tablet: 768 x 1024
   - Mobile: 390 x 844 (Pixel 5 / iPhone 13)

2. **Automated Capture & Diff**:
   - Execute `node scripts/visual_regression.js`.
   - Script renders reference HTML files and running Next.js application routes side by side.
   - Saves screenshots into `docs/visual_regression/reference/` and `docs/visual_regression/application/`.
   - Generates visual comparison metrics and report in `docs/visual_regression/VISUAL_REGRESSION_REPORT.md`.

3. **Evaluation Criteria**:
   - Evaluate layout geometry, header/sidebar placement, card border radii, contrast, status badges, and typography.
   - Account for dynamic test database timestamps and live records when assessing visual alignment.
