from playwright.sync_api import sync_playwright
import time
import os

os.makedirs('temp_photos/layout_tests', exist_ok=True)

def main():
    print("Testing full site layout...", flush=True)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        
        # Desktop full page scroll
        print("Desktop - full homepage scroll...", flush=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page.goto('https://magicalstory.ch')
        time.sleep(2)
        page.screenshot(path='temp_photos/layout_tests/full_desktop_1_top.png')
        
        # Scroll down in steps
        for i in range(2, 7):
            page.evaluate(f'window.scrollBy(0, 800)')
            time.sleep(0.5)
            page.screenshot(path=f'temp_photos/layout_tests/full_desktop_{i}_scroll.png')
        
        # Mobile full page scroll
        print("Mobile - full homepage scroll...", flush=True)
        mobile = browser.new_page(viewport={'width': 375, 'height': 812})
        mobile.goto('https://magicalstory.ch')
        time.sleep(2)
        mobile.screenshot(path='temp_photos/layout_tests/full_mobile_1_top.png')
        
        for i in range(2, 10):
            mobile.evaluate(f'window.scrollBy(0, 600)')
            time.sleep(0.5)
            mobile.screenshot(path=f'temp_photos/layout_tests/full_mobile_{i}_scroll.png')
        
        # Check pricing page
        print("Pricing page...", flush=True)
        page.goto('https://magicalstory.ch/pricing')
        time.sleep(2)
        page.screenshot(path='temp_photos/layout_tests/pricing_desktop.png', full_page=True)
        
        mobile.goto('https://magicalstory.ch/pricing')
        time.sleep(2)
        mobile.screenshot(path='temp_photos/layout_tests/pricing_mobile.png', full_page=True)
        
        browser.close()
        print("Done! Screenshots saved.", flush=True)

if __name__ == '__main__':
    main()
