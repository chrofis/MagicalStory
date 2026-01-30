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
const CELL_SIZE = 256;      // Size of each cell (matches TARGET_REGION_SIZE)
const MAX_COLS = 4;         // Maximum columns per grid
const MAX_ROWS = 3;         // Maximum rows per grid
const MAX_PER_GRID = 12;    // MAX_COLS * MAX_ROWS
const PADDING = 10;         // Padding between cells
const LABEL_HEIGHT = 30;    // Height for letter labels
const TITLE_HEIGHT = 40;    // Height for grid title

// Gemini model for image editing (same as page generation)
const REPAIR_MODEL = 'gemini-2.5-flash-image';

/**
 * Create a labeled grid image from extracted issue thumbnails
 *
 * @param {Object[]} issues - Array of issues with extraction.absolutePath
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

  // Calculate grid dimensions
  const count = Math.min(validIssues.length, MAX_PER_GRID);
  const cols = Math.min(count, MAX_COLS);
  const rows = Math.ceil(count / cols);

  const gridWidth = cols * CELL_SIZE + PADDING * (cols + 1);
  const gridHeight = TITLE_HEIGHT + rows * (CELL_SIZE + LABEL_HEIGHT) + PADDING * (rows + 1);

  const composites = [];
  const cellPositions = [];

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

  // Add each issue cell with letter label
  for (let i = 0; i < count; i++) {
    const issue = validIssues[i];
    const col = i % cols;
    const row = Math.floor(i / cols);

    const x = PADDING + col * (CELL_SIZE + PADDING);
    const y = TITLE_HEIGHT + PADDING + row * (CELL_SIZE + LABEL_HEIGHT + PADDING);

    // Load and resize thumbnail
    try {
      const thumbnail = await sharp(issue.extraction.absolutePath)
        .resize(CELL_SIZE, CELL_SIZE, { fit: 'cover' })
        .toBuffer();

      composites.push({
        input: thumbnail,
        left: x,
        top: y
      });

      // Add letter label (A, B, C, ...)
      const letter = String.fromCharCode(65 + i);
      const labelSvg = Buffer.from(`
        <svg width="${CELL_SIZE}" height="${LABEL_HEIGHT}">
          <rect width="100%" height="100%" fill="#333"/>
          <text x="50%" y="70%" text-anchor="middle" font-size="18" font-family="Arial" font-weight="bold" fill="white">
            ${letter}
          </text>
        </svg>
      `);

      composites.push({
        input: labelSvg,
        left: x,
        top: y + CELL_SIZE
      });

      // Record cell position for later extraction
      cellPositions.push({
        letter,
        issueId: issue.id,
        x,
        y,
        width: CELL_SIZE,
        height: CELL_SIZE
      });
    } catch (err) {
      console.error(`  Failed to add issue ${issue.id} to grid: ${err.message}`);
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
    cellSize: CELL_SIZE,
    cols,
    rows,
    issues: validIssues.slice(0, count).map((issue, i) => ({
      letter: String.fromCharCode(65 + i),
      issueId: issue.id,
      source: issue.source,
      type: issue.type,
      severity: issue.severity,
      description: issue.description,
      fixInstruction: issue.fixInstruction
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
 * @param {Buffer} repairedGrid - Repaired grid image buffer
 * @param {Object[]} cellPositions - Cell positions from createIssueGrid
 * @param {Object} originalDimensions - Original grid dimensions {width, height} for scaling
 * @returns {Promise<Object[]>} Array of {letter, issueId, buffer}
 */
async function extractRepairedRegions(repairedGrid, cellPositions, originalDimensions = null) {
  const regions = [];

  // Get actual dimensions of repaired grid
  const metadata = await sharp(repairedGrid).metadata();
  const repairedWidth = metadata.width;
  const repairedHeight = metadata.height;

  // Calculate scale factors if original dimensions provided
  let scaleX = 1;
  let scaleY = 1;
  if (originalDimensions) {
    scaleX = repairedWidth / originalDimensions.width;
    scaleY = repairedHeight / originalDimensions.height;
    if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
      console.log(`  [GRID] Scaling cell positions: ${originalDimensions.width}x${originalDimensions.height} → ${repairedWidth}x${repairedHeight} (scale: ${scaleX.toFixed(2)}x${scaleY.toFixed(2)})`);
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
      const left = Math.max(0, Math.min(scaledX, repairedWidth - 1));
      const top = Math.max(0, Math.min(scaledY, repairedHeight - 1));
      const width = Math.min(scaledWidth, repairedWidth - left);
      const height = Math.min(scaledHeight, repairedHeight - top);

      const buffer = await sharp(repairedGrid)
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

  // Repair
  buildGridRepairPrompt,
  repairGridWithGemini,
  extractRepairedRegions,

  // File operations
  saveGridFiles
};
