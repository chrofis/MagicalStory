from playwright.sync_api import sync_playwright
import time
import os

os.makedirs('temp_photos/review', exist_ok=True)

def capture_all_sections(page, prefix, is_mobile=False):
    """Scroll through all sections using container scroll"""
    page.goto('https://magicalstory.ch')
    time.sleep(3)
    
    # Get the scrollable container (first div with overflow-y-auto)
    container = page.locator('div.overflow-y-auto').first
    
    # Get section count by looking for snap-start sections
    sections = page.locator('section.snap-start').all()
    print(f"    Found {len(sections)} sections", flush=True)
    
    # Capture each section
    for i, section in enumerate(sections):
        try:
            section.scroll_into_view_if_needed()
            time.sleep(0.8)
            page.screenshot(path=f'temp_photos/review/{prefix}_sec{i+1}.png')
        except:
            pass
    
    return len(sections)

def main():
    print("=== COMPREHENSIVE WEBSITE REVIEW ===\n", flush=True)
    
    with sync_playwright() as p:
        configs = [
            ('chromium', 'desktop', 1440, 900, False),
            ('chromium', 'mobile', 375, 812, True),
            ('firefox', 'desktop', 1440, 900, False),
            ('webkit', 'mobile', 375, 812, True),
        ]
        
        for browser_name, device, width, height, is_mobile in configs:
            print(f"Testing {browser_name} {device}...", flush=True)
            
            if browser_name == 'chromium':
                browser = p.chromium.launch(headless=True)
            elif browser_name == 'firefox':
                browser = p.firefox.launch(headless=True)
            else:
                browser = p.webkit.launch(headless=True)
            
            page = browser.new_page(viewport={'width': width, 'height': height})
            prefix = f'{browser_name}_{device}'
            capture_all_sections(page, prefix, is_mobile)
            
            # Pricing
            page.goto('https://magicalstory.ch/pricing')
            time.sleep(2)
            page.screenshot(path=f'temp_photos/review/{prefix}_pricing.png', full_page=True)
            
            browser.close()
    
    print("\nDone! Analyzing screenshots...", flush=True)

if __name__ == '__main__':
    main()
