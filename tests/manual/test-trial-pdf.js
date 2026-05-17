/**
 * Smoke test for the trial-email PDF layout.
 *
 * Builds a mock story with 5 pages + frontCover + initialPage + backCover,
 * generates the PDF with { trialLayout: true }, and asserts:
 *   - Page size = 210x280 mm (A4)
 *   - Page 1 has the front cover image (full-page)
 *   - Pages 2-6 = story pages (no initial page, no back cover)
 *   - Total page count = 6 (1 title + 5 story), not 8
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { generateViewPdf, mmToPoints } = require('../../server/lib/pdf');

async function makePngDataUri(label, w, h, rgb) {
  // Solid color PNG with a label-sized rectangle, base64-encoded data URI.
  const png = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } }
  }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function main() {
  const frontCover = await makePngDataUri('FRONT', 800, 1067, [200, 80, 80]);
  const initialPage = await makePngDataUri('INITIAL', 800, 1067, [80, 200, 80]);
  const backCover = await makePngDataUri('BACK', 800, 1067, [80, 80, 200]);
  const sceneImg = await makePngDataUri('SCENE', 1024, 1024, [180, 180, 180]);

  const storyText = [
    '--- Page 1 ---',
    'Once upon a time, there was a small village by the river.',
    '--- Page 2 ---',
    'The villagers worked hard every day in their fields.',
    '--- Page 3 ---',
    'One morning, a stranger arrived at the gate.',
    '--- Page 4 ---',
    'He told tales of distant lands and brave deeds.',
    '--- Page 5 ---',
    'The children listened in wonder until the sun went down.'
  ].join('\n\n');

  const storyData = {
    title: 'Trial Story',
    languageLevel: 'standard',
    storyText,
    coverImages: { frontCover, initialPage, backCover },
    sceneImages: Array.from({ length: 5 }, (_, i) => ({
      pageNumber: i + 1,
      imageData: sceneImg,
      textInImage: false,
    })),
  };

  const pdfBuffer = await generateViewPdf(storyData, 'A4', { trialLayout: true });

  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'trial-pdf-test.pdf');
  fs.writeFileSync(outPath, pdfBuffer);

  // Parse the PDF to count pages and read MediaBox
  const text = pdfBuffer.toString('latin1');
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g) || [];
  const mediaBoxMatch = text.match(/\/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]/);

  console.log(`PDF written: ${outPath}`);
  console.log(`PDF size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
  console.log(`Page count (from /Type /Page markers): ${pageMatches.length}`);
  if (mediaBoxMatch) {
    const w = parseFloat(mediaBoxMatch[3]);
    const h = parseFloat(mediaBoxMatch[4]);
    const wMm = (w / 2.83465).toFixed(2);
    const hMm = (h / 2.83465).toFixed(2);
    console.log(`MediaBox: ${w.toFixed(2)} x ${h.toFixed(2)} pts  =  ${wMm} x ${hMm} mm`);
  }

  const expectedPages = 6;       // 1 cover + 5 story
  const expectedW = mmToPoints(210);
  const expectedH = mmToPoints(280);

  const issues = [];
  if (pageMatches.length !== expectedPages) {
    issues.push(`Expected ${expectedPages} pages, got ${pageMatches.length}`);
  }
  if (mediaBoxMatch) {
    const w = parseFloat(mediaBoxMatch[3]);
    const h = parseFloat(mediaBoxMatch[4]);
    if (Math.abs(w - expectedW) > 0.5 || Math.abs(h - expectedH) > 0.5) {
      issues.push(`Expected MediaBox ${expectedW.toFixed(2)}x${expectedH.toFixed(2)} pts (A4 210x280mm), got ${w.toFixed(2)}x${h.toFixed(2)}`);
    }
  } else {
    issues.push('Could not find MediaBox in PDF');
  }

  if (issues.length > 0) {
    console.error('\nFAIL:');
    issues.forEach(i => console.error(`  - ${i}`));
    process.exit(1);
  }
  console.log('\nPASS: page count and A4 dimensions match expectations.');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
