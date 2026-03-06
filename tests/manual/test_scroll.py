from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        
        print("Opening magicalstory.ch...", flush=True)
        page.goto('https://magicalstory.ch')
        time.sleep(3)
        
        # Get page height
        height = page.evaluate('document.body.scrollHeight')
        print(f"Page height: {height}px", flush=True)
        
        print("Scrolling slowly through entire page...", flush=True)
        scroll_pos = 0
        step = 200
        
        while scroll_pos < height:
            page.evaluate(f'window.scrollTo({{top: {scroll_pos}, behavior: "smooth"}})')
            time.sleep(0.8)
            scroll_pos += step
            # Update height in case of lazy loading
            height = page.evaluate('document.body.scrollHeight')
        
        print("Reached bottom! Scrolling back up...", flush=True)
        time.sleep(2)
        
        # Scroll back to top slowly
        while scroll_pos > 0:
            scroll_pos -= step
            page.evaluate(f'window.scrollTo({{top: {scroll_pos}, behavior: "smooth"}})')
            time.sleep(0.5)
        
        print("Now mobile view...", flush=True)
        page.set_viewport_size({'width': 375, 'height': 812})
        time.sleep(2)
        
        height = page.evaluate('document.body.scrollHeight')
        print(f"Mobile page height: {height}px", flush=True)
        
        scroll_pos = 0
        while scroll_pos < height:
            page.evaluate(f'window.scrollTo({{top: {scroll_pos}, behavior: "smooth"}})')
            time.sleep(0.8)
            scroll_pos += step
            height = page.evaluate('document.body.scrollHeight')
        
        print("Done scrolling! Keeping open for 2 min...", flush=True)
        time.sleep(120)
        browser.close()

if __name__ == '__main__':
    main()
