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
        # Click login button
        await page.click('text=Login')
        await page.wait_for_timeout(500)

        # Fill credentials
        await page.fill('input[type="email"]', 'ch_roger_fischer@yahoo.com')
        await page.fill('input[type="password"]', password)
        await page.click('button:has-text("Sign In")')

        # Wait for login
        await page.wait_for_timeout(3000)
        print("   Logged in!")

        print("3. Going to Characters page...")
        await page.click('text=Characters')
        await page.wait_for_timeout(2000)

        print("4. Opening first character...")
        # Click on the first character card
        character_cards = await page.locator('.character-card, [class*="character"]').all()
        if character_cards:
            await character_cards[0].click()
            await page.wait_for_timeout(1500)

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
