from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto('https://magicalstory.ch')
    time.sleep(3)
    
    # Scroll to absolute bottom
    page.evaluate('document.querySelector(".overflow-y-auto").scrollTo(0, 999999)')
    time.sleep(1)
    page.screenshot(path='temp_photos/review/footer.png')
    print("Captured footer")
    browser.close()
