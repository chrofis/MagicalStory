/**
 * Repair Grid Module
 *
 * Creates labeled grids from extracted issue thumbnails, sends to Gemini
 * for batch repair, and extracts repaired regions.
 *
 * Pattern based on: scripts/test-grid-composite.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Load prompt template
const PROMPT_PATH = path.join(__dirname, '../../prompts/grid-repair.txt');
let REPAIR_PROMPT_TEMPLATE = null;
function getRepairPromptTemplate() {
  if (!REPAIR_PROMPT_TEMPLATE) {
    REPAIR_PROMPT_TEMPLATE = fs.readFileSync(PROMPT_PATH, 'utf-8');
  }
  return REPAIR_PROMPT_TEMPLATE;
}

// Grid configuration
const CELL_SIZE = 256;      // Default cell size (for legacy createLabeledGrid)
const MAX_CELL_DIM = 300;   // Maximum dimension for any cell in variable grid
const MAX_GRID_WIDTH = 1024; // Maximum grid width for row packing
const MAX_COLS = 4;         // Maximum columns per grid (for legacy fixed grid)
const MAX_ROWS = 3;         // Maximum rows per grid
const MAX_PER_GRID = 12;    // MAX_COLS * MAX_ROWS
const PADDING = 10;         // Padding between cells
const LABEL_HEIGHT = 30;    // Height for letter labels
const TITLE_HEIGHT = 40;    // Height for grid title

// Gemini-supported aspect ratios (width/height)
const GEMINI_RATIOS = [
  { name: '1:1', ratio: 1.0 },
  { name: '4:3', ratio: 4/3 },    // 1.333 - landscape
  { name: '3:4', ratio: 3/4 },    // 0.75 - portrait
  { name: '16:9', ratio: 16/9 },  // 1.778 - wide
  { name: '9:16', ratio: 9/16 }   // 0.5625 - tall
];

// Gemini model for image editing (same as page generation)
const REPAIR_MODEL = 'gemini-2.5-flash-image';

/**
 * Find the closest Gemini-supported aspect ratio
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {{name: string, ratio: number, paddedWidth: number, paddedHeight: number}}
 */
function findClosestGeminiRatio(width, height) {
  const currentRatio = width / height;

  let best = null;
  let bestDiff = Infinity;

  for (const r of GEMINI_RATIOS) {
    const diff = Math.abs(currentRatio - r.ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }

  // Calculate padded dimensions to match the target ratio
  let paddedWidth, paddedHeight;
  if (currentRatio > best.ratio) {
    // Image is wider than target - pad height
    paddedWidth = width;
    paddedHeight = Math.round(width / best.ratio);
  } else {
    // Image is taller than target - pad width
    paddedHeight = height;
    paddedWidth = Math.round(height * best.ratio);
  }

  return {
    name: best.name,
    ratio: best.ratio,
    paddedWidth,
    paddedHeight
  };
}

/**
 * Pad an image to a Gemini-supported aspect ratio
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {number} originalWidth - Original width
 * @param {number} originalHeight - Original height
 * @param {string} padColor - Padding color ('white' or 'black')
 * @returns {Promise<{buffer: Buffer, padding: Object, targetRatio: Object}>}
 */
async function padToGeminiRatio(imageBuffer, originalWidth, originalHeight, padColor = 'white') {
  const target = findClosestGeminiRatio(originalWidth, originalHeight);

  // No padding needed if already at target ratio
  if (target.paddedWidth === originalWidth && target.paddedHeight === originalHeight) {
    return {
      buffer: imageBuffer,
      padding: { top: 0, left: 0, bottom: 0, right: 0 },
      targetRatio: target
    };
  }

  // Calculate padding (center the original image)
  const padLeft = Math.floor((target.paddedWidth - originalWidth) / 2);
  const padTop = Math.floor((target.paddedHeight - originalHeight) / 2);
  const padRight = target.paddedWidth - originalWidth - padLeft;
  const padBottom = target.paddedHeight - originalHeight - padTop;

  const bgColor = padColor === 'black'
    ? { r: 0, g: 0, b: 0, alpha: 1 }
    : { r: 255, g: 255, b: 255, alpha: 1 };

  const paddedBuffer = await sharp(imageBuffer)
    .extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      background: bgColor
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`  [GRID] Padded ${originalWidth}x${originalHeight} → ${target.paddedWidth}x${target.paddedHeight} (${target.name}, +${padLeft}/${padRight}/${padTop}/${padBottom})`);

  return {
    buffer: paddedBuffer,
    padding: { top: padTop, left: padLeft, bottom: padBottom, right: padRight },
    targetRatio: target
  };
}

/**
 * Remove padding from a repaired grid image
 * @param {Buffer} imageBuffer - Padded image buffer
 * @param {Object} padding - Padding info {top, left, bottom, right}
 * @param {number} expectedWidth - Expected width after removing padding
 * @param {number} expectedHeight - Expected height after removing padding
 * @returns {Promise<Buffer>}
 */
async function removePadding(imageBuffer, padding, expectedWidth, expectedHeight) {
  const meta = await sharp(imageBuffer).metadata();

  // Calculate scale factor (Gemini may have resized)
  const scaleX = meta.width / (expectedWidth + padding.left + padding.right);
  const scaleY = meta.height / (expectedHeight + padding.top + padding.bottom);

  // Scale padding values
  const scaledPadding = {
    left: Math.round(padding.left * scaleX),
    top: Math.round(padding.top * scaleY),
    right: Math.round(padding.right * scaleX),
    bottom: Math.round(padding.bottom * scaleY)
  };

  const cropWidth = meta.width - scaledPadding.left - scaledPadding.right;
  const cropHeight = meta.height - scaledPadding.top - scaledPadding.bottom;

  if (cropWidth <= 0 || cropHeight <= 0) {
    console.warn(`  [GRID] Invalid crop dimensions after padding removal: ${cropWidth}x${cropHeight}`);
    return imageBuffer;
  }

  const croppedBuffer = await sharp(imageBuffer)
    .extract({
      left: scaledPadding.left,
      top: scaledPadding.top,
      width: cropWidth,
      height: cropHeight
    })
    .jpeg({ quality: 95 })
    .toBuffer();

  console.log(`  [GRID] Removed padding: ${meta.width}x${meta.height} → ${cropWidth}x${cropHeight}`);

  return croppedBuffer;
}

/**
 * Create a labeled grid image from extracted issue thumbnails
 * Uses variable cell sizes to preserve aspect ratio of original regions.
 *
 * @param {Object[]} issues - Array of issues with extraction.absolutePath and extraction.thumbDimensions
 * @param {Object} options - Grid options
 * @param {string} options.title - Grid title (optional)
 * @returns {Promise<{buffer: Buffer, manifest: Object, cellPositions: Object[]}>}
 */
async function createIssueGrid(issues, options = {}) {
  const { title = 'Issue Repair Grid' } = options;

  // Filter to only issues with extracted thumbnails
  const validIssues = issues.filter(i => i.extraction?.absolutePath && fs.existsSync(i.extraction.absolutePath));

  if (validIssues.length === 0) {
    throw new Error('No valid issue thumbnails to create grid');
  }

  const count = Math.min(validIssues.length, MAX_PER_GRID);
  const composites = [];
  const cellPositions = [];

  // First pass: load all thumbnails and determine their dimensions
  const cells = [];
  for (let i = 0; i < count; i++) {
    const issue = validIssues[i];
    try {
      // Get actual thumbnail dimensions (prefer stored thumbDimensions, fallback to reading file)
      let thumbWidth, thumbHeight;
      if (issue.extraction.thumbDimensions) {
        thumbWidth = issue.extraction.thumbDimensions.width;
        thumbHeight = issue.extraction.thumbDimensions.height;
      } else {
        // Fallback: read from file metadata
        const meta = await sharp(issue.extraction.absolutePath).metadata();
        thumbWidth = meta.width;
        thumbHeight = meta.height;
      }

      // Scale to fit within MAX_CELL_DIM if needed
      const maxDim = Math.max(thumbWidth, thumbHeight);
      const scale = maxDim > MAX_CELL_DIM ? MAX_CELL_DIM / maxDim : 1;
      const cellWidth = Math.round(thumbWidth * scale);
      const cellHeight = Math.round(thumbHeight * scale);

      cells.push({
        issue,
        letter: String.fromCharCode(65 + i),
        width: cellWidth,
        height: cellHeight
      });
    } catch (err) {
      console.error(`  Failed to get dimensions for issue ${issue.id}: ${err.message}`);
    }
  }

  if (cells.length === 0) {
    throw new Error('Failed to process any issue thumbnails');
  }

  // Second pass: row packing layout
  // Place cells left-to-right, wrap when exceeds MAX_GRID_WIDTH
  let x = PADDING;
  let y = TITLE_HEIGHT + PADDING;
  let rowHeight = 0;
  let maxX = 0;

  for (const cell of cells) {
    // Check if cell fits in current row
    if (x + cell.width + PADDING > MAX_GRID_WIDTH && x > PADDING) {
      // Wrap to next row
      x = PADDING;
      y += rowHeight + LABEL_HEIGHT + PADDING;
      rowHeight = 0;
    }

    cell.x = x;
    cell.y = y;
    rowHeight = Math.max(rowHeight, cell.height);
    maxX = Math.max(maxX, x + cell.width);
    x += cell.width + PADDING;
  }

  // Calculate final grid dimensions
  const gridWidth = Math.max(maxX + PADDING, 300); // Minimum width for title
  const gridHeight = y + rowHeight + LABEL_HEIGHT + PADDING;

  // Add title
  const titleSvg = Buffer.from(`
    <svg width="${gridWidth}" height="${TITLE_HEIGHT}">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <text x="50%" y="70%" text-anchor="middle" font-size="20" font-family="Arial" font-weight="bold" fill="#333">
        ${escapeXml(title)}
      </text>
    </svg>
  `);

  composites.push({
    input: titleSvg,
    left: 0,
    top: 0
  });

  // Third pass: add each cell to the grid
  for (const cell of cells) {
    try {
      // Load and resize thumbnail to cell dimensions
      const thumbnail = await sharp(cell.issue.extraction.absolutePath)
        .resize(cell.width, cell.height)
        .toBuffer();

      composites.push({
        input: thumbnail,
        left: cell.x,
        top: cell.y
      });

      // Add letter label below the cell
      const labelSvg = Buffer.from(`
        <svg width="${cell.width}" height="${LABEL_HEIGHT}">
          <rect width="100%" height="100%" fill="#333"/>
          <text x="50%" y="70%" text-anchor="middle" font-size="18" font-family="Arial" font-weight="bold" fill="white">
            ${cell.letter}
          </text>
        </svg>
      `);

      composites.push({
        input: labelSvg,
        left: cell.x,
        top: cell.y + cell.height
      });

      // Record cell position for later extraction (with actual dimensions)
      cellPositions.push({
        letter: cell.letter,
        issueId: cell.issue.id,
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height
      });
    } catch (err) {
      console.error(`  Failed to add issue ${cell.issue.id} to grid: ${err.message}`);
    }
  }

  // Create the grid image
  const rawGridBuffer = await sharp({
    create: {
      width: gridWidth,
      height: gridHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer();

  // Pad to Gemini-supported aspect ratio
  const { buffer: gridBuffer, padding, targetRatio } = await padToGeminiRatio(
    rawGridBuffer, gridWidth, gridHeight, 'white'
  );

  // Build manifest
  const manifest = {
    createdAt: new Date().toISOString(),
    title,
    dimensions: { width: gridWidth, height: gridHeight },
    paddedDimensions: { width: targetRatio.paddedWidth, height: targetRatio.paddedHeight },
    aspectRatio: targetRatio.name,
    padding,  // Store padding for removal after repair
    variableCells: true,  // Flag indicating variable cell sizes
    cellCount: cells.length,
    issues: cells.map(cell => ({
      letter: cell.letter,
      issueId: cell.issue.id,
      source: cell.issue.source,
      type: cell.issue.type,
      severity: cell.issue.severity,
      description: cell.issue.description,
      fixInstruction: cell.issue.fixInstruction,
      cellDimensions: { width: cell.width, height: cell.height }
    }))
  };

  return { buffer: gridBuffer, manifest, cellPositions };
}

/**
 * Batch issues into optimal groups for grid processing
 * Groups by: same page (prefer), same type (secondary)
 *
 * @param {Object[]} issues - All issues to batch
 * @param {number} maxPerGrid - Maximum issues per grid
 * @returns {Object[][]} Array of issue batches
 */
function batchIssuesForGrids(issues, maxPerGrid = MAX_PER_GRID) {
  if (issues.length === 0) return [];
  if (issues.length <= maxPerGrid) return [issues];

  const batches = [];

  // Group by page first
  const byPage = {};
  for (const issue of issues) {
    const page = issue.pageNumber;
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push(issue);
  }

  // Create batches from page groups
  for (const pageIssues of Object.values(byPage)) {
    if (pageIssues.length <= maxPerGrid) {
      batches.push(pageIssues);
    } else {
      // Split large page groups by type
      const byType = {};
      for (const issue of pageIssues) {
        const type = issue.type;
        if (!byType[type]) byType[type] = [];
        byType[type].push(issue);
      }

      let currentBatch = [];
      for (const typeIssues of Object.values(byType)) {
        for (const issue of typeIssues) {
          currentBatch.push(issue);
          if (currentBatch.length >= maxPerGrid) {
            batches.push(currentBatch);
            currentBatch = [];
          }
        }
      }
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
    }
  }

  return batches;
}

/**
 * Build a repair prompt for the grid
 *
 * @param {Object} manifest - Grid manifest with issue details
 * @returns {string} Prompt for Gemini
 */
function buildGridRepairPrompt(manifest) {
  const instructions = manifest.issues.map(i =>
    `${i.letter}: ${i.fixInstruction}`
  ).join('\n');

  const template = getRepairPromptTemplate();
  return template
    .replace('{ISSUE_COUNT}', manifest.issues.length)
    .replace('{LETTERS}', manifest.issues.map(i => i.letter).join(', '))
    .replace('{INSTRUCTIONS}', instructions);
}

/**
 * Send grid to Gemini for batch repair
 *
 * @param {Buffer} gridBuffer - Grid image buffer
 * @param {Object} manifest - Grid manifest
 * @returns {Promise<{buffer: Buffer, usage: Object}>} Repaired grid
 */
async function repairGridWithGemini(gridBuffer, manifest, retryCount = 0) {
  const model = genAI.getGenerativeModel({
    model: REPAIR_MODEL,
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],  // IMAGE first to prioritize image output
      temperature: 0.5
    }
  });

  const prompt = buildGridRepairPrompt(manifest);

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: gridBuffer.toString('base64')
        }
      }
    ]);

    const response = result.response;

    // Extract image from response
    const parts = response.candidates?.[0]?.content?.parts || [];
    let repairedBuffer = null;
    let textResponse = '';

    for (const part of parts) {
      if (part.inlineData?.data) {
        repairedBuffer = Buffer.from(part.inlineData.data, 'base64');
      } else if (part.text) {
        textResponse = part.text;
      }
    }

    if (!repairedBuffer) {
      // Retry up to 2 times (3 total attempts)
      if (retryCount < 2) {
        console.log(`  Grid repair returned text instead of image (attempt ${retryCount + 1}/3), retrying...`);
        // Add small delay before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        return repairGridWithGemini(gridBuffer, manifest, retryCount + 1);
      }
      // Return null instead of throwing to allow graceful degradation
      console.warn(`⚠️  Grid repair exhausted retries. Response: ${textResponse.substring(0, 100)}`);
      return null;
    }

    return {
      buffer: repairedBuffer,
      usage: response.usageMetadata,
      textResponse
    };
  } catch (err) {
    console.error(`Gemini grid repair failed: ${err.message}`);
    throw err;
  }
}

/**
 * Extract individual repaired regions from the grid
 *
 * @param {Buffer} repairedGrid - Repaired grid image buffer (may be padded)
 * @param {Object[]} cellPositions - Cell positions from createIssueGrid
 * @param {Object} manifest - Grid manifest with dimensions and padding info
 * @returns {Promise<Object[]>} Array of {letter, issueId, buffer}
 */
async function extractRepairedRegions(repairedGrid, cellPositions, manifest = null) {
  const regions = [];

  // Get dimensions from manifest (original grid size without padding)
  const originalWidth = manifest?.dimensions?.width;
  const originalHeight = manifest?.dimensions?.height;
  const padding = manifest?.padding || { top: 0, left: 0, bottom: 0, right: 0 };

  // Remove padding from repaired grid if it was padded
  let unpadedGrid = repairedGrid;
  if (padding.top > 0 || padding.left > 0 || padding.bottom > 0 || padding.right > 0) {
    unpadedGrid = await removePadding(repairedGrid, padding, originalWidth, originalHeight);
  }

  // Get actual dimensions of unpadded grid
  const metadata = await sharp(unpadedGrid).metadata();
  const gridWidth = metadata.width;
  const gridHeight = metadata.height;

  // Calculate scale factors based on original dimensions
  let scaleX = 1;
  let scaleY = 1;
  if (originalWidth && originalHeight) {
    scaleX = gridWidth / originalWidth;
    scaleY = gridHeight / originalHeight;
    if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
      console.log(`  [GRID] Scaling cell positions: ${originalWidth}x${originalHeight} → ${gridWidth}x${gridHeight} (scale: ${scaleX.toFixed(2)}x${scaleY.toFixed(2)})`);
    }
  }

  for (const cell of cellPositions) {
    try {
      // Scale cell positions to match repaired grid dimensions
      const scaledX = Math.round(cell.x * scaleX);
      const scaledY = Math.round(cell.y * scaleY);
      const scaledWidth = Math.round(cell.width * scaleX);
      const scaledHeight = Math.round(cell.height * scaleY);

      // Clamp to image bounds
      const left = Math.max(0, Math.min(scaledX, gridWidth - 1));
      const top = Math.max(0, Math.min(scaledY, gridHeight - 1));
      const width = Math.min(scaledWidth, gridWidth - left);
      const height = Math.min(scaledHeight, gridHeight - top);

      const buffer = await sharp(unpadedGrid)
        .extract({ left, top, width, height })
        .jpeg({ quality: 95 })
        .toBuffer();

      regions.push({
        letter: cell.letter,
        issueId: cell.issueId,
        buffer
      });
    } catch (err) {
      console.error(`  Failed to extract region ${cell.letter}: ${err.message}`);
    }
  }

  return regions;
}

/**
 * Save grid images and manifest to disk
 *
 * @param {Buffer} gridBuffer - Original grid buffer
 * @param {Buffer} repairedBuffer - Repaired grid buffer (optional)
 * @param {Object} manifest - Grid manifest
 * @param {string} outputDir - Output directory
 * @param {number} batchIndex - Batch index for filename
 */
async function saveGridFiles(gridBuffer, repairedBuffer, manifest, outputDir, batchIndex = 1) {
  const gridsDir = path.join(outputDir, 'issues', 'grids');

  try {
    if (!fs.existsSync(gridsDir)) {
      fs.mkdirSync(gridsDir, { recursive: true });
    }

    // Save original grid
    const gridPath = path.join(gridsDir, `batch_${batchIndex}.jpg`);
    fs.writeFileSync(gridPath, gridBuffer);

    // Save repaired grid if available
    let repairedPath = null;
    if (repairedBuffer) {
      repairedPath = path.join(gridsDir, `batch_${batchIndex}_repaired.jpg`);
      fs.writeFileSync(repairedPath, repairedBuffer);
    }

    // Save manifest
    const manifestPath = path.join(gridsDir, `batch_${batchIndex}_manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      files: {
        original: `batch_${batchIndex}.jpg`,
        repaired: repairedBuffer ? `batch_${batchIndex}_repaired.jpg` : null
      }
    }, null, 2));

    return {
      gridPath,
      repairedPath,
      manifestPath,
      success: true
    };
  } catch (err) {
    console.error(`Failed to save grid files for batch ${batchIndex}: ${err.message}`);
    return {
      gridPath: null,
      repairedPath: null,
      manifestPath: null,
      success: false,
      error: err.message
    };
  }
}

/**
 * Escape XML special characters for SVG text
 */
function escapeXml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Create a letter label SVG for a grid cell
 *
 * @param {string} letter - The letter to display (A, B, C, etc.)
 * @param {number} width - Label width
 * @param {number} height - Label height
 * @param {string} pageInfo - Optional page info to display below letter
 * @returns {Buffer} SVG buffer
 */
function createCellLabel(letter, width, height, pageInfo = null) {
  const fontSize = pageInfo ? 14 : 18;
  const letterY = pageInfo ? '45%' : '70%';

  let svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#333"/>
      <text x="50%" y="${letterY}" text-anchor="middle" font-size="${fontSize}" font-family="Arial" font-weight="bold" fill="white">
        ${escapeXml(letter)}
      </text>`;

  if (pageInfo) {
    svg += `
      <text x="50%" y="80%" text-anchor="middle" font-size="11" font-family="Arial" fill="#ccc">
        ${escapeXml(pageInfo)}
      </text>`;
  }

  svg += `
    </svg>`;

  return Buffer.from(svg);
}

/**
 * Create a labeled grid image from cell buffers
 * Generic function that can be used for both repair grids and entity consistency grids
 *
 * @param {Object[]} cells - Array of {buffer, letter, pageInfo?, metadata?}
 * @param {Object} options - Grid options
 * @param {string} options.title - Grid title
 * @param {number} options.cellSize - Cell size in pixels (default 256)
 * @param {number} options.maxCols - Maximum columns (default 4)
 * @param {number} options.maxRows - Maximum rows (default 3)
 * @param {boolean} options.showPageInfo - Show page number below letter (default false)
 * @returns {Promise<{buffer: Buffer, manifest: Object, cellMap: Object}>}
 */
async function createLabeledGrid(cells, options = {}) {
  const {
    title = 'Grid',
    cellSize = CELL_SIZE,
    maxCols = MAX_COLS,
    maxRows = MAX_ROWS,
    showPageInfo = false,
    padding = PADDING,
    labelHeight = LABEL_HEIGHT,
    titleHeight = TITLE_HEIGHT
  } = options;

  const maxPerGrid = maxCols * maxRows;

  if (cells.length === 0) {
    throw new Error('No cells to create grid');
  }

  // Limit to max cells
  const count = Math.min(cells.length, maxPerGrid);
  const cols = Math.min(count, maxCols);
  const rows = Math.ceil(count / cols);

  const gridWidth = cols * cellSize + padding * (cols + 1);
  const gridHeight = titleHeight + rows * (cellSize + labelHeight) + padding * (rows + 1);

  const composites = [];
  const cellMap = {};

  // Add title
  const titleSvg = Buffer.from(`
    <svg width="${gridWidth}" height="${titleHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <text x="50%" y="70%" text-anchor="middle" font-size="20" font-family="Arial" font-weight="bold" fill="#333">
        ${escapeXml(title)}
      </text>
    </svg>
  `);

  composites.push({
    input: titleSvg,
    left: 0,
    top: 0
  });

  // Add each cell with letter label
  for (let i = 0; i < count; i++) {
    const cell = cells[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = padding + col * (cellSize + padding);
    const y = titleHeight + padding + row * (cellSize + labelHeight + padding);

    try {
      // Resize cell image to fit
      let cellBuffer;
      if (Buffer.isBuffer(cell.buffer)) {
        cellBuffer = await sharp(cell.buffer)
          .resize(cellSize, cellSize, { fit: 'cover' })
          .toBuffer();
      } else if (typeof cell.buffer === 'string') {
        // Handle base64 data URI
        const base64Data = cell.buffer.replace(/^data:image\/\w+;base64,/, '');
        cellBuffer = await sharp(Buffer.from(base64Data, 'base64'))
          .resize(cellSize, cellSize, { fit: 'cover' })
          .toBuffer();
      } else {
        console.error(`  Invalid cell buffer type for cell ${i}`);
        continue;
      }

      composites.push({
        input: cellBuffer,
        left: x,
        top: y
      });

      // Add letter label with optional page info
      const letter = cell.letter || String.fromCharCode(65 + i);
      const pageInfo = showPageInfo ? cell.pageInfo : null;
      const labelSvg = createCellLabel(letter, cellSize, labelHeight, pageInfo);

      composites.push({
        input: labelSvg,
        left: x,
        top: y + cellSize
      });

      // Record cell position
      cellMap[letter] = {
        x,
        y,
        width: cellSize,
        height: cellSize,
        metadata: cell.metadata || {}
      };
    } catch (err) {
      console.error(`  Failed to add cell ${i} to grid: ${err.message}`);
    }
  }

  // Create the grid image
  const gridBuffer = await sharp({
    create: {
      width: gridWidth,
      height: gridHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer();

  // Build manifest
  const manifest = {
    createdAt: new Date().toISOString(),
    title,
    dimensions: { width: gridWidth, height: gridHeight },
    cellSize,
    cols,
    rows,
    cellCount: count,
    cells: cells.slice(0, count).map((cell, i) => ({
      letter: cell.letter || String.fromCharCode(65 + i),
      pageNumber: cell.metadata?.pageNumber,
      ...cell.metadata
    }))
  };

  return { buffer: gridBuffer, manifest, cellMap };
}

module.exports = {
  // Constants
  CELL_SIZE,
  MAX_CELL_DIM,
  MAX_GRID_WIDTH,
  MAX_COLS,
  MAX_ROWS,
  MAX_PER_GRID,
  PADDING,
  LABEL_HEIGHT,
  TITLE_HEIGHT,

  // Grid creation
  createIssueGrid,
  batchIssuesForGrids,
  createLabeledGrid,  // Generic grid creation for reuse
  createCellLabel,    // Cell label creation for reuse
  escapeXml,          // XML escaping for SVG

  // Gemini aspect ratio helpers
  GEMINI_RATIOS,
  findClosestGeminiRatio,
  padToGeminiRatio,
  removePadding,

  // Repair
  buildGridRepairPrompt,
  repairGridWithGemini,
  extractRepairedRegions,

  // File operations
  saveGridFiles
};
