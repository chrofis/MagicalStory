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

  // Use actual spine width from Gelato API if provided, otherwise use default
  const actualSpineWidthMm = options.actualSpineWidth || 10;
  const spineWidth = mmToPoints(actualSpineWidthMm);

  log.debug(`📄 [PRINT PDF] Spine width: ${actualSpineWidthMm}mm`);

  // Recalculate cover width based on actual spine
  // Cover = bleed + back cover + spine + front cover + bleed
  const actualCoverWidth = bleed + pageWidth + spineWidth + pageWidth + bleed;

  const doc = new PDFDocument({
    size: [actualCoverWidth, coverHeight],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const pdfPromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  // PAGE 1: Cover spread (Back Cover + Spine + Front Cover) - Gelato requirement
  // Layout: Back Cover (left) | Spine (center) | Front Cover (right)
  doc.addPage({ size: [actualCoverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

  if (backCoverImageData && frontCoverImageData) {
    const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    // Cover layout: bleed (white) | back image | spine (white) | front image | bleed (white)
    const backCoverX = bleed;
    const spineX = bleed + pageWidth;
    const frontCoverX = bleed + pageWidth + spineWidth;

    // For square source images, center vertically within the cover area
    const coverImageHeight = pageWidth; // Square image: height = width
    const coverYOffset = (coverHeight - coverImageHeight) / 2;

    // Place back cover image in its pageWidth area (after left bleed margin)
    doc.image(backCoverBuffer, backCoverX, coverYOffset, { width: pageWidth });
    // Spine area stays white
    // Place front cover image in its pageWidth area (before right bleed margin)
    doc.image(frontCoverBuffer, frontCoverX, coverYOffset, { width: pageWidth });

    // Spine area left blank (white) - no text for now
  }

  // Page 2: Blank left page (required by Gelato - left side of first spread)
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  // Page 3: Initial/dedication page (right side of first spread)
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  if (initialPageImageData) {
    const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
    const initialPageBuffer = Buffer.from(initialPageData, 'base64');
    // Center image within content area (offset by bleed)
    const initialImageHeight = pageWidth; // Square image height = content width
    const initialYOffset = bleed + (pageHeight - initialImageHeight) / 2;
    doc.image(initialPageBuffer, bleed, initialYOffset, { width: pageWidth });
  }

  // Parse story pages
  const storyPages = parseStoryPages(storyData);
  if (storyPages.length === 0) {
    throw new Error('Story text not found in story data. Available keys: ' + Object.keys(storyData).join(', '));
  }

  log.debug(`📄 [PRINT PDF] Found ${storyPages.length} story pages`);

  // Determine layout
  const isPictureBook = storyData.languageLevel === '1st-grade';
  log.debug(`📄 [PRINT PDF] Layout: ${isPictureBook ? 'Picture Book (combined)' : 'Standard (separate pages)'}`);

  // Calculate consistent font size for all pages BEFORE rendering
  let fontSizeWarning = null;
  let consistentFontSize;

  if (isPictureBook) {
    // Picture book: 85% image, 15% text
    const textMargin = mmToPoints(3);
    const textWidth = pageWidth - (textMargin * 2);
    const textAreaHeight = pageHeight * 0.15;
    const availableTextHeight = textAreaHeight - textMargin;

    const fontResult = calculateConsistentFontSize(doc, storyPages, textWidth, availableTextHeight, 14, 6, 'center');
    consistentFontSize = fontResult.fontSize;
    fontSizeWarning = fontResult.warning;
  } else {
    // Standard: full page for text
    const margin = 20;
    const availableWidth = pageWidth - (margin * 2);
    const availableHeight = (pageHeight - (margin * 2)) * 0.9;

    const fontResult = calculateConsistentFontSize(doc, storyPages, availableWidth, availableHeight, 13, 6, 'left');
    consistentFontSize = fontResult.fontSize;
    fontSizeWarning = fontResult.warning;
  }

  // Add content pages based on layout type (with consistent font size)
  // Pass bleed so pages are sized with bleed and content is offset inward
  if (isPictureBook) {
    addPictureBookPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize, bleed);
  } else {
    addStandardPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize, bleed);
  }

  // Trailing blank page (last page of the book, left side of last spread)
  doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  // Calculate total PDF page count
  // Layout: cover spread (1) + blank (1) + dedication (1) + story pages + trailing blank (1)
  const coverSpreadPages = 1;
  const frontMatterPages = 2; // blank left page + dedication right page
  const storyContentPages = isPictureBook ? storyPages.length : storyPages.length * 2;
  const trailingBlankPages = 1;
  let interiorPages = frontMatterPages + storyContentPages + trailingBlankPages;

  // Interior pages must be even for print (pages are printed front/back)
  if (interiorPages % 2 !== 0) {
    interiorPages += 1;
    doc.addPage({ size: [interiorPageWidth, interiorPageHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    log.debug(`📄 [PRINT PDF] Added 1 extra blank page to reach even interior count ${interiorPages}`);
  }

  const totalPdfPages = coverSpreadPages + interiorPages;

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [PRINT PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${totalPdfPages} total pages (${interiorPages} interior + cover spread), font: ${consistentFontSize}pt`);

  return { pdfBuffer, pageCount: totalPdfPages, fontSizeWarning };
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
  const imageHeight = pageHeight * 0.85;
  const textAreaHeight = pageHeight * 0.15;
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
        doc.image(imageBuffer, bleed, bleed, {
          fit: [pageWidth, imageHeight],
          align: 'center',
          valign: 'center'
        });
      } catch (imgErr) {
        log.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
      }
    }

    // Add text in bottom portion with consistent font size and vertical centering
    doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
    const textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
    const textY = bleed + imageHeight + (availableTextHeight - textHeight) / 2;
    doc.text(cleanText, bleed + textMargin, textY, { width: textWidth, align: 'center', lineGap });
  });
}

/**
 * Add standard pages (separate text and image pages)
 * @param {PDFDocument} doc - PDFKit document
 * @param {Object} storyData - Story data
 * @param {Array<string>} storyPages - Parsed page texts
 * @param {number} pageWidth - Page width in points
 * @param {number} pageHeight - Page height in points
 * @param {number} fontSize - Consistent font size for all pages
 */
function addStandardPages(doc, storyData, storyPages, pageWidth = PAGE_SIZE, pageHeight = PAGE_SIZE, fontSize = 13, bleed = 0) {
  const interiorW = pageWidth + 2 * bleed;
  const interiorH = pageHeight + 2 * bleed;
  const margin = 20;
  const availableWidth = pageWidth - (margin * 2);
  const availableHeight = pageHeight - (margin * 2);
  const lineGap = -2;
  // Paragraph gap: half a line height (fontSize * 0.5) for tighter paragraph spacing
  const paragraphGap = fontSize * 0.5;

  storyPages.forEach((pageText, index) => {
    const pageNumber = index + 1;
    const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
    // Clean text and compress multiple newlines to single newline (paragraphGap handles spacing)
    const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim().replace(/\n\s*\n/g, '\n');

    // Add text page with consistent font size (margins offset by bleed)
    doc.addPage({ size: [interiorW, interiorH], margins: { top: bleed + margin, bottom: bleed + margin, left: bleed + margin, right: bleed + margin } });

    doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
    const textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap, paragraphGap });
    const yPosition = bleed + margin + (availableHeight - textHeight) / 2;
    doc.text(cleanText, bleed + margin, yPosition, { width: availableWidth, align: 'left', lineGap, paragraphGap });

    // Add image page if available - image fills content area, centered within bleed
    if (image && image.imageData) {
      doc.addPage({ size: [interiorW, interiorH], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imageBuffer, bleed, bleed, {
          fit: [pageWidth, pageHeight],
          align: 'center',
          valign: 'center'
        });
      } catch (imgErr) {
        log.error('Error adding image to PDF:', imgErr);
      }
    }
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

  // Get spine width from options or use default
  const actualSpineWidthMm = options.actualSpineWidth || 10;
  const spineWidth = mmToPoints(actualSpineWidthMm);
  const bleed = mmToPoints(3);

  // Interior pages include bleed (3mm each side)
  const interiorPageSize = PAGE_SIZE + 2 * bleed;

  // Calculate actual cover width with spine
  const actualCoverWidth = bleed + PAGE_SIZE + spineWidth + PAGE_SIZE + bleed;

  log.debug(`📚 [COMBINED PDF] Spine width: ${actualSpineWidthMm}mm, cover width: ${Math.round(actualCoverWidth / 2.83465)}mm`);

  const doc = new PDFDocument({
    size: [actualCoverWidth, COVER_HEIGHT],
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
  const addStoryContentPages = (storyData, storyPages) => {
    const isPictureBook = storyData.languageLevel === '1st-grade';
    const textMargin = 28;
    const textMarginMm = mmToPoints(3);

    if (isPictureBook) {
      const imageHeight = PAGE_SIZE * 0.85;
      const textAreaHeight = PAGE_SIZE * 0.15;
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
            doc.image(imageBuffer, bleed, bleed, { fit: [PAGE_SIZE, imageHeight], align: 'center', valign: 'center' });
          } catch (err) {
            log.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }

        let fontSize = 14;
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
        }

        const textY = bleed + imageHeight + (availableTextHeight - textHeight) / 2;
        doc.text(cleanText, bleed + textMarginMm, textY, { width: textWidth, align: 'center', lineGap });
      });
    } else {
      const availableWidth = PAGE_SIZE - (textMargin * 2);
      const availableHeight = PAGE_SIZE - (textMargin * 2);
      const lineGap = -2;

      storyPages.forEach((pageText, index) => {
        const pageNumber = index + 1;
        const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
        const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: bleed + textMargin, bottom: bleed + textMargin, left: bleed + textMargin, right: bleed + textMargin } });
        totalStoryPages++;

        let fontSize = 13;
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

        while (textHeight > availableHeight * 0.9 && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
        }

        const yPosition = bleed + textMargin + (availableHeight - textHeight) / 2;
        doc.text(cleanText, bleed + textMargin, yPosition, { width: availableWidth, align: 'left', lineGap });

        if (image && image.imageData) {
          doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            doc.image(imageBuffer, bleed, bleed, { fit: [PAGE_SIZE, PAGE_SIZE], align: 'center', valign: 'center' });
          } catch (err) {
            log.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }
      });
    }
  };

  // Process each story
  for (let storyIndex = 0; storyIndex < stories.length; storyIndex++) {
    const { data: storyData } = stories[storyIndex];
    const isFirstStory = storyIndex === 0;
    const storyPages = parseStoryPages(storyData);

    log.debug(`📚 [COMBINED PDF] Processing story ${storyIndex + 1}: "${storyData.title}" with ${storyPages.length} pages`);

    if (isFirstStory) {
      // STORY 1: Back cover + Spine + Front cover (combined spread for book binding)
      doc.addPage({ size: [actualCoverWidth, COVER_HEIGHT], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

      if (backCoverImageData && frontCoverImageData) {
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

        // Cover layout: bleed (white) | back image | spine (white) | front image | bleed (white)
        const backCoverX = bleed;
        const frontCoverX = bleed + PAGE_SIZE + spineWidth;

        // For square source images, center vertically within the cover area
        const coverImageHeight = PAGE_SIZE; // Square image: height = width
        const coverYOffset = (COVER_HEIGHT - coverImageHeight) / 2;

        // Place back cover image in its PAGE_SIZE area (after left bleed margin)
        doc.image(backCoverBuffer, backCoverX, coverYOffset, { width: PAGE_SIZE });
        // Spine area stays white
        // Place front cover image in its PAGE_SIZE area (before right bleed margin)
        doc.image(frontCoverBuffer, frontCoverX, coverYOffset, { width: PAGE_SIZE });

        // Spine area left blank (white) - no text for now
      }

      // Blank left page (required by Gelato - left side of first spread)
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      // Introduction/dedication page (right side of first spread)
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      if (initialPageImageData) {
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, bleed, bleed, { width: PAGE_SIZE });
      }

      addStoryContentPages(storyData, storyPages);

    } else {
      // STORY 2+: Front cover (title page)
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
      if (frontCoverImageData) {
        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(frontCoverBuffer, bleed, bleed, { width: PAGE_SIZE });
      }

      // Introduction page
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      if (initialPageImageData) {
        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, bleed, bleed, { width: PAGE_SIZE });
      }

      addStoryContentPages(storyData, storyPages);

      // Back cover for this story
      const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      if (backCoverImageData) {
        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(backCoverBuffer, bleed, bleed, { width: PAGE_SIZE });
      }

      // Blank page between stories (if not last story)
      if (storyIndex < stories.length - 1) {
        doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
      }
    }
  }

  // Trailing blank page (last page of the book)
  doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  totalStoryPages++;

  // Add extra blank page if needed for even page count
  if (totalStoryPages % 2 !== 0) {
    doc.addPage({ size: [interiorPageSize, interiorPageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    totalStoryPages++;
    log.debug(`📚 [COMBINED PDF] Added extra blank page for even page count`);
  }

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [COMBINED PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${totalStoryPages} story pages`);

  return { pdfBuffer, pageCount: totalStoryPages };
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

  const isPictureBook = storyData.languageLevel === '1st-grade';
  log.debug(`📄 [VIEW PDF] Generating with ${storyPages.length} pages, layout: ${isPictureBook ? 'Picture Book' : 'Standard'}`);

  // Calculate consistent font size for all pages
  let consistentFontSize;
  if (isPictureBook) {
    const textMargin = mmToPoints(3);
    const textWidth = pageWidth - (textMargin * 2);
    const textAreaHeight = pageHeight * 0.15;
    const availableTextHeight = textAreaHeight - textMargin;
    const fontResult = calculateConsistentFontSize(doc, storyPages, textWidth, availableTextHeight, 14, 6, 'center');
    consistentFontSize = fontResult.fontSize;
  } else {
    const margin = 20;
    const availableWidth = pageWidth - (margin * 2);
    const availableHeight = (pageHeight - (margin * 2)) * 0.9;
    const fontResult = calculateConsistentFontSize(doc, storyPages, availableWidth, availableHeight, 13, 6, 'left');
    consistentFontSize = fontResult.fontSize;
  }

  if (isPictureBook) {
    addPictureBookPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize);
  } else {
    addStandardPages(doc, storyData, storyPages, pageWidth, pageHeight, consistentFontSize);
  }

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
