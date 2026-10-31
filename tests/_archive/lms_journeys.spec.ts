import { test, expect } from '@playwright/test';

test.describe('E&P Land Management System — End-to-End User Journeys', () => {
  test('1. Authentication Flow: Login and Shell Header Verification', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toContainText('Land Management System');

    // Fill login form
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');

    // Should navigate to dashboard
    await page.waitForURL('**/dashboard');
    await expect(page).toHaveURL(/.*dashboard/);

    // Verify Header contains system branding
    await expect(page.locator('header')).toContainText('LMS');
  });

  test('2. Navigation & Multi-Provincial Scope Chooser', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Verify provincial scope pill button for Sindh
    const sindhButton = page.locator('header button').filter({ hasText: 'Sindh' }).first();
    if (await sindhButton.isVisible()) {
      await sindhButton.click({ force: true });
      await expect(sindhButton).toHaveClass(/bg-amber-500/);
    }

    // Navigate to Projects view
    await page.goto('/projects');
    await expect(page.locator('h1')).toContainText('E&P Concession Projects');
  });

  test('3. Cadastral Survey Inspection & 100% Share Balancer', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Navigate to surveys
    await page.goto('/surveys');
    await expect(page.locator('h1')).toContainText('Cadastral Parcels & Co-Ownership');

    // Verify parcel table renders parcels
    const balanceBtn = page.locator('button').filter({ hasText: 'Balance Shares' }).first();
    await expect(balanceBtn).toBeVisible();

    // Click balance shares to open modal
    await balanceBtn.click();
    
    // Check that modal opened with 100% share balancer
    const modal = page.locator('.fixed.inset-0').first();
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Manage Co-Ownership');
    await expect(modal).toContainText('100.0%');
  });

  test('4. 6-Tier Compensation Cases Pipeline Inspection', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Navigate to cases
    await page.goto('/cases');
    await expect(page.locator('h1')).toContainText('Compensation & Damage Cases');

    // Verify cases table contains stage badges after data fetch
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('table')).toContainText(/(Prepared|Checked|Reviewed|Verified|Field Approved|HO Approved)/);
  });

  test('5. Finance Vouchers, Liabilities & Crossed Cheque Interface', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Navigate to payments
    await page.goto('/payments');
    await expect(page.locator('h1')).toContainText('Payments, Disbursals & Liabilities');

    // Verify tabs are clickable
    const releasesTab = page.locator('button').filter({ hasText: 'Cheque Releases' }).first();
    await expect(releasesTab).toBeVisible();
    await releasesTab.click();
    await page.waitForTimeout(300);
  });

  test('6. Immutable Audit Trail Verification', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="text"]', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Navigate to audit
    await page.goto('/audit');
    await expect(page.locator('h1')).toContainText('Immutable System Audit Trail');

    // Verify audit events table contains events
    await expect(page.locator('table')).toBeVisible();
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
  });
});
