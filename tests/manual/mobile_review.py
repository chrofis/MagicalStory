from playwright.sync_api import sync_playwright
import time
import os

os.makedirs('temp_photos/review', exist_ok=True)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 375, 'height': 812})
        
        page.goto('https://magicalstory.ch')
        time.sleep(3)
        
        sections = page.locator('section.snap-start').all()
        print(f"Found {len(sections)} sections", flush=True)
        
        for i, section in enumerate(sections):
            try:
                section.scroll_into_view_if_needed()
                time.sleep(0.8)
                page.screenshot(path=f'temp_photos/review/mobile_sec{i+1}.png')
                print(f"Captured section {i+1}", flush=True)
            except Exception as e:
                print(f"Error section {i+1}: {e}", flush=True)
        
        # Pricing mobile
        page.goto('https://magicalstory.ch/pricing')
        time.sleep(2)
        page.screenshot(path='temp_photos/review/mobile_pricing.png', full_page=True)
        
        browser.close()
        print("Done!", flush=True)

if __name__ == '__main__':
    main()
