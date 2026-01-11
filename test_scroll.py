from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        
        print("Opening magicalstory.ch...", flush=True)
        page.goto('https://magicalstory.ch')
        time.sleep(3)
        
        print("Scrolling through the page slowly...", flush=True)
        # Smooth scroll through the page
        for i in range(20):
            page.evaluate('window.scrollBy({top: 300, behavior: "smooth"})')
            time.sleep(1)
        
        # Scroll back to top
        print("Back to top...", flush=True)
        page.evaluate('window.scrollTo({top: 0, behavior: "smooth"})')
        time.sleep(2)
        
        # Now test mobile view
        print("Testing mobile view...", flush=True)
        page.set_viewport_size({'width': 375, 'height': 812})
        time.sleep(2)
        
        print("Scrolling mobile view...", flush=True)
        for i in range(15):
            page.evaluate('window.scrollBy({top: 400, behavior: "smooth"})')
            time.sleep(1)
        
        print("Done! Keeping browser open for 2 minutes...", flush=True)
        time.sleep(120)
        browser.close()

if __name__ == '__main__':
    main()
