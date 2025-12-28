/**
 * PDF Generation Library
 *
 * Functions for generating print-ready PDFs for stories
 */

const PDFDocument = require('pdfkit');
const { log } = require('../utils/logger');

// Convert millimeters to PDF points
const mmToPoints = (mm) => mm * 2.83465;

// PDF dimensions
const COVER_WIDTH = mmToPoints(416);    // 20x20cm cover spread (back + front)
const COVER_HEIGHT = mmToPoints(206);   // 20x20cm cover height with bleed
const PAGE_SIZE = mmToPoints(200);      // 20x20cm interior pages

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
 * Generate print-ready PDF for a single story
 * Layout: Back+Front cover spread → Initial page → Story pages
 *
 * @param {Object} storyData - Story data with coverImages, sceneImages, storyText, etc.
 * @returns {Promise<{pdfBuffer: Buffer, pageCount: number}>}
 */
async function generatePrintPdf(storyData) {
  const doc = new PDFDocument({
    size: [COVER_WIDTH, COVER_HEIGHT],
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    autoFirstPage: false
  });

  const buffers = [];
  doc.on('data', buffers.push.bind(buffers));

  const pdfPromise = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
  });

  // Add cover page (back cover on left + front cover on right - for print binding)
  doc.addPage({ size: [COVER_WIDTH, COVER_HEIGHT], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

  if (backCoverImageData && frontCoverImageData) {
    const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    doc.image(backCoverBuffer, 0, 0, { width: COVER_WIDTH / 2, height: COVER_HEIGHT });
    doc.image(frontCoverBuffer, COVER_WIDTH / 2, 0, { width: COVER_WIDTH / 2, height: COVER_HEIGHT });
  }

  // Add initial page (dedication/intro page)
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  if (initialPageImageData) {
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
    const initialPageBuffer = Buffer.from(initialPageData, 'base64');
    doc.image(initialPageBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
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

  // Add content pages based on layout type
  if (isPictureBook) {
    // PICTURE BOOK LAYOUT: Combined image on top (~85%), text below (~15%)
    addPictureBookPages(doc, storyData, storyPages);
  } else {
    // STANDARD/ADVANCED LAYOUT: Separate pages for text and image
    addStandardPages(doc, storyData, storyPages);
  }

  // Calculate page count and add blank pages if needed (must be even for print)
  let actualPdfPages = isPictureBook ? storyPages.length : storyPages.length * 2;
  const targetPageCount = actualPdfPages % 2 === 0 ? actualPdfPages : actualPdfPages + 1;
  const blankPagesToAdd = targetPageCount - actualPdfPages;

  if (blankPagesToAdd > 0) {
    log.debug(`📄 [PRINT PDF] Adding ${blankPagesToAdd} blank page(s) to reach even count ${targetPageCount}`);
  }

  for (let i = 0; i < blankPagesToAdd; i++) {
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  }

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [PRINT PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${targetPageCount} interior pages`);

  return { pdfBuffer, pageCount: targetPageCount };
}

/**
 * Add picture book pages (combined image + text on same page)
 */
function addPictureBookPages(doc, storyData, storyPages) {
  const imageHeight = PAGE_SIZE * 0.85;
  const textAreaHeight = PAGE_SIZE * 0.15;
  const textMargin = mmToPoints(3);
  const textWidth = PAGE_SIZE - (textMargin * 2);
  const availableTextHeight = textAreaHeight - textMargin;
  const lineGap = -2;

  storyPages.forEach((pageText, index) => {
    const pageNumber = index + 1;
    const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
    const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (image && image.imageData) {
      try {
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imageBuffer, 0, 0, {
          fit: [PAGE_SIZE, imageHeight],
          align: 'center',
          valign: 'center'
        });
      } catch (imgErr) {
        log.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
      }
    }

    // Add text in bottom portion with vertical centering
    let fontSize = 14;
    doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
    let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

    while (textHeight > availableTextHeight && fontSize > 6) {
      fontSize -= 0.5;
      doc.fontSize(fontSize);
      textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
    }

    if (textHeight > availableTextHeight) {
      const errorMsg = `Text too long on page ${pageNumber}. Please shorten the story text for this page.`;
      log.error(`❌ [PRINT PDF] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const textY = imageHeight + (availableTextHeight - textHeight) / 2;
    doc.text(cleanText, textMargin, textY, { width: textWidth, align: 'center', lineGap });
  });
}

/**
 * Add standard pages (separate text and image pages)
 */
function addStandardPages(doc, storyData, storyPages) {
  const margin = 28;
  const availableWidth = PAGE_SIZE - (margin * 2);
  const availableHeight = PAGE_SIZE - (margin * 2);
  const lineGap = -2;

  storyPages.forEach((pageText, index) => {
    const pageNumber = index + 1;
    const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
    const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

    // Add text page
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: margin, bottom: margin, left: margin, right: margin } });

    let fontSize = 13;
    doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
    const safeAvailableHeight = availableHeight * 0.9;
    let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

    while (textHeight > safeAvailableHeight && fontSize > 6) {
      fontSize -= 0.5;
      doc.fontSize(fontSize);
      textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
    }

    if (fontSize < 13) {
      log.debug(`📄 [PRINT PDF] Page ${pageNumber}: Font reduced 13pt → ${fontSize}pt`);
    }

    if (textHeight > safeAvailableHeight) {
      const errorMsg = `Text too long on page ${pageNumber}. Please shorten the story text for this page.`;
      log.error(`❌ [PRINT PDF] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const yPosition = margin + (availableHeight - textHeight) / 2;
    doc.text(cleanText, margin, yPosition, { width: availableWidth, align: 'left', lineGap });

    // Add image page if available (full-bleed, no margin)
    if (image && image.imageData) {
      doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imageBuffer, 0, 0, {
          fit: [PAGE_SIZE, PAGE_SIZE],
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
 * @returns {Promise<{pdfBuffer: Buffer, pageCount: number}>}
 */
async function generateCombinedBookPdf(stories) {
  log.debug(`📚 [COMBINED PDF] Generating book with ${stories.length} stories`);

  const doc = new PDFDocument({
    size: [COVER_WIDTH, COVER_HEIGHT],
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

  // Helper: Add story content pages
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

        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;

        if (image && image.imageData) {
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            doc.image(imageBuffer, 0, 0, { fit: [PAGE_SIZE, imageHeight], align: 'center', valign: 'center' });
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

        const textY = imageHeight + (availableTextHeight - textHeight) / 2;
        doc.text(cleanText, textMarginMm, textY, { width: textWidth, align: 'center', lineGap });
      });
    } else {
      const availableWidth = PAGE_SIZE - (textMargin * 2);
      const availableHeight = PAGE_SIZE - (textMargin * 2);
      const lineGap = -2;

      storyPages.forEach((pageText, index) => {
        const pageNumber = index + 1;
        const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
        const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: textMargin, bottom: textMargin, left: textMargin, right: textMargin } });
        totalStoryPages++;

        let fontSize = 13;
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

        while (textHeight > availableHeight * 0.9 && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
        }

        const yPosition = textMargin + (availableHeight - textHeight) / 2;
        doc.text(cleanText, textMargin, yPosition, { width: availableWidth, align: 'left', lineGap });

        if (image && image.imageData) {
          doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            doc.image(imageBuffer, 0, 0, { fit: [PAGE_SIZE, PAGE_SIZE], align: 'center', valign: 'center' });
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
      // STORY 1: Back cover + Front cover (combined spread for book binding)
      doc.addPage({ size: [COVER_WIDTH, COVER_HEIGHT], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

      if (backCoverImageData && frontCoverImageData) {
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(backCoverBuffer, 0, 0, { width: COVER_WIDTH / 2, height: COVER_HEIGHT });
        doc.image(frontCoverBuffer, COVER_WIDTH / 2, 0, { width: COVER_WIDTH / 2, height: COVER_HEIGHT });
      }

      // Introduction page
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      if (initialPageImageData) {
        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
      }

      addStoryContentPages(storyData, storyPages);

    } else {
      // STORY 2+: Front cover (title page)
      const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
      if (frontCoverImageData) {
        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(frontCoverBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
      }

      // Introduction page
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      if (initialPageImageData) {
        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
      }

      addStoryContentPages(storyData, storyPages);

      // Back cover for this story
      const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
      if (backCoverImageData) {
        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(backCoverBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
      }

      // Blank page between stories (if not last story)
      if (storyIndex < stories.length - 1) {
        doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
      }
    }
  }

  // Add blank pages if needed for even page count
  if (totalStoryPages % 2 !== 0) {
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    totalStoryPages++;
    log.debug(`📚 [COMBINED PDF] Added final blank page for even page count`);
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
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateViewPdf(storyData) {
  const doc = new PDFDocument({
    size: [PAGE_SIZE, PAGE_SIZE],
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
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(frontCoverBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
    } catch (err) {
      log.error('Error adding front cover:', err.message);
    }
  }

  // 2. INITIAL PAGE (dedication/intro)
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  if (initialPageImageData) {
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(initialPageBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
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

  if (isPictureBook) {
    addPictureBookPages(doc, storyData, storyPages);
  } else {
    addStandardPages(doc, storyData, storyPages);
  }

  // 4. BACK COVER (last page)
  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  if (backCoverImageData) {
    doc.addPage({ size: [PAGE_SIZE, PAGE_SIZE], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    try {
      const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(backCoverBuffer, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE });
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
  PAGE_SIZE
};
