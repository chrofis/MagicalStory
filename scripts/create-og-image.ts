import { chromium } from 'playwright';
import path from 'path';

/**
 * Creates an Open Graph image (1200x630) for social media sharing
 */
async function createOGImage() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Set viewport to OG image size
  await page.setViewportSize({ width: 1200, height: 630 });

  // Create HTML content for the OG image
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          width: 1200px;
          height: 630px;
          background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 50%, #9333EA 100%);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-family: 'Inter', sans-serif;
          position: relative;
          overflow: hidden;
        }
        /* Decorative circles */
        .circle {
          position: absolute;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.1);
        }
        .circle1 { width: 400px; height: 400px; top: -100px; left: -100px; }
        .circle2 { width: 300px; height: 300px; bottom: -50px; right: -50px; }
        .circle3 { width: 200px; height: 200px; top: 50%; left: 80%; }

        .content {
          text-align: center;
          z-index: 1;
        }
        .sparkle {
          font-size: 48px;
          margin-bottom: 10px;
        }
        .title {
          font-family: 'Cinzel', serif;
          font-size: 72px;
          font-weight: 700;
          color: white;
          text-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
          margin-bottom: 30px;
          letter-spacing: 2px;
        }
        .tagline {
          font-size: 32px;
          color: rgba(255, 255, 255, 0.95);
          margin-bottom: 15px;
          font-weight: 500;
        }
        .subtitle {
          font-size: 26px;
          color: rgba(255, 255, 255, 0.85);
        }
        .url {
          position: absolute;
          bottom: 30px;
          font-size: 22px;
          color: rgba(255, 255, 255, 0.7);
          letter-spacing: 1px;
        }
      </style>
    </head>
    <body>
      <div class="circle circle1"></div>
      <div class="circle circle2"></div>
      <div class="circle circle3"></div>

      <div class="content">
        <div class="sparkle">✨📚✨</div>
        <h1 class="title">Magical Story</h1>
        <p class="tagline">Create personalized children's books</p>
        <p class="subtitle">with AI-generated illustrations</p>
      </div>

      <div class="url">magicalstory.ch</div>
    </body>
    </html>
  `;

  await page.setContent(html);

  // Wait for fonts to load
  await page.waitForTimeout(1000);

  // Take screenshot
  const outputPath = path.join(__dirname, '../client/public/og-image.jpg');
  await page.screenshot({
    path: outputPath,
    type: 'jpeg',
    quality: 90
  });

  console.log(`OG image created at: ${outputPath}`);

  await browser.close();
}

createOGImage().catch(console.error);
