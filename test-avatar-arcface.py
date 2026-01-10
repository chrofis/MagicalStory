"""
Test ArcFace with real avatar generation using Playwright
"""
import asyncio
import os
from playwright.async_api import async_playwright

async def main():
    # Read password from .env
    password = None
    env_path = os.path.join(os.path.dirname(__file__), '.env')
    with open(env_path, 'r') as f:
        for line in f:
            if line.startswith('TEST_PASSWORD='):
                password = line.strip().split('=', 1)[1]
                break

    if not password:
        print("ERROR: TEST_PASSWORD not found in .env")
        return

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(viewport={'width': 1400, 'height': 900})
        page = await context.new_page()

        print("1. Navigating to app...")
        await page.goto('http://localhost:5173')
        await page.wait_for_load_state('networkidle')

        print("2. Logging in...")
        # Take screenshot to see current state
        await page.screenshot(path='test-results/step1-before-login.png')

        # Try different login button selectors
        login_selectors = [
            'text=Login',
            'text=Sign In',
            'button:has-text("Login")',
            'button:has-text("Sign In")',
            'a:has-text("Login")',
            '[data-testid="login-button"]'
        ]

        login_clicked = False
        for selector in login_selectors:
            try:
                if await page.locator(selector).count() > 0:
                    await page.click(selector, timeout=5000)
                    login_clicked = True
                    print(f"   Clicked: {selector}")
                    break
            except:
                continue

        if not login_clicked:
            # Maybe already on login page or need to find input fields directly
            print("   No login button found, looking for input fields...")

        await page.wait_for_timeout(500)

        # Fill credentials - try to find email/password inputs
        email_input = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first
        password_input = page.locator('input[type="password"], input[name="password"]').first

        if await email_input.count() > 0:
            await email_input.fill('ch_roger_fischer@yahoo.com')
            await password_input.fill(password)

            # Find and click submit button
            submit_btn = page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Login")').first
            await submit_btn.click()

        # Wait for login
        await page.wait_for_timeout(3000)
        print("   Logged in!")

        print("3. Going to Characters page...")
        await page.screenshot(path='test-results/step2-after-login.png')

        # Click Menu first if needed
        menu_btn = page.locator('text=Menu, button:has-text("Menu")')
        if await menu_btn.count() > 0:
            await menu_btn.first.click()
            await page.wait_for_timeout(500)

        # Try to find and click Characters link
        chars_clicked = False
        for selector in ['a:has-text("Characters")', 'text=Characters', '[href*="character"]']:
            try:
                loc = page.locator(selector)
                if await loc.count() > 0:
                    await loc.first.click()
                    chars_clicked = True
                    print(f"   Clicked: {selector}")
                    break
            except:
                continue
        await page.wait_for_timeout(2000)
        await page.screenshot(path='test-results/step3-characters-page.png')

        print("4. Opening first character...")
        # Look for character cards or names
        # Try clicking on a character photo/card
        char_selectors = [
            'img[alt*="character" i]',
            '[class*="character-card"]',
            '[class*="CharacterCard"]',
            'button:has-text("Edit")',  # Edit button for a character
            'img[src*="cloudflare"]',   # Character photos are on cloudflare
        ]

        for selector in char_selectors:
            elements = await page.locator(selector).all()
            if elements:
                print(f"   Found {len(elements)} elements with {selector}")
                await elements[0].click()
                await page.wait_for_timeout(1500)
                break

        await page.screenshot(path='test-results/step4-character-detail.png')

        print("5. Looking for Generate Clothing Avatars button...")
        # Scroll down to find the button
        await page.evaluate('window.scrollBy(0, 500)')
        await page.wait_for_timeout(500)

        # Find and click the generate clothing avatars button
        gen_button = page.locator('button:has-text("Generate Clothing Avatars")')
        if await gen_button.count() > 0:
            print("   Found button, clicking...")
            await gen_button.click()

            print("6. Waiting for avatar generation (this takes ~30-60 seconds)...")
            # Wait for generation to complete - look for the results to appear
            await page.wait_for_timeout(60000)  # Wait 60 seconds

            print("7. Checking for ArcFace results in developer display...")
            # Look for ArcFace scores in the page
            page_content = await page.content()

            if 'ID:' in page_content:
                print("   Found ArcFace results!")
                # Try to find the specific scores
                arcface_elements = await page.locator('text=/ID: -?\\d+\\.\\d+/').all_text_contents()
                for el in arcface_elements:
                    print(f"   {el}")
            else:
                print("   ArcFace results not visible (may need developer mode)")

            # Take a screenshot
            await page.screenshot(path='test-results/avatar-arcface-test.png')
            print("   Screenshot saved to test-results/avatar-arcface-test.png")
        else:
            print("   Button not found - character may not have a photo uploaded")
            # Take screenshot for debugging
            await page.screenshot(path='test-results/avatar-test-debug.png')

        print("\n8. Keeping browser open for 30 seconds to inspect results...")
        await page.wait_for_timeout(30000)

        await browser.close()
        print("\nTest complete!")

if __name__ == '__main__':
    asyncio.run(main())
