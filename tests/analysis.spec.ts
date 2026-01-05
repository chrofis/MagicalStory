import { test, expect } from '@playwright/test';

/**
 * Website Analysis Tests
 * These tests analyze the website for UX issues, accessibility problems,
 * performance concerns, and improvement opportunities.
 */

const issues: string[] = [];
const improvements: string[] = [];

function logIssue(issue: string) {
  issues.push(issue);
  console.log('🔴 ISSUE:', issue);
}

function logImprovement(suggestion: string) {
  improvements.push(suggestion);
  console.log('💡 IMPROVEMENT:', suggestion);
}

test.describe('Landing Page Analysis', () => {
  test('check page load performance', async ({ page }) => {
    const startTime = Date.now();
    await page.goto('/');
    const loadTime = Date.now() - startTime;

    console.log(`Page load time: ${loadTime}ms`);

    if (loadTime > 3000) {
      logIssue(`Landing page loads slowly (${loadTime}ms) - should be under 3 seconds`);
    }

    // Check for large images that could be optimized
    const images = await page.locator('img').all();
    for (const img of images) {
      const src = await img.getAttribute('src');
      const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
      const displayWidth = await img.evaluate((el: HTMLImageElement) => el.clientWidth);

      if (naturalWidth > displayWidth * 2) {
        logImprovement(`Image "${src?.substring(0, 50)}..." is ${naturalWidth}px but displayed at ${displayWidth}px - could be optimized`);
      }
    }
  });

  test('check accessibility basics', async ({ page }) => {
    await page.goto('/');

    // Check for missing alt text on images
    const imagesWithoutAlt = await page.locator('img:not([alt])').count();
    if (imagesWithoutAlt > 0) {
      logIssue(`${imagesWithoutAlt} images missing alt text (accessibility issue)`);
    }

    // Check for proper heading hierarchy
    const h1Count = await page.locator('h1').count();
    if (h1Count === 0) {
      logIssue('No H1 heading found on landing page');
    } else if (h1Count > 1) {
      logImprovement(`Multiple H1 headings (${h1Count}) - consider using only one for SEO`);
    }

    // Check for buttons without accessible names
    const buttons = await page.locator('button').all();
    for (const button of buttons) {
      const text = await button.textContent();
      const ariaLabel = await button.getAttribute('aria-label');
      if (!text?.trim() && !ariaLabel) {
        logIssue('Button found without text or aria-label');
      }
    }

    // Check for form inputs without labels
    const inputs = await page.locator('input:not([type="hidden"])').all();
    for (const input of inputs) {
      const id = await input.getAttribute('id');
      const ariaLabel = await input.getAttribute('aria-label');
      const placeholder = await input.getAttribute('placeholder');

      if (id) {
        const hasLabel = await page.locator(`label[for="${id}"]`).count() > 0;
        if (!hasLabel && !ariaLabel) {
          logImprovement(`Input with id="${id}" has no associated label (uses placeholder: "${placeholder}")`);
        }
      }
    }
  });

  test('check mobile responsiveness', async ({ page }) => {
    // Test at mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Check for horizontal overflow
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);

    if (bodyWidth > viewportWidth) {
      logIssue(`Horizontal scroll detected on mobile (body: ${bodyWidth}px, viewport: ${viewportWidth}px)`);
    }

    // Check touch target sizes (should be at least 44x44px)
    const buttons = await page.locator('button, a').all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      if (box && (box.width < 44 || box.height < 44)) {
        const text = await button.textContent();
        logImprovement(`Touch target "${text?.substring(0, 20)}..." is ${Math.round(box.width)}x${Math.round(box.height)}px - recommend 44x44px minimum`);
      }
    }

    // Check font sizes (should be at least 16px on mobile to prevent zoom)
    const smallText = await page.locator('body').evaluate(() => {
      const elements = document.querySelectorAll('p, span, div, a, button');
      let smallCount = 0;
      elements.forEach(el => {
        const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
        if (fontSize < 14) smallCount++;
      });
      return smallCount;
    });

    if (smallText > 10) {
      logImprovement(`${smallText} elements have font size under 14px on mobile`);
    }
  });

  test('check CTA visibility and clarity', async ({ page }) => {
    await page.goto('/');

    // Check if main CTA is above the fold
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    const ctaBox = await ctaButton.boundingBox();

    if (ctaBox && ctaBox.y > 600) {
      logImprovement('Main CTA button is below the fold - consider moving it higher');
    }

    // Check CTA contrast
    const ctaStyles = await ctaButton.evaluate((el) => {
      const styles = window.getComputedStyle(el);
      return {
        backgroundColor: styles.backgroundColor,
        color: styles.color,
      };
    });
    console.log('CTA styles:', ctaStyles);
  });
});

test.describe('Auth Flow Analysis', () => {
  test('check login form UX', async ({ page }) => {
    await page.goto('/');

    // Open auth modal
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();
    await page.waitForSelector('.fixed.inset-0');

    // Check if email field has autocomplete
    const emailInput = page.getByPlaceholder('your@email.com');
    const autocomplete = await emailInput.getAttribute('autocomplete');
    if (!autocomplete || autocomplete === 'off') {
      logImprovement('Email field should have autocomplete="email" for better UX');
    }

    // Check if password field has proper type
    const passwordInput = page.locator('input[type="password"]').first();
    const passwordAutocomplete = await passwordInput.getAttribute('autocomplete');
    if (!passwordAutocomplete) {
      logImprovement('Password field should have autocomplete="current-password" for password managers');
    }

    // Check for password visibility toggle (eye icon near password field)
    const passwordContainer = passwordInput.locator('..').or(passwordInput.locator('../..'));
    const hasToggle = await passwordContainer.locator('button, [class*="toggle"], [class*="eye"]').count() > 0;
    if (!hasToggle) {
      logImprovement('Consider adding password visibility toggle');
    }

    // Check error message visibility (try invalid submit)
    await emailInput.fill('invalid');
    await page.locator('input[type="password"]').first().fill('x');
    await page.getByRole('button', { name: /sign in|login/i }).first().click();
    await page.waitForTimeout(1000);

    const errorVisible = await page.locator('[class*="error"], [class*="alert"], [role="alert"]').isVisible().catch(() => false);
    if (!errorVisible) {
      console.log('Note: Error handling should show clear error messages');
    }
  });

  test('check registration form completeness', async ({ page }) => {
    await page.goto('/');

    // Open auth modal and switch to register
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();
    await page.waitForSelector('.fixed.inset-0');

    const registerLink = page.getByText(/register|sign up|create account/i).first();
    await registerLink.click();
    await page.waitForTimeout(500);

    // Check for password requirements display
    const passwordRequirements = await page.getByText(/8 characters|min|password requirements/i).isVisible().catch(() => false);
    if (!passwordRequirements) {
      logImprovement('Show password requirements before user types (e.g., "Minimum 8 characters")');
    }

    // Check for password confirmation field
    const confirmPassword = await page.locator('input[type="password"]').count();
    if (confirmPassword < 2) {
      logImprovement('Consider adding password confirmation field to prevent typos');
    }

    // Check for terms/privacy checkbox
    const termsCheckbox = await page.locator('input[type="checkbox"]').count();
    if (termsCheckbox === 0) {
      logImprovement('Consider adding terms of service acceptance checkbox');
    }
  });
});

test.describe('Wizard Flow Analysis', () => {
  test.skip(!process.env.TEST_EMAIL, 'Requires auth');

  test('check wizard step clarity', async ({ page }) => {
    // Login first
    await page.goto('/');
    const ctaButton = page.getByRole('button', { name: /start|begin|create/i }).first();
    await ctaButton.click();
    await page.waitForSelector('.fixed.inset-0');
    await page.getByPlaceholder('your@email.com').fill(process.env.TEST_EMAIL!);
    await page.locator('input[type="password"]').first().fill(process.env.TEST_PASSWORD!);
    await page.getByRole('button', { name: /sign in|login/i }).first().click();

    try {
      await page.waitForURL(/\/(create|welcome|stories)/, { timeout: 15000 });
    } catch {
      console.log('Login failed, skipping wizard analysis');
      return;
    }

    if (!page.url().includes('/create')) {
      await page.goto('/create');
    }

    await page.waitForTimeout(3000);

    // Check step indicator visibility
    const stepIndicators = await page.locator('[class*="step"]').count();
    if (stepIndicators === 0) {
      logImprovement('Step indicators could be more prominent');
    }

    // Check for progress indication
    const progressBar = await page.locator('[class*="progress"], [role="progressbar"]').count();
    if (progressBar === 0) {
      logImprovement('Consider adding a progress bar to show overall completion');
    }

    // Check for help text on step 1
    const helpText = await page.getByText(/help|tip|hint|how to/i).count();
    if (helpText === 0) {
      logImprovement('Consider adding helper text or tooltips for first-time users');
    }

    // Check Next button disabled state clarity
    const nextButton = page.getByRole('button', { name: /next|weiter/i }).first();
    const isDisabled = await nextButton.isDisabled();
    if (isDisabled) {
      // Check if there's a message explaining why
      const whyDisabled = await page.getByText(/add.*character|need.*character|required/i).count();
      if (whyDisabled === 0) {
        logImprovement('When Next button is disabled, show why (e.g., "Add at least one character to continue")');
      }
    }

    await page.screenshot({ path: 'test-results/wizard-analysis.png' });
  });
});

test.describe('Performance Analysis', () => {
  test('check for console errors', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    page.on('pageerror', err => {
      errors.push(err.message);
    });

    await page.goto('/');
    await page.waitForTimeout(2000);

    if (errors.length > 0) {
      logIssue(`Console errors found: ${errors.slice(0, 3).join('; ')}`);
    }

    // Navigate to other pages
    await page.goto('/pricing');
    await page.waitForTimeout(1000);

    if (errors.length > 0) {
      console.log(`Total console errors: ${errors.length}`);
    }
  });

  test('check for broken links', async ({ page }) => {
    await page.goto('/');

    const links = await page.locator('a[href]').all();
    const brokenLinks: string[] = [];

    for (const link of links.slice(0, 10)) { // Check first 10 links
      const href = await link.getAttribute('href');
      if (href && href.startsWith('/') && !href.startsWith('//')) {
        const response = await page.goto(href, { waitUntil: 'domcontentloaded' });
        if (response && response.status() >= 400) {
          brokenLinks.push(href);
        }
        await page.goto('/'); // Go back
      }
    }

    if (brokenLinks.length > 0) {
      logIssue(`Broken internal links: ${brokenLinks.join(', ')}`);
    }
  });
});

test.afterAll(async () => {
  console.log('\n========================================');
  console.log('ANALYSIS SUMMARY');
  console.log('========================================\n');

  if (issues.length > 0) {
    console.log('🔴 ISSUES FOUND:', issues.length);
    issues.forEach((issue, i) => console.log(`   ${i + 1}. ${issue}`));
  } else {
    console.log('✅ No critical issues found');
  }

  console.log('');

  if (improvements.length > 0) {
    console.log('💡 IMPROVEMENT SUGGESTIONS:', improvements.length);
    improvements.forEach((imp, i) => console.log(`   ${i + 1}. ${imp}`));
  }

  console.log('\n========================================\n');
});
