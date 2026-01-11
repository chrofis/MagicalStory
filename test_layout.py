from playwright.sync_api import sync_playwright
import time
import os

os.makedirs('temp_photos/layout_tests', exist_ok=True)

def test_browser(browser_type, p):
    name = browser_type
    print(f"\n=== Testing {name} ===", flush=True)
    
    if name == 'chromium':
        browser = p.chromium.launch(headless=False)
    elif name == 'firefox':
        browser = p.firefox.launch(headless=False)
    elif name == 'webkit':
        browser = p.webkit.launch(headless=False)
    
    # Test desktop
    print(f"  Desktop view...", flush=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})
    page.goto('https://magicalstory.ch')
    time.sleep(3)
    page.screenshot(path=f'temp_photos/layout_tests/{name}_desktop_home.png', full_page=True)
    
    # Scroll through page
    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    time.sleep(1)
    
    # Test tablet
    print(f"  Tablet view...", flush=True)
    page2 = browser.new_page(viewport={'width': 768, 'height': 1024})
    page2.goto('https://magicalstory.ch')
    time.sleep(2)
    page2.screenshot(path=f'temp_photos/layout_tests/{name}_tablet_home.png', full_page=True)
    
    # Test mobile
    print(f"  Mobile view...", flush=True)
    page3 = browser.new_page(viewport={'width': 375, 'height': 812})
    page3.goto('https://magicalstory.ch')
    time.sleep(2)
    page3.screenshot(path=f'temp_photos/layout_tests/{name}_mobile_home.png', full_page=True)
    
    browser.close()
    print(f"  Done with {name}!", flush=True)

def main():
    print("Testing magicalstory.ch layout across browsers...", flush=True)
    
    with sync_playwright() as p:
        # Test all three browser engines
        for browser_type in ['chromium', 'firefox', 'webkit']:
            try:
                test_browser(browser_type, p)
            except Exception as e:
                print(f"  Error with {browser_type}: {e}", flush=True)
    
    print("\n=== All screenshots saved to temp_photos/layout_tests/ ===", flush=True)

if __name__ == '__main__':
    main()
