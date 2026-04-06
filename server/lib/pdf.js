/**
 * PDF Generation Library
 *
 * Functions for generating print-ready PDFs for stories
 */

const PDFDocument = require('pdfkit');
const { log } = require('../utils/logger');

// Convert millimeters to PDF points
const mmToPoints = (mm) => mm * 2.83465;

// PDF dimensions for different book formats
// Gelato cover spread layout: Back Cover (left) + Spine (center) + Front Cover (right)
const BOOK_FORMATS = {
  // 20x20cm square format (original)
  'square': {
    pageWidth: mmToPoints(200),
    pageHeight: mmToPoints(200),
    coverWidth: mmToPoints(416),   // back + spine + front with bleed
    coverHeight: mmToPoints(206),
    bleed: mmToPoints(3),          // 3mm bleed
    spineWidth: mmToPoints(10),    // 10mm spine (adjusts based on page count in practice)
  },
  // A4-based format: 21x28cm (more text space)
  'A4': {
    pageWidth: mmToPoints(210),
    pageHeight: mmToPoints(280),
    coverWidth: mmToPoints(436),   // back + spine + front with bleed (210*2 + spine + bleed)
    coverHeight: mmToPoints(286),
    bleed: mmToPoints(3),          // 3mm bleed
    spineWidth: mmToPoints(10),    // 10mm spine
  }
};

// Default to square format for backwards compatibility
const DEFAULT_FORMAT = 'square';

// Legacy constants (for backwards compatibility)
const COVER_WIDTH = BOOK_FORMATS.square.coverWidth;
const COVER_HEIGHT = BOOK_FORMATS.square.coverHeight;
const PAGE_SIZE = BOOK_FORMATS.square.pageWidth;

// Minimum font size before warning
const MIN_FONT_SIZE_WARNING = 10;

/**
 * Extract image data from cover images (handles both string and object formats)
 */
const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

/**
 * Parse story text into individual pages
 */
function parseStoryPages(storyData) {
  const storyText = storyData.storyText || storyData.generatedStory || storyData.story || storyData.text || '';
  if (!storyText) return [];
  const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Seite|Page)\s+\d+)/i);
  return pageMatches.slice(1).filter(p => p.trim().length > 0);
}

/**
 * Calculate consistent font size that fits ALL pages
 * Returns the minimum font size needed across all pages
 *
 * @param {PDFDocument} doc - PDFKit document (for text measurement)
 * @param {Array<string>} pageTexts - Array of page texts
 * @param {number} availableWidth - Available text width
 * @param {number} availableHeight - Available text height
 * @param {number} startFontSize - Starting font size
 * @param {number} minFontSize - Minimum allowed font size
 * @param {string} align - Text alignment ('left' or 'center')
 * @returns {{fontSize: number, warning: string|null}}
 */
function calculateConsistentFontSize(doc, pageTexts, availableWidth, availableHeight, startFontSize = 14, minFontSize = 6, align = 'left') {
  const lineGap = -2;
  let minNeededFontSize = startFontSize;

  // Calculate minimum font size needed for each page
  for (let i = 0; i < pageTexts.length; i++) {
    // Compress multiple newlines to single newline (paragraphGap handles spacing)
    const cleanText = pageTexts[i].trim().replace(/^-+|-+$/g, '').trim().replace(/\n\s*\n/g, '\n');
    let fontSize = startFontSize;
    // Paragraph gap: half a line height for tighter paragraph spacing
    const paragraphGap = fontSize * 0.5;

    doc.fontSize(fontSize).font('Helvetica');
    let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align, lineGap, paragraphGap });

    // Reduce font size until text fits
    while (textHeight > availableHeight && fontSize > minFontSize) {
      fontSize -= 0.5;
      const newParagraphGap = fontSize * 0.5;
      doc.fontSize(fontSize);
      textHeight = doc.heightOfString(cleanText, { width: availableWidth, align, lineGap, paragraphGap: newParagraphGap });
    }

    // Track the smallest font size needed
    if (fontSize < minNeededFontSize) {
      minNeededFontSize = fontSize;
    }
  }

  // Generate warning if font size is below threshold
  let warning = null;
  if (minNeededFontSize < MIN_FONT_SIZE_WARNING) {
    warning = `Font size reduced to ${minNeededFontSize}pt to fit all text. Consider shortening some pages.`;
    log.warn(`⚠️  [PDF] ${warning}`);
  }

  // Check if text still doesn't fit at minimum size
  if (minNeededFontSize <= minFontSize) {
    // Verify all pages fit at this size
    const finalParagraphGap = minNeededFontSize * 0.5;
    doc.fontSize(minNeededFontSize).font('Helvetica');
    for (let i = 0; i < pageTexts.length; i++) {
      const cleanText = pageTexts[i].trim().replace(/^-+|-+$/g, '').trim().replace(/\n\s*\n/g, '\n');
      const textHeight = doc.heightOfString(cleanText, { width: availableWidth, align, lineGap, paragraphGap: finalParagraphGap });
      if (textHeight > availableHeight) {
        const errorMsg = `Page ${i + 1} text too long even at minimum font size (${minFontSize}pt). Please shorten the text.`;
        log.error(`❌ [PDF] ${errorMsg}`);
        throw new Error(errorMsg);
      }
    }
  }

  log.debug(`📄 [PDF] Consistent font size: ${minNeededFontSize}pt for ${pageTexts.length} pages`);
  return { fontSize: minNeededFontSize, warning };
}

/**
 * Generate print-ready PDF for a single story
 * Layout: Back+Front cover spread → Initial page → Story pages
 *
 * @param {Object} storyData - Story data with coverImages, sceneImages, storyText, etc.
 * @param {string} bookFormat - Book format: 'square' (200x200mm) or 'portrait' (210x280mm)
 * @param {Object} options - Optional settings { actualSpineWidth: number (mm) }
 * @returns {Promise<{pdfBuffer: Buffer, pageCount: number, fontSizeWarning: string|null}>}
 */
async function generatePrintPdf(storyData, bookFormat = DEFAULT_FORMAT, options = {}) {
  // Get dimensions for the selected format
  const format = BOOK_FORMATS[bookFormat] || BOOK_FORMATS[DEFAULT_FORMAT];
  const { pageWidth, pageHeight, coverWidth, coverHeight } = format;

  // Interior pages include bleed area (3mm each side) - Gelato requires this
  const bleed = format.bleed || mmToPoints(3);
  const interiorPageWidth = pageWidth + 2 * bleed;
  const interiorPageHeight = pageHeight + 2 * bleed;

  log.debug(`📄 [PRINT PDF] Using format: ${bookFormat} — content: ${Math.round(pageWidth / 2.83465)}x${Math.round(pageHeight / 2.83465)}mm, page with bleed: ${Math.round(interiorPageWidth / 2.83465)}x${Math.round(interiorPageHeight / 2.83465)}mm`);

  // Cover dimensions from Gelato API (exact size for page 1)
  const gelatoCoverDims = options.gelatoCoverDims;
  let coverSpreadWidth, coverSpreadHeight;
  let contentBack, contentFront; // { width, height, left, top } in mm

  if (gelatoCoverDims && gelatoCoverDims.coverPageWidth) {
    // Use exact dimensions from Gelato API
    coverSpreadWidth = mmToPoints(gelatoCoverDims.coverPageWidth);
    coverSpreadHeight = mmToPoints(gelatoCoverDims.coverPageHeight);
    contentBack = gelatoCoverDims.contentBack;   // mm
    contentFront = gelatoCoverDims.contentFront;  // mm
    log.debug(`📄 [PRINT PDF] Cover from Gelato API: ${gelatoCoverDims.coverPageWidth}x${gelatoCoverDims.coverPageHeight}mm`);
  } else {
    // Fallback: calculate from format (for softcover or when API unavailable)
    const spineWidthMm = gelatoCoverDims?.spineWidth || 10;
    coverSpreadWidth = bleed + pageWidth + mmToPoints(spineWidthMm) + pageWidth + bleed;
    coverSpreadHeight = pageHeight + 2 * bleed;
    // Estimate content areas
    const bleedMm = 3;
    const pageWidthMm = Math.round(pageWidth / 2.83465);
    contentBack = { left: bleedMm, top: bleedMm, width: pageWidthMm, height: Math.round(pageHeight / 2.83465) };
    contentFront = { left: bleedMm + pageWidthMm + spineWidthMm, top: bleedMm, width: pageWidthMm, height: Math.round(pageHeight / 2.83465) };
    log.debug(`📄 [PRINT PDF] Cover from fallback calc: ${Math.round(coverSpreadWidth / 2.83465)}x${Math.round(coverSpreadHeight / 2.83465)}mm`);
  }

  const doc = new PDFDocument({
    size: [coverSpreadWidth, coverSpreadHeight],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const pdfPromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  // PAGE 1: Cover spread - use exact Gelato dimensions
  doc.addPage({ size: [coverSpreadWidth, coverSpreadHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

  if (backCoverImageData && frontCoverImageData) {
    const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    // Extend cover images into the bleed area (outer edge + top + bottom).
    // Stop at the spine edge so back/front don't bleed into each other.
    // Gelato content rectangles already exclude bleed; we add it back on the
    // outer side and on top/bottom to fill the trim-safe margin.
    const backLeft = 0;
    const backRight = mmToPoints(contentBack.left + contentBack.width); // up to spine edge
    const backImgX = backLeft;
    const backImgY = 0;
    const backImgW = backRight - backLeft;
    const backImgH = coverSpreadHeight;

    const frontLeft = mmToPoints(contentFront.left); // start at spine edge
    const frontRight = coverSpreadWidth;             // up to right page edge (incl. bleed)
    const frontImgX = frontLeft;
    const frontImgY = 0;
    const frontImgW = frontRight - frontLeft;
    const frontImgH = coverSpreadHeight;

    doc.image(backCoverBuffer, backImgX, backImgY, { fit: [backImgW, backImgH], align: 'center', valign: 'center' });
    doc.image(frontCoverBuffer, frontImgX, frontImgY, { fit: [frontImgW, frontImgH], align: 'center', valign: 'center' });
  }

  // Page 2: Blank left page (required by Gelato - left side of first spread)
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  // Page 3: Initial/dedication page (right side of first spread).
  // Image fills the entire page including bleed (outer 3mm gets trimmed off).
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  if (initialPageImageData) {
    const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
    const initialPageBuffer = Buffer.from(initialPageData, 'base64');
    doc.image(initialPageBuffer, 0, 0, { fit: [interiorPageWidth, interiorPageHeight], align: 'center', valign: 'center' });
  }

  // Parse story pages
  const storyPages = parseStoryPages(storyData);
  if (storyPages.length === 0) {
    throw new Error('Story text not found in story data. Available keys: ' + Object.keys(storyData).join(', '));
  }

  log.debug(`📄 [PRINT PDF] Found ${storyPages.length} story pages`);

  // Picture-book layout (image on top, text below) is now the default for all
  // language levels. The image/text ratio (0.75) leaves enough room for the
  // longest stories with adaptive font sizing. This halves the page count
  // (and printing cost) compared to the old 2-page-per-scene layout.
  const isPictureBook = true;
  log.debug(`📄 [PRINT PDF] Layout: Picture Book (image + text on one page)`);

  // Calculate consistent font size for all pages BEFORE rendering
  // Text gets 25% of page height — fits ~200 words at 11pt in A4 portrait.
  let fontSizeWarning = null;
  let consistentFontSize;

  const textMargin = mmToPoints(3);
  const textWidth = pageWidth - (textMargin * 2);
  const textAreaHeight = pageHeight * 0.25;
  const availableTextHeight = textAreaHeight - textMargin;

  const fontResult = calculateConsistentFontSize(doc, storyPages, textWidth, availableTextHeight, 14, 8, 'center');
  consistentFontSize = fontResult.fontSize;
  fontSizeWarning = fontResult.warning;

  // Add content pages (with consistent font size)
  // Pass bleed so pages are sized with bleed and content is offset inward
  addPictureBookPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize, bleed);

  // Gelato pageCount = interior pages only (dedication + story content).
  // Does NOT count: cover spread, inside front cover blank, inside back cover blank.
  // Gelato expects total PDF pages = pageCount + 3.
  const storyContentPages = storyPages.length;
  let gelatoPageCount = 1 + storyContentPages; // dedication + story content

  // Gelato requires even page count for double-sided printing
  if (gelatoPageCount % 2 !== 0) {
    doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    gelatoPageCount++;
    log.debug(`📄 [PRINT PDF] Added blank page for even Gelato page count`);
  }

  // Inside back cover blank (last page of the book, NOT counted in pageCount)
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  // Actual PDF pages = cover spread (1) + inside front blank (1) + pageCount + inside back blank (1)
  const actualPdfPages = gelatoPageCount + 3;

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [PRINT PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB), PDF pages: ${actualPdfPages}, Gelato pageCount: ${gelatoPageCount}, font: ${consistentFontSize}pt`);

  return { pdfBuffer, pageCount: gelatoPageCount, fontSizeWarning };
}

/**
 * Add picture book pages (combined image + text on same page)
 * @param {PDFDocument} doc - PDFKit document
 * @param {Object} storyData - Story data
 * @param {Array<string>} storyPages - Parsed page texts
 * @param {number} pageWidth - Page width in points
 * @param {number} pageHeight - Page height in points
 * @param {number} fontSize - Consistent font size for all pages
 */
function addPictureBookPages(doc, storyData, storyPages, pageWidth = PAGE_SIZE, pageHeight = PAGE_SIZE, fontSize = 14, bleed = 0) {
  const interiorW = pageWidth + 2 * bleed;
  const interiorH = pageHeight + 2 * bleed;
  // Image takes top 75%, text bottom 25% — leaves enough room for ~200 words
  // at 11pt in A4 portrait while keeping the image dominant.
  const imageHeight = pageHeight * 0.75;
  const textAreaHeight = pageHeight * 0.25;
  const textMargin = mmToPoints(3);
  const textWidth = pageWidth - (textMargin * 2);
  const availableTextHeight = textAreaHeight - textMargin;
  const lineGap = -2;

  storyPages.forEach((pageText, index) => {
    const pageNumber = index + 1;
    const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
    const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

    doc.addPage({ size: [interiorW, interiorH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (image && image.imageData) {
      try {
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        // Image extends into LEFT, RIGHT, and TOP bleed (outer 3mm gets trimmed off).
        // Bottom edge stays at imageHeight + bleed since text sits below.
        doc.image(imageBuffer, 0, 0, {
          fit: [interiorW, bleed + imageHeight],
          align: 'center',
          valign: 'center'
        });
      } catch (imgErr) {
        log.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
      }
    }

    // Text stays inside content area with current margins (readability)
    doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
    const textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
    const textY = bleed + imageHeight + (availableTextHeight - textHeight) / 2;
    doc.text(cleanText, bleed + textMargin, textY, { width: textWidth, align: 'center', lineGap });
  });
}

/**
 * Generate combined book PDF from multiple stories
 * Used for ordering books with multiple stories
 *
 * @param {Array<{id: string, data: Object}>} stories - Array of story objects
 * @param {Object} options - Optional settings { actualSpineWidth: number (mm) }
 * @returns {Promise<{pdfBuffer: Buffer, pageCount: number}>}
 */
async function generateCombinedBookPdf(stories, options = {}) {
  log.debug(`📚 [COMBINED PDF] Generating book with ${stories.length} stories`);

  const bleed = mmToPoints(3);

  // Interior pages include bleed (3mm each side)
  const interiorPageSize = PAGE_SIZE + 2 * bleed;

  // Cover dimensions from Gelato API
  const gelatoCoverDims = options.gelatoCoverDims;
  let coverSpreadWidth, coverSpreadHeight;
  let contentBack, contentFront;

  if (gelatoCoverDims && gelatoCoverDims.coverPageWidth) {
    coverSpreadWidth = mmToPoints(gelatoCoverDims.coverPageWidth);
    coverSpreadHeight = mmToPoints(gelatoCoverDims.coverPageHeight);
    contentBack = gelatoCoverDims.contentBack;
    contentFront = gelatoCoverDims.contentFront;
    log.debug(`📚 [COMBINED PDF] Cover from Gelato API: ${gelatoCoverDims.coverPageWidth}x${gelatoCoverDims.coverPageHeight}mm`);
  } else {
    const spineWidthMm = gelatoCoverDims?.spineWidth || 10;
    const spineWidth = mmToPoints(spineWidthMm);
    coverSpreadWidth = bleed + PAGE_SIZE + spineWidth + PAGE_SIZE + bleed;
    coverSpreadHeight = COVER_HEIGHT;
    const pageSizeMm = Math.round(PAGE_SIZE / 2.83465);
    const bleedMm = 3;
    contentBack = { left: bleedMm, top: bleedMm, width: pageSizeMm, height: pageSizeMm };
    contentFront = { left: bleedMm + pageSizeMm + spineWidthMm, top: bleedMm, width: pageSizeMm, height: pageSizeMm };
    log.debug(`📚 [COMBINED PDF] Cover from fallback: ${Math.round(coverSpreadWidth / 2.83465)}x${Math.round(coverSpreadHeight / 2.83465)}mm`);
  }

  const doc = new PDFDocument({
    size: [coverSpreadWidth, coverSpreadHeight],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  const pdfPromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  let totalStoryPages = 0;

  // Helper: Add story content pages (with bleed offset)
  // Always uses picture-book layout: image on top (75%), text below (25%).
  const addStoryContentPages = (storyData, storyPages) => {
    const textMarginMm = mmToPoints(3);
    const imageHeight = PAGE_SIZE * 0.75;
    const textAreaHeight = PAGE_SIZE * 0.25;
    const textWidth = PAGE_SIZE - (textMarginMm * 2);
    const availableTextHeight = textAreaHeight - textMarginMm;
    const lineGap = -2;

    storyPages.forEach((pageText, index) => {
      const pageNumber = index + 1;
      const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
      const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      totalStoryPages++;

      if (image && image.imageData) {
        try {
          const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          // Image extends into LEFT, RIGHT, and TOP bleed (text sits below)
          doc.image(imageBuffer, 0, 0, { fit: [interiorPageSize, bleed + imageHeight], align: 'center', valign: 'center' });
        } catch (err) {
          log.error(`Error adding image for page ${pageNumber}:`, err.message);
        }
      }

      let fontSize = 14;
      doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
      let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

      while (textHeight > availableTextHeight && fontSize > 8) {
        fontSize -= 0.5;
        doc.fontSize(fontSize);
        textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
      }

      const textY = bleed + imageHeight + (availableTextHeight - textHeight) / 2;
      doc.text(cleanText, bleed + textMarginMm, textY, { width: textWidth, align: 'center', lineGap });
    });
  };

  // Process each story
  for (let storyIndex = 0; storyIndex < stories.length; storyIndex++) {
    const { data: storyData } = stories[storyIndex];
    const isFirstStory = storyIndex === 0;
    const storyPages = parseStoryPages(storyData);

    log.debug(`📚 [COMBINED PDF] Processing story ${storyIndex + 1}: "${storyData.title}" with ${storyPages.length} pages`);

    if (isFirstStory) {
      // STORY 1: Cover spread - use exact Gelato dimensions
      doc.addPage({ size: [coverSpreadWidth, coverSpreadHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      // If first story has no back cover (e.g. trial), borrow from another story
      let backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      if (!backCoverImageData) {
        for (let i = stories.length - 1; i > 0; i--) {
          backCoverImageData = getCoverImageData(stories[i].data.coverImages?.backCover);
          if (backCoverImageData) break;
        }
      }
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

      if (backCoverImageData && frontCoverImageData) {
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

        // Extend cover images into outer + top + bottom bleed; stop at the spine edge
        const backImgX = 0;
        const backImgY = 0;
        const backImgW = mmToPoints(contentBack.left + contentBack.width); // up to spine edge
        const backImgH = coverSpreadHeight;

        const frontImgX = mmToPoints(contentFront.left); // start at spine edge
        const frontImgY = 0;
        const frontImgW = coverSpreadWidth - frontImgX;  // up to right page edge incl. bleed
        const frontImgH = coverSpreadHeight;

        doc.image(backCoverBuffer, backImgX, backImgY, { fit: [backImgW, backImgH], align: 'center', valign: 'center' });
        doc.image(frontCoverBuffer, frontImgX, frontImgY, { fit: [frontImgW, frontImgH], align: 'center', valign: 'center' });
      }

      // Blank left page (required by Gelato - left side of first spread)
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      // Introduction/dedication page (right side of first spread) — blank if missing (e.g. trial)
      // Image fills entire page including bleed
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      if (initialPageImageData) {
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { fit: [interiorPageSize, interiorPageSize], align: 'center', valign: 'center' });
      }

      addStoryContentPages(storyData, storyPages);

    } else {
      // STORY 2+: Title page (LEFT/even) + dedication page (RIGHT/odd)
      // Previous story ended with back cover (LEFT) + padding (RIGHT),
      // so next page is LEFT — perfect for title.
      // Matches story 1 layout: blank (LEFT) + dedication (RIGHT)

      // Title page (LEFT) — front cover image as internal title.
      // Image fills entire page including bleed.
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      totalStoryPages++;
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
      if (frontCoverImageData) {
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(frontCoverBuffer, 0, 0, { fit: [interiorPageSize, interiorPageSize], align: 'center', valign: 'center' });
      }

      // Dedication/initial page (RIGHT) — same side as story 1's dedication
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      totalStoryPages++;
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      if (initialPageImageData) {
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { fit: [interiorPageSize, interiorPageSize], align: 'center', valign: 'center' });
      }

      addStoryContentPages(storyData, storyPages);

      // Back cover (LEFT) + blank separator (RIGHT) — only if story has a back cover
      // If no back cover, skip both pages (reduces page count by 2, preserves alignment)
      const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      if (backCoverImageData) {
        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(backCoverBuffer, 0, 0, { fit: [interiorPageSize, interiorPageSize], align: 'center', valign: 'center' });

        // Blank separator after back cover (if not last story)
        if (storyIndex < stories.length - 1) {
          doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
        }
      }
    }
  }

  // Gelato pageCount = interior pages only (dedication + story content).
  // Does NOT count: cover spread, inside front cover blank, inside back cover blank.
  // Gelato expects total PDF pages = pageCount + 3.
  let gelatoPageCount = 1 + totalStoryPages; // dedication + story content

  // Gelato requires even page count for double-sided printing
  if (gelatoPageCount % 2 !== 0) {
    doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    gelatoPageCount++;
    log.debug(`📚 [COMBINED PDF] Added blank page for even Gelato page count`);
  }

  // Inside back cover blank (last page of the book, NOT counted in pageCount)
  doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  // Actual PDF pages = cover spread (1) + inside front blank (1) + pageCount + inside back blank (1)
  const actualPdfPages = gelatoPageCount + 3;

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [COMBINED PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB), PDF pages: ${actualPdfPages}, Gelato pageCount: ${gelatoPageCount}`);

  return { pdfBuffer, pageCount: gelatoPageCount };
}

/**
 * Generate viewable PDF for a single story (for download/viewing, NOT printing)
 * Layout: Front cover → Initial page → Story pages → Back cover (all separate pages)
 *
 * @param {Object} storyData - Story data with coverImages, sceneImages, storyText, etc.
 * @param {string} bookFormat - Book format: 'square' (200x200mm) or 'A4' (210x280mm)
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateViewPdf(storyData, bookFormat = DEFAULT_FORMAT) {
  // Get dimensions for the selected format
  const format = BOOK_FORMATS[bookFormat] || BOOK_FORMATS[DEFAULT_FORMAT];
  const { pageWidth, pageHeight } = format;

  log.debug(`📄 [VIEW PDF] Using format: ${bookFormat} (${Math.round(pageWidth / 2.83465)}x${Math.round(pageHeight / 2.83465)}mm)`);

  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));
  const pdfPromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  // 1. FRONT COVER (first page - different from print which has back+front spread)
  const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
  if (frontCoverImageData) {
    doc.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(frontCoverBuffer, 0, 0, { fit: [pageWidth, pageHeight], align: 'center', valign: 'center' });
    } catch (err) {
      log.error('Error adding front cover:', err.message);
    }
  }

  // 2. INITIAL PAGE (dedication/intro)
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  if (initialPageImageData) {
    doc.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(initialPageBuffer, 0, 0, { fit: [pageWidth, pageHeight], align: 'center', valign: 'center' });
    } catch (err) {
      log.error('Error adding initial page:', err.message);
    }
  }

  // 3. STORY PAGES - reuse the same functions as print
  const storyPages = parseStoryPages(storyData);
  if (storyPages.length === 0) {
    throw new Error('No story pages found');
  }

  // Always use picture-book layout (matches generatePrintPdf)
  log.debug(`📄 [VIEW PDF] Generating with ${storyPages.length} pages, layout: Picture Book`);

  const textMargin = mmToPoints(3);
  const textWidth = pageWidth - (textMargin * 2);
  const textAreaHeight = pageHeight * 0.25;
  const availableTextHeight = textAreaHeight - textMargin;
  const fontResult = calculateConsistentFontSize(doc, storyPages, textWidth, availableTextHeight, 14, 8, 'center');
  const consistentFontSize = fontResult.fontSize;

  addPictureBookPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize);

  // 4. BACK COVER (last page)
  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  if (backCoverImageData) {
    doc.addPage({ size: [pageWidth, pageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(backCoverBuffer, 0, 0, { fit: [pageWidth, pageHeight], align: 'center', valign: 'center' });
    } catch (err) {
      log.error('Error adding back cover:', err.message);
    }
  }

  doc.end();
  const pdfBuffer = await pdfPromise;

  log.debug(`📄 [VIEW PDF] Generated successfully (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  return pdfBuffer;
}

module.exports = {
  generatePrintPdf,
  generateViewPdf,
  generateCombinedBookPdf,
  parseStoryPages,
  getCoverImageData,
  mmToPoints,
  COVER_WIDTH,
  COVER_HEIGHT,
  PAGE_SIZE,
  BOOK_FORMATS,
  DEFAULT_FORMAT
};
