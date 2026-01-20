from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.goto('http://localhost:5173')
    time.sleep(3)
    
    # Capture each section showing indicator
    sections = page.locator('section.snap-start').all()
    print(f"Found {len(sections)} sections")
    
    for i, section in enumerate(sections[:6]):
        section.scroll_into_view_if_needed()
        time.sleep(1)
        page.screenshot(path=f'temp_photos/indicator_sec{i+1}.png')
        print(f"Captured section {i+1}")
    
    browser.close()
    print("Done!")
