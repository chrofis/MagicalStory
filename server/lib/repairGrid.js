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
async function repairGridWithGemini(gridBuffer, manifest) {
  const model = genAI.getGenerativeModel({
    model: REPAIR_MODEL,
    generationConfig: {
      responseModalities: ['image', 'text']
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
      throw new Error('Gemini did not return an image. Response: ' + textResponse);
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
 * @returns {Promise<Object[]>} Array of {letter, issueId, buffer}
 */
async function extractRepairedRegions(repairedGrid, cellPositions) {
  const regions = [];

  for (const cell of cellPositions) {
    try {
      const buffer = await sharp(repairedGrid)
        .extract({
          left: cell.x,
          top: cell.y,
          width: cell.width,
          height: cell.height
        })
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
  if (!fs.existsSync(gridsDir)) {
    fs.mkdirSync(gridsDir, { recursive: true });
  }

  // Save original grid
  const gridPath = path.join(gridsDir, `batch_${batchIndex}.jpg`);
  fs.writeFileSync(gridPath, gridBuffer);

  // Save repaired grid if available
  if (repairedBuffer) {
    const repairedPath = path.join(gridsDir, `batch_${batchIndex}_repaired.jpg`);
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
    repairedPath: repairedBuffer ? path.join(gridsDir, `batch_${batchIndex}_repaired.jpg`) : null,
    manifestPath
  };
}

/**
 * Escape XML special characters for SVG text
 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  // Constants
  CELL_SIZE,
  MAX_COLS,
  MAX_ROWS,
  MAX_PER_GRID,

  // Grid creation
  createIssueGrid,
  batchIssuesForGrids,

  // Repair
  buildGridRepairPrompt,
  repairGridWithGemini,
  extractRepairedRegions,

  // File operations
  saveGridFiles
};
