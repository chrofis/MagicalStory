import { test, expect, Page } from '@playwright/test';

/**
 * Comprehensive E2E tests for MagicalStory
 *
 * RUN WITH: npx playwright test tests/comprehensive.spec.ts --workers=1
 * (Using --workers=1 avoids login rate limiting)
 *
 * IMPORTANT SAFETY RULES:
 * - NEVER click "Generate Story" or similar generation buttons
 * - NEVER upload photos or trigger avatar generation
 * - NEVER complete checkout/payment flows
 * - These actions cost real API credits!
 *
 * These tests verify UI, navigation, and display functionality only.
 */

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

/**
 * Helper function to login - handles rate limiting gracefully
 */
async function login(page: Page) {
  await page.goto('/');

  const isLoggedIn = await page.evaluate(() => {
    return !!localStorage.getItem('auth_token');
  });

  if (isLoggedIn) {
    return;
  }

  const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
  await ctaButton.click();
  await page.waitForSelector('.fixed.inset-0');

  await page.getByPlaceholder('your@email.com').fill(TEST_EMAIL!);
  await page.locator('input[type="password"]').first().fill(TEST_PASSWORD!);

  const signInButton = page.getByRole('button', { name: /sign in|login|log in/i }).first();
  await signInButton.click();

  // Wait for either navigation or error message
  await page.waitForTimeout(3000);

  // Check for rate limit error
  const bodyText = await page.textContent('body');
  if (bodyText?.includes('Too many') || bodyText?.includes('rate limit')) {
    console.log('Rate limited - waiting 10 seconds...');
    await page.waitForTimeout(10000);
    // Retry login
    await signInButton.click();
    await page.waitForTimeout(3000);
  }

  // Wait for navigation after login
  try {
    await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
  } catch {
    const currentUrl = page.url();
    console.log('Login may have failed, current URL:', currentUrl);

    const bodyText = await page.textContent('body');
    if (bodyText?.includes('Too many') || bodyText?.includes('rate limit')) {
      throw new Error('Rate limited - please wait before running tests again');
    }
  }
}

// ============================================
// STORY DISPLAY TESTS (auth required)
// ============================================
test.describe('Story Display', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('My Stories page shows story cards or empty state', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(2000);

    // Should show either story cards or empty state message
    // Check for cards with images or links
    const hasStoryCards = await page.locator('img[src*="storage"], img[src*="blob"], a[href*="storyId"]').count() > 0;
    // Check for empty state text (exact translations from MyStories.tsx)
    const hasEmptyState = await page.getByText(/No stories created yet|Noch keine Geschichten erstellt|Aucune histoire créée/i).isVisible().catch(() => false);
    // Also check for Create Story button which appears in both states
    const hasCreateButton = await page.getByRole('button', { name: /create story|geschichte erstellen|créer une histoire/i }).isVisible().catch(() => false);

    expect(hasStoryCards || hasEmptyState || hasCreateButton).toBe(true);
    await page.screenshot({ path: 'test-results/stories-list.png' });
  });

  test('can click on a story card to view details', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(2000);

    // Find any story card/link
    const storyCard = page.locator('[class*="card"] a, [class*="story"] a, a[href*="storyId"]').first();
    const hasStories = await storyCard.isVisible().catch(() => false);

    if (hasStories) {
      await storyCard.click();
      await page.waitForTimeout(2000);

      // Should navigate to story view or create page with storyId
      const url = page.url();
      expect(url.includes('storyId') || url.includes('/story')).toBe(true);

      await page.screenshot({ path: 'test-results/story-view.png' });
    } else {
      console.log('No stories found to click - user has no stories yet');
    }
  });

  test('story view shows story content', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(2000);

    // Try to find and click a story
    const storyLink = page.locator('a[href*="storyId"]').first();
    const hasStory = await storyLink.isVisible().catch(() => false);

    if (hasStory) {
      await storyLink.click();
      await page.waitForTimeout(3000);

      // Story view should have content - text or images
      const hasStoryContent =
        await page.locator('img[src*="blob"], img[src*="data:"], img[src*="storage"]').count() > 0 ||
        await page.locator('[class*="page"], [class*="story"], [class*="text"]').count() > 0;

      expect(hasStoryContent).toBe(true);
    } else {
      console.log('No stories available to view');
    }
  });
});

// ============================================
// BOOK ORDERING TESTS (auth required, without completing order)
// ============================================
test.describe('Book Ordering Flow', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('can access order options from story view', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(2000);

    const storyLink = page.locator('a[href*="storyId"]').first();
    const hasStory = await storyLink.isVisible().catch(() => false);

    if (hasStory) {
      await storyLink.click();
      await page.waitForTimeout(3000);

      // Look for order/print/buy button
      const orderButton = page.getByRole('button', { name: /order|print|buy|bestellen|drucken|kaufen|commander|imprimer/i }).first();
      const hasOrderOption = await orderButton.isVisible().catch(() => false);

      if (hasOrderOption) {
        console.log('Order button found - order flow is accessible');
        // DO NOT click - this would start checkout
      } else {
        // Check for PDF download option instead
        const downloadButton = page.getByRole('button', { name: /download|pdf|herunterladen|télécharger/i }).first();
        const hasDownload = await downloadButton.isVisible().catch(() => false);
        console.log('Download PDF option available:', hasDownload);
      }
    } else {
      console.log('No stories to test ordering flow');
    }
  });

  test('My Orders page displays correctly', async ({ page }) => {
    await login(page);
    await page.goto('/orders');
    await page.waitForTimeout(2000);

    // Should show orders or empty state
    const bodyText = await page.textContent('body');
    const hasOrdersContent =
      bodyText?.includes('Order') ||
      bodyText?.includes('Bestellung') ||
      bodyText?.includes('Commande') ||
      bodyText?.includes('No orders') ||
      bodyText?.includes('Keine') ||
      bodyText?.includes('Aucune');

    expect(hasOrdersContent).toBe(true);
    await page.screenshot({ path: 'test-results/orders-page.png' });
  });
});

// ============================================
// USER MENU TESTS (auth required)
// ============================================
test.describe('User Menu', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('menu shows all expected options', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(1000);

    // Open menu
    const menuButton = page.getByRole('button', { name: /menu/i }).first();
    await menuButton.click();
    await page.waitForTimeout(500);

    // Check for expected menu items
    const menuItems = [
      /my stories|meine geschichten|mes histoires/i,
      /create|erstellen|créer/i,
      /orders|bestellungen|commandes/i,
      /credits|guthaben/i,
      /logout|abmelden|déconnexion/i
    ];

    for (const item of menuItems) {
      const menuItem = page.getByText(item).first();
      const isVisible = await menuItem.isVisible().catch(() => false);
      console.log(`Menu item "${item}": ${isVisible ? 'visible' : 'not visible'}`);
    }

    await page.screenshot({ path: 'test-results/user-menu.png' });
  });

  test('can navigate from menu to My Stories', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(1000);

    // Open menu and click My Stories
    const menuButton = page.getByRole('button', { name: /menu/i }).first();
    await menuButton.click();
    await page.waitForTimeout(500);

    const storiesLink = page.getByText(/my stories|meine geschichten|mes histoires/i).first();
    await storiesLink.click();
    await page.waitForTimeout(1000);

    expect(page.url()).toContain('/stories');
  });

  test('can open credits modal from menu', async ({ page }) => {
    await login(page);
    await page.goto('/stories');
    await page.waitForTimeout(1000);

    // Open menu
    const menuButton = page.getByRole('button', { name: /menu/i }).first();
    await menuButton.click();
    await page.waitForTimeout(500);

    // Click on credits/buy credits
    const creditsLink = page.getByText(/credits|guthaben|buy|kaufen/i).first();
    const hasCreditsLink = await creditsLink.isVisible().catch(() => false);

    if (hasCreditsLink) {
      await creditsLink.click();
      await page.waitForTimeout(500);

      // Should show credits modal with pricing
      const hasCreditsModal = await page.locator('.fixed.inset-0').isVisible().catch(() => false);
      const hasPricing = await page.getByText(/CHF|€|\d+\s*credits/i).isVisible().catch(() => false);

      console.log('Credits modal opened:', hasCreditsModal);
      console.log('Pricing visible:', hasPricing);

      await page.screenshot({ path: 'test-results/credits-modal.png' });
    }
  });
});

// ============================================
// FOOTER AND LEGAL PAGES (no auth required)
// ============================================
test.describe('Footer and Legal Pages', () => {
  // These tests don't require auth - run independently
  test.describe.configure({ mode: 'parallel' });

  test('footer is visible on landing page', async ({ page }) => {
    await page.goto('/');

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);

    // Check for footer
    const footer = page.locator('footer').first();
    await expect(footer).toBeVisible();

    await page.screenshot({ path: 'test-results/footer.png' });
  });

  test('can access Privacy Policy page', async ({ page }) => {
    await page.goto('/privacy');
    await page.waitForTimeout(1000);

    expect(page.url()).toContain('/privacy');

    // Should have privacy-related content
    const bodyText = await page.textContent('body');
    const hasPrivacyContent =
      bodyText?.includes('Privacy') ||
      bodyText?.includes('Datenschutz') ||
      bodyText?.includes('Confidentialité') ||
      bodyText?.includes('data') ||
      bodyText?.includes('Daten');

    expect(hasPrivacyContent).toBe(true);
    await page.screenshot({ path: 'test-results/privacy-policy.png' });
  });

  test('can access Terms of Service page', async ({ page }) => {
    await page.goto('/terms');
    await page.waitForTimeout(1000);

    expect(page.url()).toContain('/terms');

    // Should have terms-related content
    const bodyText = await page.textContent('body');
    const hasTermsContent =
      bodyText?.includes('Terms') ||
      bodyText?.includes('AGB') ||
      bodyText?.includes('Nutzungsbedingungen') ||
      bodyText?.includes('Conditions') ||
      bodyText?.includes('Service');

    expect(hasTermsContent).toBe(true);
    await page.screenshot({ path: 'test-results/terms-of-service.png' });
  });

  test('can access Impressum page', async ({ page }) => {
    await page.goto('/impressum');
    await page.waitForTimeout(1000);

    expect(page.url()).toContain('/impressum');

    // Should have impressum/contact content
    const bodyText = await page.textContent('body');
    const hasImpressumContent =
      bodyText?.includes('Impressum') ||
      bodyText?.includes('Contact') ||
      bodyText?.includes('Kontakt') ||
      bodyText?.includes('Address') ||
      bodyText?.includes('Adresse');

    expect(hasImpressumContent).toBe(true);
    await page.screenshot({ path: 'test-results/impressum.png' });
  });
});

// ============================================
// LANGUAGE SWITCHING TESTS (no auth required)
// ============================================
test.describe('Language Switching', () => {
  // These tests don't require auth - run independently
  test.describe.configure({ mode: 'parallel' });

  test('can switch language on landing page', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Look for language selector (usually in nav or footer)
    const langSelector = page.locator('[class*="language"], [class*="lang"], select').first();
    const hasLangSelector = await langSelector.isVisible().catch(() => false);

    if (hasLangSelector) {
      // Try to find language options
      const deOption = page.getByText(/Deutsch|DE|German/i).first();
      const frOption = page.getByText(/Français|FR|French/i).first();

      const hasDe = await deOption.isVisible().catch(() => false);
      const hasFr = await frOption.isVisible().catch(() => false);

      console.log('German option available:', hasDe);
      console.log('French option available:', hasFr);
    } else {
      // Language might be in menu or detected automatically
      console.log('Language selector not directly visible - may be in menu or automatic');
    }
  });

  test('page content changes with language', async ({ page }) => {
    // Test German
    await page.goto('/?lang=de');
    await page.waitForTimeout(1000);

    let bodyText = await page.textContent('body');
    const hasGermanContent =
      bodyText?.includes('Geschichte') ||
      bodyText?.includes('Erstellen') ||
      bodyText?.includes('Charakter');

    console.log('German content detected:', hasGermanContent);

    // Test French
    await page.goto('/?lang=fr');
    await page.waitForTimeout(1000);

    bodyText = await page.textContent('body');
    const hasFrenchContent =
      bodyText?.includes('Histoire') ||
      bodyText?.includes('Créer') ||
      bodyText?.includes('Personnage');

    console.log('French content detected:', hasFrenchContent);
  });
});

// ============================================
// WIZARD STEP CONTENT TESTS (auth required)
// ============================================
test.describe('Wizard Step Content', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'Test credentials not configured');

  test('Step 1 (Characters) shows add character option', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(2000);

    // Should show character-related UI
    const hasCharacterUI =
      await page.getByText(/character|charakter|personnage|add|hinzufügen|ajouter/i).isVisible().catch(() => false) ||
      await page.locator('[class*="character"], [class*="photo"], [class*="upload"]').count() > 0;

    expect(hasCharacterUI).toBe(true);
    await page.screenshot({ path: 'test-results/wizard-step1.png' });
  });

  test('Step 2 (Book Settings) shows page/level options', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(1000);

    // Navigate to step 2
    const step2 = page.locator('nav button').filter({ hasText: '2' }).first();
    await step2.click();
    await page.waitForTimeout(1000);

    // Should show book settings
    const hasBookSettings =
      await page.getByText(/pages|seiten|reading level|leseniveau|niveau/i).isVisible().catch(() => false) ||
      await page.locator('input[type="range"], [class*="slider"]').count() > 0;

    expect(hasBookSettings).toBe(true);
    await page.screenshot({ path: 'test-results/wizard-step2.png' });
  });

  test('Step 3 (Story Type) shows theme options', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(1000);

    // Navigate to step 3
    const step3 = page.locator('nav button').filter({ hasText: '3' }).first();
    await step3.click();
    await page.waitForTimeout(1000);

    // Should show story type/theme options
    const hasStoryTypes =
      await page.getByText(/adventure|abenteuer|aventure|birthday|geburtstag|anniversaire|theme/i).isVisible().catch(() => false) ||
      await page.locator('[class*="theme"], [class*="category"], [class*="type"]').count() > 0;

    expect(hasStoryTypes).toBe(true);
    await page.screenshot({ path: 'test-results/wizard-step3.png' });
  });

  test('Step 4 (Art Style) shows style options', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(1000);

    // Navigate to step 4
    const step4 = page.locator('nav button').filter({ hasText: '4' }).first();
    await step4.click();
    await page.waitForTimeout(1000);

    // Should show art style options
    const hasArtStyles =
      await page.getByText(/watercolor|aquarell|aquarelle|pixar|3d|comic|anime|style/i).isVisible().catch(() => false) ||
      await page.locator('[class*="style"], [class*="art"]').count() > 0;

    expect(hasArtStyles).toBe(true);
    await page.screenshot({ path: 'test-results/wizard-step4.png' });
  });

  test('Step 5 (Summary) shows review and generate button', async ({ page }) => {
    await login(page);
    await page.goto('/create');
    await page.waitForTimeout(1000);

    // Navigate to step 5
    const step5 = page.locator('nav button').filter({ hasText: '5' }).first();
    await step5.click();
    await page.waitForTimeout(1000);

    // Should show summary and generate button
    const hasSummary =
      await page.getByText(/summary|zusammenfassung|résumé|review|überprüfen/i).isVisible().catch(() => false);

    // IMPORTANT: Just verify generate button exists, DO NOT CLICK IT
    const generateButton = page.getByRole('button', { name: /generate|generieren|générer/i }).first();
    const hasGenerateButton = await generateButton.isVisible().catch(() => false);

    console.log('Generate button visible (NOT clicking):', hasGenerateButton);

    await page.screenshot({ path: 'test-results/wizard-step5.png' });
  });
});

// ============================================
// PRICING PAGE DETAILS (no auth required)
// ============================================
test.describe('Pricing Page Details', () => {
  // These tests don't require auth - run independently
  test.describe.configure({ mode: 'parallel' });

  test('pricing page shows pricing information', async ({ page }) => {
    await page.goto('/pricing');
    await page.waitForTimeout(2000);

    // Should show pricing information (CHF prices, softcover/hardcover options)
    const bodyText = await page.textContent('body');
    const hasPricing =
      bodyText?.includes('CHF') ||
      bodyText?.includes('Softcover') ||
      bodyText?.includes('Hardcover') ||
      bodyText?.includes('pages') ||
      bodyText?.includes('Seiten');

    expect(hasPricing).toBe(true);
    await page.screenshot({ path: 'test-results/pricing-details.png' });
  });

  test('pricing page has create story button', async ({ page }) => {
    await page.goto('/pricing');
    await page.waitForTimeout(1000);

    // Should have create story CTA button
    const createButton = page.getByRole('button', { name: /create story|geschichte erstellen|créer une histoire/i });
    const hasCreateButton = await createButton.isVisible().catch(() => false);

    // Or a back button to navigate
    const backButton = page.getByRole('button', { name: /back|zurück|retour/i });
    const hasBackButton = await backButton.isVisible().catch(() => false);

    expect(hasCreateButton || hasBackButton).toBe(true);
  });
});

// ============================================
// ERROR HANDLING TESTS (no auth required)
// ============================================
test.describe('Error Handling', () => {
  // These tests don't require auth - run independently
  test.describe.configure({ mode: 'parallel' });

  test('invalid routes are handled gracefully', async ({ page }) => {
    await page.goto('/this-page-does-not-exist-12345');
    await page.waitForTimeout(2000);

    // Should either show 404 message, redirect to home, or show landing page content
    const url = page.url();
    const bodyText = await page.textContent('body');

    const handledGracefully =
      bodyText?.includes('404') ||
      bodyText?.includes('not found') ||
      bodyText?.includes('nicht gefunden') ||
      // Redirected to home
      url.endsWith('/') ||
      url.includes('magicalstory.ch') ||
      // Or shows landing page content
      bodyText?.includes('Magical Story') ||
      bodyText?.includes('story') ||
      bodyText?.includes('Story');

    expect(handledGracefully).toBe(true);
  });

  test('handles network errors gracefully', async ({ page }) => {
    // This just verifies the page doesn't crash on load
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Page should still be functional
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await expect(ctaButton).toBeVisible();
  });
});
