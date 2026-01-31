/**
 * Entity Consistency Module
 *
 * Groups entity appearances across story pages and evaluates consistency
 * using cropped grids per entity (character, object, pet).
 *
 * This provides more focused consistency checking than the legacy full-image approach.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createLabeledGrid, escapeXml } = require('./repairGrid');
const { PROMPT_TEMPLATES } = require('../services/prompts');
const { log } = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuration
const ENTITY_CHECK_MODEL = 'gemini-2.5-flash';  // Text model for evaluation
const FACE_CROP_SIZE = 256;   // Size for face crops
const BODY_CROP_SIZE = 512;   // Size for body crops
const MIN_APPEARANCES = 2;    // Minimum appearances to check consistency
const MAX_GRID_CELLS = 12;    // Maximum cells per grid (4x3)

/**
 * Run entity-grouped consistency checks on a completed story
 *
 * @param {object} storyData - Story data with sceneImages
 * @param {Array<object>} characters - Main characters with photos
 * @param {object} options - Check options
 * @returns {Promise<object>} Entity consistency report
 */
async function runEntityConsistencyChecks(storyData, characters = [], options = {}) {
  const {
    checkCharacters = true,
    checkObjects = false,  // Objects/pets not yet implemented
    minAppearances = MIN_APPEARANCES,
    saveGrids = false,
    outputDir = null
  } = options;

  const report = {
    timestamp: new Date().toISOString(),
    characters: {},
    objects: {},
    grids: [],
    totalIssues: 0,
    overallConsistent: true,
    summary: '',
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      model: ENTITY_CHECK_MODEL
    }
  };

  try {
    const sceneImages = storyData.sceneImages || [];

    if (sceneImages.length < 2) {
      report.summary = 'Not enough images for entity consistency check';
      return report;
    }

    // Collect entity appearances from bbox detection data
    log.info('🔍 [ENTITY-CHECK] Collecting entity appearances from scene images...');
    const entityAppearances = collectEntityAppearances(sceneImages, characters);

    if (entityAppearances.size === 0) {
      report.summary = 'No entity appearances found with bounding boxes';
      return report;
    }

    log.info(`🔍 [ENTITY-CHECK] Found ${entityAppearances.size} entities with appearances`);

    // Process each character entity
    if (checkCharacters) {
      for (const character of characters) {
        const charName = character.name;
        const appearances = entityAppearances.get(charName);

        if (!appearances || appearances.length < minAppearances) {
          log.verbose(`[ENTITY-CHECK] Skipping ${charName}: only ${appearances?.length || 0} appearances (need ${minAppearances})`);
          continue;
        }

        log.info(`🔍 [ENTITY-CHECK] Checking ${charName}: ${appearances.length} appearances`);

        try {
          // Extract crops for each appearance
          const crops = await extractEntityCrops(appearances);

          if (crops.length < minAppearances) {
            log.warn(`⚠️  [ENTITY-CHECK] ${charName}: only ${crops.length} valid crops`);
            continue;
          }

          // Create entity grid
          const referencePhoto = character.photoUrl || character.photo;
          const gridResult = await createEntityGrid(crops, charName, referencePhoto);

          // Store grid for dev panel
          report.grids.push({
            entityName: charName,
            entityType: 'character',
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            manifest: gridResult.manifest,
            cellCount: crops.length
          });

          // Save grid to disk if requested
          if (saveGrids && outputDir) {
            await saveEntityGrid(gridResult.buffer, charName, 'character', outputDir);
          }

          // Evaluate consistency
          const evalResult = await evaluateEntityConsistency(
            gridResult.buffer,
            gridResult.manifest,
            {
              entityType: 'character',
              entityName: charName,
              referencePhoto,
              cellCount: crops.length
            }
          );

          // Store result
          report.characters[charName] = {
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            consistent: evalResult.consistent,
            score: evalResult.score,
            issues: evalResult.issues || [],
            summary: evalResult.summary
          };

          // Aggregate
          if (!evalResult.consistent) {
            report.overallConsistent = false;
          }
          report.totalIssues += evalResult.issues?.length || 0;

          // Track token usage
          if (evalResult.usage) {
            report.tokenUsage.inputTokens += evalResult.usage.promptTokenCount || 0;
            report.tokenUsage.outputTokens += evalResult.usage.candidatesTokenCount || 0;
            report.tokenUsage.calls++;
          }

        } catch (err) {
          log.error(`❌ [ENTITY-CHECK] Error checking ${charName}: ${err.message}`);
          report.characters[charName] = {
            error: err.message,
            consistent: true,  // Assume consistent on error
            score: 0,
            issues: []
          };
        }
      }
    }

    // Build summary
    const checkedCount = Object.keys(report.characters).length + Object.keys(report.objects).length;
    if (report.totalIssues === 0) {
      report.summary = `All ${checkedCount} entities are consistent across pages`;
    } else {
      report.summary = `Found ${report.totalIssues} consistency issue(s) across ${checkedCount} entities`;
    }

    log.info(`📋 [ENTITY-CHECK] Complete: ${report.summary}`);

  } catch (error) {
    log.error(`❌ [ENTITY-CHECK] Error running checks: ${error.message}`);
    report.error = error.message;
  }

  return report;
}

/**
 * Collect entity appearances from scene images using bbox detection data
 *
 * @param {Array<object>} sceneImages - Scene images with retryHistory
 * @param {Array<object>} characters - Characters to look for
 * @returns {Map<string, Array>} Map of entityName -> appearances
 */
function collectEntityAppearances(sceneImages, characters = []) {
  const appearances = new Map();

  // Initialize for each character
  for (const char of characters) {
    appearances.set(char.name, []);
  }

  for (const img of sceneImages) {
    const pageNumber = img.pageNumber;
    const imageData = img.imageData;

    if (!imageData) continue;

    // Get bbox detection from retryHistory
    let bboxDetection = null;
    if (img.retryHistory && Array.isArray(img.retryHistory)) {
      // Find the most recent entry with bbox detection
      for (let i = img.retryHistory.length - 1; i >= 0; i--) {
        const entry = img.retryHistory[i];
        if (entry.bboxDetection) {
          bboxDetection = entry.bboxDetection;
          break;
        }
      }
    }

    // Get quality matches (character -> figure mapping)
    const qualityMatches = bboxDetection?.qualityMatches || [];

    // Get clothing info for this page
    const characterClothing = img.characterClothing || {};
    const defaultClothing = img.clothing || 'standard';

    // Process quality matches to find character appearances
    for (const match of qualityMatches) {
      if (!match.reference || match.confidence < 0.5) continue;

      const charName = match.reference;
      if (!appearances.has(charName)) {
        appearances.set(charName, []);
      }

      // Find the figure with matching bbox
      const figureIndex = match.figure - 1;  // figure is 1-indexed
      const figures = bboxDetection?.figures || [];
      const figure = figures[figureIndex];

      if (!figure) {
        log.verbose(`[ENTITY-COLLECT] No figure found for ${charName} on page ${pageNumber}`);
        continue;
      }

      // Get clothing for this character on this page
      const clothing = characterClothing[charName] || defaultClothing;

      appearances.get(charName).push({
        pageNumber,
        imageData,
        faceBox: figure.faceBox || null,
        bodyBox: figure.bodyBox || null,
        position: figure.position || match.position,
        label: figure.label,
        clothing,
        confidence: match.confidence
      });
    }

    // Also check figures by label matching for characters without quality matches
    const figures = bboxDetection?.figures || [];
    for (const char of characters) {
      const charName = char.name;
      const charApps = appearances.get(charName);

      // Skip if we already have an appearance for this page
      if (charApps.some(a => a.pageNumber === pageNumber)) continue;

      // Try to match by label
      const charNameLower = charName.toLowerCase();
      const matchingFigure = figures.find(f => {
        const label = (f.label || '').toLowerCase();
        return label.includes(charNameLower) ||
               charNameLower.includes(label.split(' ')[0]);  // Match first word
      });

      if (matchingFigure) {
        const clothing = characterClothing[charName] || defaultClothing;
        charApps.push({
          pageNumber,
          imageData,
          faceBox: matchingFigure.faceBox || null,
          bodyBox: matchingFigure.bodyBox || null,
          position: matchingFigure.position,
          label: matchingFigure.label,
          clothing,
          confidence: 0.6  // Lower confidence for label-based match
        });
      }
    }
  }

  // Filter out entities with too few appearances
  for (const [name, apps] of appearances) {
    if (apps.length < MIN_APPEARANCES) {
      appearances.delete(name);
    }
  }

  return appearances;
}

/**
 * Extract cropped images for each entity appearance
 *
 * @param {Array<object>} appearances - Entity appearances with bbox info
 * @returns {Promise<Array>} Array of crop objects with buffer
 */
async function extractEntityCrops(appearances) {
  const crops = [];

  for (const app of appearances) {
    try {
      // Prefer face crop if available, otherwise use body
      const bbox = app.faceBox || app.bodyBox;
      const cropType = app.faceBox ? 'face' : 'body';
      const targetSize = cropType === 'face' ? FACE_CROP_SIZE : BODY_CROP_SIZE;

      if (!bbox) {
        log.verbose(`[ENTITY-CROP] No bbox for page ${app.pageNumber}`);
        continue;
      }

      // Extract crop from image
      const cropBuffer = await extractCropFromImage(
        app.imageData,
        bbox,
        targetSize,
        cropType === 'face' ? 0.3 : 0.1  // More padding for face crops
      );

      if (cropBuffer) {
        crops.push({
          buffer: cropBuffer,
          pageNumber: app.pageNumber,
          cropType,
          clothing: app.clothing,
          position: app.position,
          confidence: app.confidence
        });
      }
    } catch (err) {
      log.warn(`⚠️  [ENTITY-CROP] Failed to extract crop for page ${app.pageNumber}: ${err.message}`);
    }
  }

  return crops;
}

/**
 * Extract a crop from an image given a bounding box
 *
 * @param {string} imageData - Base64 image data
 * @param {number[]} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized 0-1
 * @param {number} targetSize - Target crop size in pixels
 * @param {number} padding - Padding ratio to add around bbox (0-0.5)
 * @returns {Promise<Buffer|null>} Cropped image buffer
 */
async function extractCropFromImage(imageData, bbox, targetSize, padding = 0.1) {
  try {
    // Handle data URI prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');

    // Get image dimensions
    const metadata = await sharp(imgBuffer).metadata();
    const width = metadata.width;
    const height = metadata.height;

    // Convert normalized bbox to pixel coordinates
    const [ymin, xmin, ymax, xmax] = bbox;
    let x1 = Math.round(xmin * width);
    let y1 = Math.round(ymin * height);
    let x2 = Math.round(xmax * width);
    let y2 = Math.round(ymax * height);

    // Add padding
    const bboxWidth = x2 - x1;
    const bboxHeight = y2 - y1;
    const padX = Math.round(bboxWidth * padding);
    const padY = Math.round(bboxHeight * padding);

    x1 = Math.max(0, x1 - padX);
    y1 = Math.max(0, y1 - padY);
    x2 = Math.min(width, x2 + padX);
    y2 = Math.min(height, y2 + padY);

    // Extract and resize
    const cropBuffer = await sharp(imgBuffer)
      .extract({
        left: x1,
        top: y1,
        width: x2 - x1,
        height: y2 - y1
      })
      .resize(targetSize, targetSize, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();

    return cropBuffer;
  } catch (err) {
    log.error(`[ENTITY-CROP] Extraction error: ${err.message}`);
    return null;
  }
}

/**
 * Create an entity grid image from appearance crops
 *
 * @param {Array<object>} crops - Array of crop objects
 * @param {string} entityName - Name of the entity
 * @param {string|null} referencePhoto - Optional reference photo URL
 * @returns {Promise<{buffer: Buffer, manifest: Object, cellMap: Object}>}
 */
async function createEntityGrid(crops, entityName, referencePhoto = null) {
  // Sort by page number
  const sortedCrops = [...crops].sort((a, b) => a.pageNumber - b.pageNumber);

  // Limit to max grid cells (leave 1 slot for reference if available)
  const maxCrops = referencePhoto ? MAX_GRID_CELLS - 1 : MAX_GRID_CELLS;
  const cropsToUse = sortedCrops.slice(0, maxCrops);

  // Build cells array
  const cells = [];

  // Add reference photo as first cell if available
  if (referencePhoto) {
    try {
      let refBuffer;
      if (referencePhoto.startsWith('data:')) {
        const base64Data = referencePhoto.replace(/^data:image\/\w+;base64,/, '');
        refBuffer = Buffer.from(base64Data, 'base64');
      } else if (referencePhoto.startsWith('http')) {
        // Fetch from URL - would need to implement fetch
        // For now, skip URL-based reference photos
        log.warn(`⚠️  [ENTITY-GRID] URL-based reference photos not yet supported`);
      } else {
        refBuffer = Buffer.from(referencePhoto, 'base64');
      }

      if (refBuffer) {
        cells.push({
          buffer: refBuffer,
          letter: 'R',  // R for Reference
          pageInfo: 'Ref',
          metadata: {
            isReference: true,
            entityName
          }
        });
      }
    } catch (err) {
      log.warn(`⚠️  [ENTITY-GRID] Failed to add reference photo: ${err.message}`);
    }
  }

  // Add appearance crops
  for (let i = 0; i < cropsToUse.length; i++) {
    const crop = cropsToUse[i];
    const letter = String.fromCharCode(65 + i);  // A, B, C...

    cells.push({
      buffer: crop.buffer,
      letter,
      pageInfo: `P${crop.pageNumber}`,
      metadata: {
        pageNumber: crop.pageNumber,
        cropType: crop.cropType,
        clothing: crop.clothing,
        position: crop.position,
        confidence: crop.confidence
      }
    });
  }

  // Create grid using shared utility
  return createLabeledGrid(cells, {
    title: `${entityName} - Entity Consistency`,
    cellSize: FACE_CROP_SIZE,
    showPageInfo: true,
    maxCols: 4,
    maxRows: 3
  });
}

/**
 * Evaluate entity consistency using Gemini
 *
 * @param {Buffer} gridBuffer - Grid image buffer
 * @param {Object} manifest - Grid manifest
 * @param {Object} entityInfo - Entity information
 * @returns {Promise<Object>} Evaluation result
 */
async function evaluateEntityConsistency(gridBuffer, manifest, entityInfo) {
  const { entityType, entityName, referencePhoto, cellCount } = entityInfo;

  // Build prompt from template
  const promptTemplate = PROMPT_TEMPLATES.entityConsistencyCheck;
  if (!promptTemplate) {
    log.error('❌ [ENTITY-CHECK] Missing prompt template: entity-consistency-check.txt');
    return {
      consistent: true,
      score: 0,
      issues: [],
      summary: 'Prompt template not available',
      error: 'Missing prompt template'
    };
  }

  // Build cell info JSON
  const cellInfo = manifest.cells.map(cell => ({
    cell: cell.letter,
    page: cell.isReference ? 'Reference Photo' : cell.pageNumber,
    clothing: cell.clothing || 'standard',
    cropType: cell.cropType || 'face'
  }));

  // Build reference photo info
  const refPhotoInfo = referencePhoto
    ? 'A reference photo of this character is provided as cell R.'
    : 'No reference photo available.';

  // Fill template
  const prompt = promptTemplate
    .replace('{ENTITY_TYPE}', entityType)
    .replace('{ENTITY_NAME}', entityName)
    .replace(/\{ENTITY_NAME\}/g, entityName)  // Replace all occurrences
    .replace('{REFERENCE_PHOTO_INFO}', refPhotoInfo)
    .replace('{CELL_INFO}', JSON.stringify(cellInfo, null, 2))
    .replace('{CELL_COUNT}', cellCount.toString());

  try {
    const model = genAI.getGenerativeModel({
      model: ENTITY_CHECK_MODEL,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048
      }
    });

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
    const text = response.text();

    // Parse JSON response
    let parsed;
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = text;

      // Try to extract from ```json ... ``` blocks
      const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1];
      } else {
        // Try to extract from ``` ... ``` blocks
        const codeBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1];
        } else {
          // Try to find JSON object directly (starts with {)
          const jsonObjMatch = text.match(/\{[\s\S]*\}/);
          if (jsonObjMatch) {
            jsonText = jsonObjMatch[0];
          }
        }
      }

      parsed = JSON.parse(jsonText.trim());
    } catch (parseErr) {
      log.warn(`⚠️  [ENTITY-CHECK] Failed to parse response for ${entityName}: ${parseErr.message}`);
      log.debug(`[ENTITY-CHECK] Raw response: ${text.substring(0, 200)}...`);
      return {
        consistent: true,
        score: 5,
        issues: [],
        summary: 'Could not parse evaluation response',
        rawResponse: text,
        parseError: true
      };
    }

    // Convert issues to unified format
    const issues = (parsed.issues || []).map(issue => ({
      id: `entity_${entityName.toLowerCase().replace(/\s+/g, '_')}_${issue.pagesToFix?.[0] || 'unknown'}`,
      source: 'entity',
      pageNumber: issue.pagesToFix?.[0] || null,
      region: null,  // Will be enriched later if needed
      type: 'consistency',
      subType: issue.type,
      severity: issue.severity || 'major',
      description: issue.description,
      fixInstruction: issue.fixInstruction,
      affectedCharacter: entityName,
      cells: issue.cells,
      pagesToFix: issue.pagesToFix,
      canonicalVersion: issue.canonicalVersion
    }));

    return {
      consistent: parsed.consistent ?? true,
      score: parsed.score ?? 10,
      issues,
      summary: parsed.summary || 'Evaluation complete',
      usage: response.usageMetadata
    };

  } catch (err) {
    log.error(`❌ [ENTITY-CHECK] Gemini evaluation failed for ${entityName}: ${err.message}`);
    return {
      consistent: true,
      score: 0,
      issues: [],
      summary: `Evaluation failed: ${err.message}`,
      error: err.message
    };
  }
}

/**
 * Save entity grid to disk
 *
 * @param {Buffer} gridBuffer - Grid image buffer
 * @param {string} entityName - Entity name
 * @param {string} entityType - Entity type (character, object)
 * @param {string} outputDir - Output directory
 * @returns {Promise<string>} Path to saved grid
 */
async function saveEntityGrid(gridBuffer, entityName, entityType, outputDir) {
  try {
    // Create output directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Sanitize entity name for filename
    const safeName = entityName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${entityType}_${safeName}_grid.jpg`;
    const filepath = path.join(outputDir, filename);

    fs.writeFileSync(filepath, gridBuffer);
    log.info(`💾 [ENTITY-CHECK] Saved grid: ${filepath}`);

    return filepath;
  } catch (err) {
    log.error(`❌ [ENTITY-CHECK] Failed to save grid: ${err.message}`);
    return null;
  }
}

/**
 * Save all entity grids to disk
 *
 * @param {Array<object>} grids - Array of grid objects from report
 * @param {string} outputDir - Output directory
 * @returns {Promise<Array<string>>} Paths to saved grids
 */
async function saveEntityGrids(grids, outputDir) {
  const paths = [];

  for (const grid of grids) {
    // Extract buffer from data URI
    const base64Data = grid.gridImage.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const savedPath = await saveEntityGrid(
      buffer,
      grid.entityName,
      grid.entityType,
      outputDir
    );

    if (savedPath) {
      paths.push(savedPath);
    }
  }

  return paths;
}

module.exports = {
  // Main function
  runEntityConsistencyChecks,

  // Helper functions (exported for testing)
  collectEntityAppearances,
  extractEntityCrops,
  extractCropFromImage,
  createEntityGrid,
  evaluateEntityConsistency,
  saveEntityGrid,
  saveEntityGrids,

  // Constants
  FACE_CROP_SIZE,
  BODY_CROP_SIZE,
  MIN_APPEARANCES,
  MAX_GRID_CELLS
};
