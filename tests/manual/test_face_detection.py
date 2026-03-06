from playwright.sync_api import sync_playwright
import time
import sys
sys.stdout.reconfigure(line_buffering=True)

TEST_EMAIL = "ch_roger_fischer@yahoo.com"
TEST_PASSWORD = "M1.NtFsmdS"

def main():
    print("Starting...", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        
        # Go directly to login page
        print("Going to login page...", flush=True)
        page.goto('http://localhost:5173/login')
        time.sleep(2)
        
        # Take screenshot to see what's there
        page.screenshot(path="temp_photos/login_page.png")
        print("Screenshot saved to temp_photos/login_page.png", flush=True)
        
        # Fill email
        print("Filling email...", flush=True)
        page.fill('input[type="email"]', TEST_EMAIL)
        time.sleep(0.5)
        
        # Fill password  
        print("Filling password...", flush=True)
        page.fill('input[type="password"]', TEST_PASSWORD)
        time.sleep(0.5)
        
        # Screenshot before clicking
        page.screenshot(path="temp_photos/before_login.png")
        
        # Click submit
        print("Clicking login button...", flush=True)
        page.click('button[type="submit"]')
        
        # Wait for navigation
        print("Waiting for redirect...", flush=True)
        time.sleep(5)
        
        # Screenshot after login
        page.screenshot(path="temp_photos/after_login.png")
        print(f"Current URL: {page.url}", flush=True)
        
        print("\nBrowser open for 5 minutes. Test face detection now!", flush=True)
        time.sleep(300)
        browser.close()

if __name__ == '__main__':
    main()
