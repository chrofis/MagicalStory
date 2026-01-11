from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        
        # Desktop
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        page.goto('https://magicalstory.ch')
        time.sleep(3)
        
        # Full page screenshot
        page.screenshot(path='temp_photos/FULL_desktop_homepage.png', full_page=True)
        print("Saved full desktop screenshot", flush=True)
        
        # Mobile
        mobile = browser.new_page(viewport={'width': 375, 'height': 812})
        mobile.goto('https://magicalstory.ch')
        time.sleep(3)
        mobile.screenshot(path='temp_photos/FULL_mobile_homepage.png', full_page=True)
        print("Saved full mobile screenshot", flush=True)
        
        # Keep browser open to scroll manually
        print("Browser open - scroll manually to review!", flush=True)
        time.sleep(180)
        browser.close()

if __name__ == '__main__':
    main()
