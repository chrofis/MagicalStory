from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto('http://localhost:5173')
    
    print("Browser open - scroll through the page to see the indicator on the right!")
    print("Dots show your current section. Click them to jump!")
    print("Browser will stay open for 3 minutes...")
    
    time.sleep(180)
    browser.close()
