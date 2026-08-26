import { test, expect } from '@playwright/test';

// Verifies the restructured ImageHistoryModal renders the new layout for an
// existing repaired story (job_1777701999612_we3rb9u7b — Wilhelm Tell, p3).
// The CRITICAL physics issue on v1 must now be visible in the issues list.

test.use({ storageState: '.auth/user.json' });

test('Image history modal — page 3 v1 shows new layout with CRITICAL', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/create?storyId=job_1777701999612_we3rb9u7b');

  // Wait for the page-3 image card to render (story may need a moment to load
  // from the server; sceneImages render lazily).
  await page.getByRole('heading', { name: /Seite 3|Page 3/i }).first().waitFor({ timeout: 60_000 });

  // Click the "Bild wählen" button for page 3 (each page has its own button).
  // We look for the page 3 section and click the select-image button inside it.
  const page3Section = page.locator('[data-page-number="3"], section, div').filter({ has: page.getByRole('heading', { name: /Seite 3|Page 3/i }) }).first();
  const selectButton = page.getByRole('button', { name: /Bild wählen|Select Image/i });
  // There are 10+ such buttons; we want the one nearest to "Seite 3". Use nth.
  // Easier: enable developer mode first if not already on, then click the 3rd
  // page's button — pages are rendered in order.
  await selectButton.nth(2).click();  // p1 = nth(0), p2 = nth(1), p3 = nth(2)

  // Modal opens — find the "V2" version (v1 in our 0-indexed analysis = display label "V2"
  // because v0 is "Original"). Click it to show the detail panel.
  const v2Tile = page.getByText(/^V2$/).first();
  await v2Tile.click();

  // === ASSERTIONS ON NEW LAYOUT ===

  // 1. Method header at the top
  await expect(page.getByText(/^Method|^Methode/).first()).toBeVisible();

  // 2. Repair instruction block (since v1 is an inpaint repair)
  await expect(page.getByText(/Reparatur-Anweisung|Repair instruction/i).first()).toBeVisible();

  // 3. Score cards — Quality / Semantic / Entity
  await expect(page.getByText('visual eval').first()).toBeVisible();
  await expect(page.getByText('prompt match').first()).toBeVisible();

  // 4. Issues found panel — must include a CRITICAL badge
  await expect(page.getByText(/Issues found|Gefundene Probleme/i).first()).toBeVisible();
  // The CRITICAL badge for the physics issue (Franziska's hand on Werner's forearm)
  const criticalBadge = page.locator('span', { hasText: /^CRITICAL$/i }).first();
  await expect(criticalBadge).toBeVisible();

  // 5. Next round footer
  await expect(page.getByText(/Next round|Nächste Runde/i).first()).toBeVisible();

  // Screenshot for manual review
  await page.screenshot({
    path: 'tests/_screenshots/image-history-modal-p3-v1.png',
    fullPage: true,
  });
});
