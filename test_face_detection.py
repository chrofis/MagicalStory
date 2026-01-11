from playwright.sync_api import sync_playwright
import time
import sys

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)

# Test credentials
TEST_EMAIL = "ch_roger_fischer@yahoo.com"
TEST_PASSWORD = "M1.NtFsmdS"

def test_face_detection():
    print("Starting Playwright...", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=100)
        page = browser.new_page()
        
        print("Opening app...", flush=True)
        page.goto('http://localhost:5173')
        page.wait_for_load_state('networkidle')
        time.sleep(1)
        
        # Check if we need to login
        print("Checking login status...", flush=True)
        
        # Look for login link in nav
        login_link = page.locator('a[href="/login"]').or_(page.locator('text=Anmelden')).first
        if login_link.is_visible(timeout=3000):
            print("Clicking login...", flush=True)
            login_link.click()
            page.wait_for_load_state('networkidle')
            time.sleep(1)
            
            # Fill email
            print(f"Entering email: {TEST_EMAIL}", flush=True)
            email_input = page.locator('input[type="email"]')
            email_input.fill(TEST_EMAIL)
            time.sleep(0.5)
            
            # Fill password
            print("Entering password...", flush=True)
            password_input = page.locator('input[type="password"]')
            password_input.fill(TEST_PASSWORD)
            time.sleep(0.5)
            
            # Click sign in button
            print("Clicking sign in...", flush=True)
            sign_in_btn = page.locator('button[type="submit"]')
            sign_in_btn.click()
            
            # Wait for redirect
            print("Waiting for login to complete...", flush=True)
            page.wait_for_url('**/stories**', timeout=10000)
            print("Login successful!", flush=True)
        else:
            print("Already logged in or different page", flush=True)
        
        time.sleep(2)
        
        # Now navigate to create story
        print("Looking for create story button...", flush=True)
        create_btn = page.locator('text=Geschichte erstellen').or_(page.locator('text=Create Story')).first
        if create_btn.is_visible(timeout=3000):
            print("Clicking create story...", flush=True)
            create_btn.click()
            page.wait_for_load_state('networkidle')
            time.sleep(2)
        
        print("\n=== Browser is open ===", flush=True)
        print("Navigate to step 2 (Characters) and upload a photo with 3 faces", flush=True)
        print("Browser will stay open for 5 minutes...", flush=True)
        
        time.sleep(300)
        browser.close()

if __name__ == '__main__':
    test_face_detection()
