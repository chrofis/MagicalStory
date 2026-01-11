from playwright.sync_api import sync_playwright
import time
import os

os.makedirs('temp_photos/review', exist_ok=True)

def capture_all_sections(page, prefix):
    """Scroll through all sections and capture each one"""
    screenshots = []
    page.goto('https://magicalstory.ch')
    time.sleep(3)
    
    # Capture each section by pressing PageDown
    for i in range(7):
        path = f'temp_photos/review/{prefix}_section_{i+1}.png'
        page.screenshot(path=path)
        screenshots.append(path)
        page.keyboard.press('PageDown')
        time.sleep(1)
    
    return screenshots

def main():
    print("=== COMPREHENSIVE WEBSITE REVIEW ===\n", flush=True)
    
    with sync_playwright() as p:
        # Test configurations
        configs = [
            ('chromium', 'desktop', 1440, 900),
            ('chromium', 'tablet', 768, 1024),
            ('chromium', 'mobile', 375, 812),
            ('firefox', 'desktop', 1440, 900),
            ('firefox', 'mobile', 375, 812),
            ('webkit', 'desktop', 1440, 900),
            ('webkit', 'mobile', 375, 812),
        ]
        
        for browser_name, device, width, height in configs:
            print(f"Testing {browser_name} - {device} ({width}x{height})...", flush=True)
            
            if browser_name == 'chromium':
                browser = p.chromium.launch(headless=True)
            elif browser_name == 'firefox':
                browser = p.firefox.launch(headless=True)
            else:
                browser = p.webkit.launch(headless=True)
            
            page = browser.new_page(viewport={'width': width, 'height': height})
            prefix = f'{browser_name}_{device}'
            capture_all_sections(page, prefix)
            
            # Also capture pricing page
            page.goto('https://magicalstory.ch/pricing')
            time.sleep(2)
            page.screenshot(path=f'temp_photos/review/{prefix}_pricing.png', full_page=True)
            
            browser.close()
            print(f"  Done!", flush=True)
    
    print("\n=== All screenshots saved to temp_photos/review/ ===", flush=True)

if __name__ == '__main__':
    main()
