from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        page.goto('https://magicalstory.ch')
        time.sleep(3)
        
        # The page has snap scrolling - scroll the main container
        print("Scrolling snap sections...", flush=True)
        
        # Find the scrollable container and scroll it
        for i in range(10):
            # Use keyboard to scroll (works with snap)
            page.keyboard.press('PageDown')
            time.sleep(1.5)
            print(f"Section {i+1}", flush=True)
        
        print("Scrolling back up...", flush=True)
        for i in range(10):
            page.keyboard.press('PageUp')
            time.sleep(1)
        
        print("Done! Browser open for 2 min...", flush=True)
        time.sleep(120)
        browser.close()

if __name__ == '__main__':
    main()
