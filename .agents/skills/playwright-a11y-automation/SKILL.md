---
name: playwright-a11y-automation
description: Playwright end-to-end browser automation, axe-core WCAG 2.1 AA accessibility auditing, and responsive layout verification
---

# Playwright & Accessibility Automation Skill

<role>
You are a Principal Test Automation Architect and Accessibility (A11y) Specialist specializing in Playwright, `@axe-core/playwright`, WCAG 2.1 AA compliance, and cross-device responsive layout verification.
</role>

---

## 1. Purpose & Scope

Automate browser testing and accessibility compliance across the LMS:
- **End-to-End User Journeys**: Real browser interactions (clicking, form inputs, modal dialogs, role switching, workflow transitions).
- **Automated Accessibility Auditing**: `@axe-core/playwright` scanning on all major views (`/dashboard`, `/surveys`, `/cases`, `/landowners`, `/leases`, `/payments`, `/gis`, `/audit`, `/reports`, `/login`) against WCAG 2.1 Level AA standards.
- **Responsive Layout Verification**: Desktop (1280x800), Tablet (768x1024), and Mobile (375x667) viewports.
- **Keyboard Navigation & ARIA**: Verifying focus management, tab order, modal ESC dismissal, and screen reader labels.

---

## 2. Activation Criteria

Invoke this skill whenever:
- Adding or modifying UI pages or components (`src/app/`, `src/components/`).
- Running automated browser tests before release.
- Auditing UI accessibility compliance against WCAG 2.1 AA.
- Verifying mobile and tablet responsiveness.

---

## 3. Prerequisites

1. `@playwright/test` and `@axe-core/playwright` installed in `devDependencies`.
2. Playwright configuration in `playwright.config.ts`.
3. Running local application server at `http://localhost:3030`.
4. Chromium browser binary installed (`npx playwright install chromium`).

---

## 4. Execution Procedure

### Step 1: Configuration Setup (`playwright.config.ts`)
Ensure `playwright.config.ts` targets `http://localhost:3030`, runs headless by default, and captures screenshots on failure:
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3030',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
```

### Step 2: Accessibility Test Pattern (`tests/e2e/accessibility.spec.ts`)
Scan pages using `@axe-core/playwright`:
```typescript
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Dashboard should have no critical accessibility violations', async ({ page }) => {
  await page.goto('/dashboard');
  const accessibilityScanResults = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast']) // where corporate brand tokens dictate
    .analyze();

  expect(accessibilityScanResults.violations).toEqual([]);
});
```

### Step 3: End-to-End User Flow Tests (`tests/e2e/lms_journeys.spec.ts`)
1. Login with credentials.
2. Verify Dashboard widgets and KPI metrics load.
3. Open Cadastral Surveys and inspect parcel details.
4. Interact with the 100% Share Balancer component.
5. Open Role Switcher modal and switch personas.
6. Check payment voucher verification and cheque release dialog.

---

## 5. Expected Deliverables

- `playwright.config.ts` configuration.
- Comprehensive spec files in `tests/e2e/`.
- Test execution reports with passing assertions.
- Accessibility audit summary with zero critical violations.

---

## 6. Validation Steps

```bash
# Run all Playwright E2E and Accessibility tests
npx playwright test

# Run accessibility spec specifically
npx playwright test tests/e2e/accessibility.spec.ts

# Generate HTML report
npx playwright show-report
```

---

## 7. Failure Handling

- If Playwright encounters connection refused, verify the Next.js server is active on `http://localhost:3030`.
- If an accessibility violation is detected, inspect the affected DOM element, add proper `aria-label`, fix heading hierarchy (`h1` -> `h2`), or adjust contrast before rerunning.
