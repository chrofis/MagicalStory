from playwright.sync_api import sync_playwright
import time

def test_face_detection():
    with sync_playwright() as p:
        # Launch browser with visible window
        browser = p.chromium.launch(headless=False, slow_mo=500)
        page = browser.new_page()
        
        # Go to the app
        page.goto('http://localhost:5173')
        print("Opened app")
        
        # Keep window open for 5 minutes for manual testing
        print("Browser will stay open for 5 minutes. Test the face detection!")
        time.sleep(300)
        
        browser.close()

if __name__ == '__main__':
    test_face_detection()
