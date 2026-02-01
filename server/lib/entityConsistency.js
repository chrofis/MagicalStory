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
const { extractSceneMetadata } = require('./storyHelpers');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuration
const ENTITY_CHECK_MODEL = 'gemini-2.5-flash';  // Text model for evaluation
const FACE_CROP_SIZE = 256;   // Size for face crops
const BODY_CROP_SIZE = 512;   // Size for body crops
const MIN_APPEARANCES = 2;    // Minimum appearances to check consistency
const MAX_GRID_CELLS = 12;    // Maximum cells per grid (4x3)

/**
 * Get the appropriate styled avatar for a character based on clothing category
 *
 * @param {object} character - Character object with avatars
 * @param {string} artStyle - Art style (e.g., 'pixar', 'watercolor')
 * @param {string} clothingCategory - Clothing category (e.g., 'standard', 'winter', 'costumed:pirate')
 * @returns {string|null} Styled avatar URL/data URI, or null if not found
 */
function getStyledAvatarForClothing(character, artStyle, clothingCategory) {
  const avatars = character.avatars;
  if (!avatars?.styledAvatars?.[artStyle]) {
    // Fallback to original photo if no styled avatars
    return character.photoUrl || character.photo || null;
  }

  const styledForArt = avatars.styledAvatars[artStyle];

  // Handle costumed categories (e.g., "costumed:pirate")
  if (clothingCategory.startsWith('costumed:')) {
    const costumeType = clothingCategory.replace('costumed:', '');
    const costumedAvatar = styledForArt.costumed?.[costumeType];
    if (costumedAvatar) return costumedAvatar;
    // Fallback to standard styled if costume not found
    return styledForArt.standard || character.photoUrl || character.photo || null;
  }

  // Handle standard categories (standard, winter, summer)
  const styledAvatar = styledForArt[clothingCategory];
  if (styledAvatar) return styledAvatar;

  // Fallback chain: requested → standard → original
  return styledForArt.standard || character.photoUrl || character.photo || null;
}

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
    checkObjects = true,  // Enable object consistency checking
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
    const sceneDescriptions = storyData.sceneDescriptions || [];

    if (sceneImages.length < 2) {
      report.summary = 'Not enough images for entity consistency check';
      return report;
    }

    // Collect entity appearances from bbox detection data
    log.info('🔍 [ENTITY-CHECK] Collecting entity appearances from scene images...');
    const entityAppearances = collectEntityAppearances(sceneImages, characters, sceneDescriptions);

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
            summary: evalResult.summary,
            // Include debug info for parse failures
            ...(evalResult.parseError && { parseError: true, rawResponse: evalResult.rawResponse })
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

    // Process objects (after character loop)
    if (checkObjects) {
      // Collect object appearances from bboxDetection.objects + objectMatches
      const objectAppearances = collectObjectAppearances(sceneImages);

      for (const [objName, appearances] of objectAppearances) {
        if (appearances.length < minAppearances) continue;

        log.info(`🔍 [ENTITY-CHECK] Checking object ${objName}: ${appearances.length} appearances`);

        try {
          // Extract crops (objects only have bodyBox)
          const crops = await extractEntityCrops(appearances);

          if (crops.length < minAppearances) {
            log.warn(`⚠️  [ENTITY-CHECK] ${objName}: only ${crops.length} valid crops`);
            continue;
          }

          // Create grid (no reference photo for objects)
          const gridResult = await createEntityGrid(crops, objName, null);

          // Store grid for dev panel
          report.grids.push({
            entityName: objName,
            entityType: 'object',
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            manifest: gridResult.manifest,
            cellCount: crops.length
          });

          // Save grid to disk if requested
          if (saveGrids && outputDir) {
            await saveEntityGrid(gridResult.buffer, objName, 'object', outputDir);
          }

          // Evaluate consistency
          const evalResult = await evaluateEntityConsistency(
            gridResult.buffer,
            gridResult.manifest,
            {
              entityType: 'object',
              entityName: objName,
              referencePhoto: null,
              cellCount: crops.length
            }
          );

          // Store result
          report.objects[objName] = {
            gridImage: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
            consistent: evalResult.consistent,
            score: evalResult.score,
            issues: evalResult.issues || [],
            summary: evalResult.summary,
            // Include debug info for parse failures
            ...(evalResult.parseError && { parseError: true, rawResponse: evalResult.rawResponse })
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
          log.error(`❌ [ENTITY-CHECK] Error checking object ${objName}: ${err.message}`);
          report.objects[objName] = {
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
 * @param {Array<object>} sceneDescriptions - Scene descriptions for extracting clothing metadata
 * @returns {Map<string, Array>} Map of entityName -> appearances
 */
function collectEntityAppearances(sceneImages, characters = [], sceneDescriptions = []) {
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

    // Get clothing info for this page - try multiple sources
    // Priority: img.characterClothing > scene description metadata > img.clothing > 'standard'
    let characterClothing = img.characterClothing || img.sceneCharacterClothing || {};
    let defaultClothing = img.clothing || 'standard';

    // If no per-character clothing found, try to extract from scene description metadata
    if (Object.keys(characterClothing).length === 0 && sceneDescriptions.length > 0) {
      const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);
      if (sceneDesc?.description) {
        const metadata = extractSceneMetadata(sceneDesc.description);
        if (metadata) {
          // Extract per-character clothing from metadata
          if (metadata.characterClothing && Object.keys(metadata.characterClothing).length > 0) {
            characterClothing = metadata.characterClothing;
            log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Extracted clothing from scene metadata: ${JSON.stringify(characterClothing)}`);
          }
          // Also check for global clothing in metadata
          if (metadata.clothing && !defaultClothing) {
            defaultClothing = metadata.clothing;
          }
        }
      }
    }

    // Debug: log clothing info for this page
    if (Object.keys(characterClothing).length > 0) {
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: Per-char clothing: ${JSON.stringify(characterClothing)}`);
    }

    // Get figures from bbox detection - now includes direct character identification via figure.name
    const figures = bboxDetection?.figures || [];

    // Debug logging for entity collection
    if (!bboxDetection) {
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: No bboxDetection found in retryHistory (entries: ${img.retryHistory?.length || 0})`);
    } else {
      const identifiedFigures = figures.filter(f => f.name && f.name !== 'UNKNOWN');
      log.debug(`[ENTITY-COLLECT] Page ${pageNumber}: ${figures.length} figures, ${identifiedFigures.length} identified: ${identifiedFigures.map(f => f.name).join(', ')}`);
    }

    // Match characters by figure.name (direct AI identification)
    for (const char of characters) {
      const charName = char.name;
      const charApps = appearances.get(charName);

      // Skip if we already have an appearance for this page
      if (charApps && charApps.some(a => a.pageNumber === pageNumber)) continue;

      // Find figure by direct name match (new bbox detection includes character name in figure.name)
      const charNameLower = charName.toLowerCase();
      let matchingFigure = figures.find(f => {
        const figureName = (f.name || '').toLowerCase();
        return figureName === charNameLower;
      });

      // Fallback: try label matching if name didn't match
      // NOTE: Be strict - only match if character name appears as a word in label
      // Don't use substring matching (e.g., "man" in "manuel") as this causes false matches
      if (!matchingFigure) {
        matchingFigure = figures.find(f => {
          const label = (f.label || '').toLowerCase();
          // Match if character name appears as a complete word in the label
          const namePattern = new RegExp(`\\b${charNameLower}\\b`, 'i');
          return namePattern.test(label);
        });
      }

      if (matchingFigure) {
        const clothing = characterClothing[charName] || defaultClothing;
        // Determine confidence based on how we matched
        const confidence = (matchingFigure.name || '').toLowerCase() === charNameLower
          ? (matchingFigure.confidence === 'high' ? 0.95 : matchingFigure.confidence === 'medium' ? 0.8 : 0.65)
          : 0.5;  // Lower confidence for label-based match

        if (!charApps) {
          appearances.set(charName, []);
        }
        appearances.get(charName).push({
          pageNumber,
          imageData,
          faceBox: matchingFigure.faceBox || null,
          bodyBox: matchingFigure.bodyBox || null,
          position: matchingFigure.position,
          label: matchingFigure.label,
          clothing,
          confidence
        });
      }
    }
  }

  // Filter out entities with too few appearances
  for (const [name, apps] of appearances) {
    if (apps.length < MIN_APPEARANCES) {
      log.debug(`[ENTITY-COLLECT] Filtering out "${name}" with only ${apps.length} appearances (min: ${MIN_APPEARANCES})`);
      appearances.delete(name);
    }
  }

  // Log summary
  const totalAppearances = Array.from(appearances.values()).reduce((sum, apps) => sum + apps.length, 0);
  log.info(`[ENTITY-COLLECT] Found ${appearances.size} characters with ${totalAppearances} total appearances: ${Array.from(appearances.entries()).map(([name, apps]) => `${name}(${apps.length})`).join(', ')}`);

  return appearances;
}

/**
 * Collect object appearances from scene images using bbox detection data
 *
 * @param {Array<object>} sceneImages - Scene images with retryHistory
 * @returns {Map<string, Array>} Map of objectName -> appearances
 */
function collectObjectAppearances(sceneImages) {
  const appearances = new Map();

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

    if (!bboxDetection?.objects) continue;

    // Match objects via objectMatches or use labels directly
    for (const obj of bboxDetection.objects) {
      const match = bboxDetection.objectMatches?.find(m =>
        m.label === obj.label
      );
      const name = match?.reference || obj.label;

      if (!appearances.has(name)) {
        appearances.set(name, []);
      }

      appearances.get(name).push({
        pageNumber,
        imageData,
        bodyBox: obj.bodyBox,
        faceBox: null,  // Objects don't have faces
        label: obj.label,
        confidence: match?.confidence || 0.7,
        isObject: true  // Mark as object for 15% padding in crop extraction
      });
    }
  }

  // Filter out objects with too few appearances
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
 * @param {object} options - Extraction options
 * @param {boolean} options.forRegeneration - If true, output PNG and store original image data for compositing
 * @returns {Promise<Array>} Array of crop objects with buffer, paddedBox, and optionally originalImageData
 */
async function extractEntityCrops(appearances, options = {}) {
  const { forRegeneration = false } = options;
  const crops = [];

  for (const app of appearances) {
    try {
      // Prefer body crop (more reliable than face detection)
      const bbox = app.bodyBox || app.faceBox;  // Prefer body, fallback to face
      const cropType = 'body';  // Always use body crop
      const isObject = app.isObject || false;

      if (!bbox) {
        log.verbose(`[ENTITY-CROP] No bbox for page ${app.pageNumber}`);
        continue;
      }

      // Extract crop from image
      // Figures: asymmetric padding (10% up, 5% sides) to avoid cutting off heads
      // Objects: 15% uniform padding, no resize, original aspect
      const cropResult = await extractCropFromImage(
        app.imageData,
        bbox,
        null,  // No resize - keep original size
        isObject ? 0.15 : 0,  // Uniform padding for objects
        {
          forRegeneration,
          // Asymmetric padding for figures: extend upward to capture full head
          asymmetricPadding: isObject ? null : { top: 0.10, bottom: 0, left: 0.05, right: 0.05 }
        }
      );

      if (cropResult && cropResult.buffer) {
        // Get original crop dimensions for proper resizing after repair
        const cropMeta = await sharp(cropResult.buffer).metadata();

        const cropData = {
          buffer: cropResult.buffer,
          pageNumber: app.pageNumber,
          cropType,
          clothing: app.clothing,
          position: app.position,
          confidence: app.confidence,
          // NEW: Store for compositing back
          paddedBox: cropResult.paddedBox,
          // Store original dimensions for resizing repaired cells
          originalWidth: cropMeta.width,
          originalHeight: cropMeta.height
        };

        // Store original image data reference for regeneration/compositing
        if (forRegeneration) {
          cropData.originalImageData = app.imageData;
        }

        crops.push(cropData);
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
 * @param {number|null} targetSize - Target crop size in pixels, or null for no resize (keep original)
 * @param {number} padding - Uniform padding ratio to add around bbox (0-0.5)
 * @param {object} options - Additional options
 * @param {boolean} options.forRegeneration - If true, output PNG for lossless quality
 * @param {object} options.asymmetricPadding - Optional asymmetric padding {top, bottom, left, right} as ratios
 * @returns {Promise<{buffer: Buffer, paddedBox: number[]}|null>} Cropped image buffer and normalized padded box
 */
async function extractCropFromImage(imageData, bbox, targetSize, padding = 0, options = {}) {
  const { forRegeneration = false, asymmetricPadding = null } = options;

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

    // Add padding if specified
    if (asymmetricPadding) {
      // Asymmetric padding: different amounts for each direction
      const bboxWidth = x2 - x1;
      const bboxHeight = y2 - y1;
      const padTop = Math.round(bboxHeight * (asymmetricPadding.top || 0));
      const padBottom = Math.round(bboxHeight * (asymmetricPadding.bottom || 0));
      const padLeft = Math.round(bboxWidth * (asymmetricPadding.left || 0));
      const padRight = Math.round(bboxWidth * (asymmetricPadding.right || 0));

      y1 = Math.max(0, y1 - padTop);
      y2 = Math.min(height, y2 + padBottom);
      x1 = Math.max(0, x1 - padLeft);
      x2 = Math.min(width, x2 + padRight);
    } else if (padding > 0) {
      // Uniform padding
      const bboxWidth = x2 - x1;
      const bboxHeight = y2 - y1;
      const padX = Math.round(bboxWidth * padding);
      const padY = Math.round(bboxHeight * padding);

      x1 = Math.max(0, x1 - padX);
      y1 = Math.max(0, y1 - padY);
      x2 = Math.min(width, x2 + padX);
      y2 = Math.min(height, y2 + padY);
    }

    // Calculate normalized padded box for later compositing
    const paddedBox = [y1 / height, x1 / width, y2 / height, x2 / width];

    // Extract crop (no resize if targetSize is null)
    let sharpPipeline = sharp(imgBuffer)
      .extract({
        left: x1,
        top: y1,
        width: x2 - x1,
        height: y2 - y1
      });

    // Only resize if targetSize is specified
    if (targetSize) {
      sharpPipeline = sharpPipeline.resize(targetSize, targetSize, { fit: 'cover' });
    }

    // Use PNG for regeneration (lossless), JPEG otherwise
    const cropBuffer = forRegeneration
      ? await sharpPipeline.png().toBuffer()
      : await sharpPipeline.jpeg({ quality: 90 }).toBuffer();

    return { buffer: cropBuffer, paddedBox };
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
        maxOutputTokens: 8192  // Increased from 2048 to handle complex responses with many issues
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

      // Try to extract from ```json ... ``` blocks (with closing backticks)
      const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        jsonText = jsonBlockMatch[1];
      } else {
        // Try to extract from ``` ... ``` blocks (with closing backticks)
        const codeBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch) {
          jsonText = codeBlockMatch[1];
        } else if (text.trim().startsWith('```json')) {
          // Handle case where response starts with ```json but has no closing backticks
          jsonText = text.trim().replace(/^```json\s*/, '').replace(/```\s*$/, '');
        } else if (text.trim().startsWith('```')) {
          // Handle case where response starts with ``` but has no closing backticks
          jsonText = text.trim().replace(/^```\s*/, '').replace(/```\s*$/, '');
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

// Repair model (same as repairGrid.js)
const REPAIR_MODEL = 'gemini-2.5-flash-image';

/**
 * Repair entity consistency by regenerating problematic cells to match reference
 * Groups crops by clothing category and uses appropriate styled avatar for each group
 *
 * @param {object} storyData - Story data with sceneImages and artStyle
 * @param {object} character - Character object with name, photoUrl, and avatars
 * @param {object} entityReport - Entity consistency report from runEntityConsistencyChecks
 * @param {object} options - Repair options
 * @returns {Promise<object>} Repair result with updated images grouped by clothing
 */
async function repairEntityConsistency(storyData, character, entityReport, options = {}) {
  const charName = character.name;
  const charReport = entityReport.characters?.[charName];

  if (!charReport) {
    return { success: false, error: `No consistency report found for ${charName}` };
  }

  if (charReport.consistent && charReport.score >= 8) {
    return { success: true, message: `${charName} is already consistent (score: ${charReport.score})`, noChanges: true };
  }

  log.info(`🔧 [ENTITY-REPAIR] Starting repair for ${charName} (current score: ${charReport.score})`);

  try {
    // Get artStyle from storyData
    const artStyle = storyData.artStyle || 'pixar';

    // Step 1: Collect entity appearances with forRegeneration=true
    const sceneImages = storyData.sceneImages || [];
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const entityAppearances = collectEntityAppearances(sceneImages, [character], sceneDescriptions);
    const appearances = entityAppearances.get(charName);

    if (!appearances || appearances.length < 2) {
      return { success: false, error: `Not enough appearances for ${charName}` };
    }

    // Step 2: Extract crops with paddedBox and originalImageData for compositing
    const crops = await extractEntityCrops(appearances, { forRegeneration: true });

    if (crops.length < 1) {
      return { success: false, error: `Not enough valid crops for ${charName}` };
    }

    // Step 3: Group crops by clothing category
    const cropsByClothing = new Map();
    for (const crop of crops) {
      const clothing = crop.clothing || 'standard';
      if (!cropsByClothing.has(clothing)) {
        cropsByClothing.set(clothing, []);
      }
      cropsByClothing.get(clothing).push(crop);
    }

    log.info(`🔧 [ENTITY-REPAIR] Grouped into ${cropsByClothing.size} clothing categories: ${[...cropsByClothing.keys()].join(', ')}`);

    // Step 4: Load repair prompt template
    const promptTemplate = PROMPT_TEMPLATES.entityConsistencyRepair;
    if (!promptTemplate) {
      log.error('❌ [ENTITY-REPAIR] Missing prompt template: entity-consistency-repair.txt');
      return { success: false, error: 'Missing repair prompt template' };
    }

    // Step 5: Process each clothing group separately
    const allUpdatedImages = [];
    const allCellComparisons = [];
    const gridsByClothing = [];
    let totalUsage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

    const { applyVerifiedRepairs } = require('./repairVerification');

    for (const [clothingCategory, clothingCrops] of cropsByClothing) {
      if (clothingCrops.length < 1) continue;

      // Get appropriate styled avatar as reference for this clothing category
      const referencePhoto = getStyledAvatarForClothing(character, artStyle, clothingCategory);
      log.info(`🔧 [ENTITY-REPAIR] Processing "${clothingCategory}" (${clothingCrops.length} crops) with ${referencePhoto ? 'styled' : 'no'} reference`);

      // Create grid for this clothing group
      const gridResult = await createEntityGrid(clothingCrops, `${charName} (${clothingCategory})`, referencePhoto);

      // Build cell info for prompt
      const cellLetters = clothingCrops.map((_, i) => String.fromCharCode(65 + i));
      const lastLetter = cellLetters[cellLetters.length - 1];

      const cellInfo = clothingCrops.map((crop, i) => ({
        cell: cellLetters[i],
        page: crop.pageNumber,
        clothing: clothingCategory,
        cropType: crop.cropType
      }));

      // Since all cells in this group have the same clothing, we match both appearance and clothing
      const clothingInstructions = `All cells show the character in "${clothingCategory}" clothing. Match both physical appearance and clothing style.`;

      const prompt = promptTemplate
        .replace(/\{ENTITY_TYPE\}/g, 'character')
        .replace(/\{ENTITY_NAME\}/g, charName)
        .replace(/\{LAST_LETTER\}/g, lastLetter)
        .replace(/\{CELL_INFO\}/g, JSON.stringify(cellInfo, null, 2))
        .replace(/\{CLOTHING_INSTRUCTIONS\}/g, clothingInstructions);

      // Send to Gemini for repair
      log.info(`🔧 [ENTITY-REPAIR] Sending ${clothingCategory} grid to Gemini for repair (${clothingCrops.length} cells)`);

      const model = genAI.getGenerativeModel({
        model: REPAIR_MODEL,
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          temperature: 0.5
        }
      });

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: gridResult.buffer.toString('base64')
          }
        }
      ]);

      const response = result.response;
      const parts = response.candidates?.[0]?.content?.parts || [];

      let repairedGridBuffer = null;
      let textResponse = '';

      for (const part of parts) {
        if (part.inlineData?.data) {
          repairedGridBuffer = Buffer.from(part.inlineData.data, 'base64');
        } else if (part.text) {
          textResponse = part.text;
        }
      }

      if (!repairedGridBuffer) {
        log.warn(`⚠️  [ENTITY-REPAIR] Gemini returned text instead of image for ${clothingCategory}: ${textResponse.substring(0, 100)}`);
        continue;  // Skip this clothing group but continue with others
      }

      // Track usage
      if (response.usageMetadata) {
        totalUsage.promptTokenCount += response.usageMetadata.promptTokenCount || 0;
        totalUsage.candidatesTokenCount += response.usageMetadata.candidatesTokenCount || 0;
        totalUsage.totalTokenCount += response.usageMetadata.totalTokenCount || 0;
      }

      // Extract repaired regions from grid
      const repairedMeta = await sharp(repairedGridBuffer).metadata();
      const originalMeta = gridResult.manifest.dimensions;

      const scaleX = repairedMeta.width / originalMeta.width;
      const scaleY = repairedMeta.height / originalMeta.height;

      const repairedCells = [];

      for (let i = 0; i < clothingCrops.length; i++) {
        const crop = clothingCrops[i];
        const letter = cellLetters[i];
        const cellPos = gridResult.cellMap[letter];

        if (!cellPos) {
          log.warn(`⚠️  [ENTITY-REPAIR] No cell position found for ${letter}`);
          continue;
        }

        const scaledX = Math.round(cellPos.x * scaleX);
        const scaledY = Math.round(cellPos.y * scaleY);
        const scaledWidth = Math.round(cellPos.width * scaleX);
        const scaledHeight = Math.round(cellPos.height * scaleY);

        const left = Math.max(0, Math.min(scaledX, repairedMeta.width - 1));
        const top = Math.max(0, Math.min(scaledY, repairedMeta.height - 1));
        const width = Math.min(scaledWidth, repairedMeta.width - left);
        const height = Math.min(scaledHeight, repairedMeta.height - top);

        try {
          // Extract cell from repaired grid
          let cellBuffer = await sharp(repairedGridBuffer)
            .extract({ left, top, width, height })
            .toBuffer();

          // Resize to original crop dimensions (grid cells are square, originals may not be)
          if (crop.originalWidth && crop.originalHeight) {
            const cellMeta = await sharp(cellBuffer).metadata();
            if (cellMeta.width !== crop.originalWidth || cellMeta.height !== crop.originalHeight) {
              log.debug(`🔧 [ENTITY-REPAIR] Resizing cell ${letter}: ${cellMeta.width}x${cellMeta.height} → ${crop.originalWidth}x${crop.originalHeight}`);
              cellBuffer = await sharp(cellBuffer)
                .resize(crop.originalWidth, crop.originalHeight, { fit: 'fill' })
                .toBuffer();
            }
          }

          repairedCells.push({
            letter,
            pageNumber: crop.pageNumber,
            buffer: cellBuffer,
            paddedBox: crop.paddedBox,
            originalImageData: crop.originalImageData,
            originalWidth: crop.originalWidth,
            originalHeight: crop.originalHeight
          });
        } catch (err) {
          log.error(`❌ [ENTITY-REPAIR] Failed to extract cell ${letter}: ${err.message}`);
        }
      }

      // Composite repaired cells back onto original pages
      for (const cell of repairedCells) {
        if (!cell.originalImageData || !cell.paddedBox) {
          log.warn(`⚠️  [ENTITY-REPAIR] Missing data for page ${cell.pageNumber}`);
          continue;
        }

        try {
          const repair = {
            accepted: true,
            buffer: cell.buffer,
            issue: {
              extraction: {
                paddedBox: cell.paddedBox
              }
            }
          };

          const repairedImageBuffer = await applyVerifiedRepairs(cell.originalImageData, [repair]);
          const repairedImageData = `data:image/jpeg;base64,${repairedImageBuffer.toString('base64')}`;

          allUpdatedImages.push({
            pageNumber: cell.pageNumber,
            imageData: repairedImageData,
            letter: cell.letter,
            clothingCategory
          });

          log.info(`✅ [ENTITY-REPAIR] Page ${cell.pageNumber} (${clothingCategory}) repaired`);
        } catch (err) {
          log.error(`❌ [ENTITY-REPAIR] Failed to composite page ${cell.pageNumber}: ${err.message}`);
        }
      }

      // Generate per-cell comparisons for this clothing group
      const groupCellComparisons = [];
      for (let i = 0; i < clothingCrops.length; i++) {
        const crop = clothingCrops[i];
        const repairedCell = repairedCells.find(c => c.letter === cellLetters[i]);
        if (!repairedCell) continue;

        try {
          const beforeBuffer = crop.buffer;
          const afterBuffer = repairedCell.buffer;

          const beforeMeta = await sharp(beforeBuffer).metadata();
          const afterMeta = await sharp(afterBuffer).metadata();

          // Resize after to match before dimensions for consistent display
          let afterResized = afterBuffer;
          if (beforeMeta.width !== afterMeta.width || beforeMeta.height !== afterMeta.height) {
            afterResized = await sharp(afterBuffer)
              .resize(beforeMeta.width, beforeMeta.height, { fit: 'fill' })
              .jpeg({ quality: 90 })
              .toBuffer();
          } else {
            // Ensure JPEG format even if same size
            afterResized = await sharp(afterBuffer).jpeg({ quality: 90 }).toBuffer();
          }

          const cellDiffBuffer = await sharp(beforeBuffer)
            .composite([{ input: afterResized, blend: 'difference' }])
            .modulate({ brightness: 3 })
            .jpeg({ quality: 90 })
            .toBuffer();

          const comparison = {
            letter: cellLetters[i],
            pageNumber: crop.pageNumber,
            clothingCategory,
            before: `data:image/jpeg;base64,${beforeBuffer.toString('base64')}`,
            after: `data:image/jpeg;base64,${afterResized.toString('base64')}`,  // Use resized to match before
            diff: `data:image/jpeg;base64,${cellDiffBuffer.toString('base64')}`
          };

          groupCellComparisons.push(comparison);
          allCellComparisons.push(comparison);
        } catch (cellErr) {
          log.warn(`⚠️ [ENTITY-REPAIR] Failed to generate cell comparison for ${cellLetters[i]}: ${cellErr.message}`);
        }
      }

      // Generate grid diff
      let gridDiff = null;
      try {
        const beforeMeta = await sharp(gridResult.buffer).metadata();
        const afterMeta = await sharp(repairedGridBuffer).metadata();

        let afterResized = repairedGridBuffer;
        if (beforeMeta.width !== afterMeta.width || beforeMeta.height !== afterMeta.height) {
          afterResized = await sharp(repairedGridBuffer)
            .resize(beforeMeta.width, beforeMeta.height, { fit: 'fill' })
            .toBuffer();
        }

        const diffBuffer = await sharp(gridResult.buffer)
          .composite([{ input: afterResized, blend: 'difference' }])
          .modulate({ brightness: 3 })
          .jpeg({ quality: 90 })
          .toBuffer();

        gridDiff = `data:image/jpeg;base64,${diffBuffer.toString('base64')}`;
      } catch (diffErr) {
        log.warn(`⚠️ [ENTITY-REPAIR] Failed to generate diff for ${clothingCategory}: ${diffErr.message}`);
      }

      // Store this clothing group's results
      gridsByClothing.push({
        clothingCategory,
        cropCount: clothingCrops.length,
        gridBefore: `data:image/jpeg;base64,${gridResult.buffer.toString('base64')}`,
        gridAfter: `data:image/jpeg;base64,${repairedGridBuffer.toString('base64')}`,
        gridDiff,
        referenceUsed: referencePhoto ? 'styled' : 'original',
        cellComparisons: groupCellComparisons
      });
    }

    log.info(`🔧 [ENTITY-REPAIR] Generated ${allCellComparisons.length} total cell comparisons across ${gridsByClothing.length} clothing groups`);

    // Build combined result
    // For backward compatibility, use the first grid's before/after as the main grid
    const firstGrid = gridsByClothing[0] || {};

    const repairResult = {
      success: true,
      entityName: charName,
      entityType: 'character',
      originalScore: charReport.score,
      cellsRepaired: allUpdatedImages.length,
      updatedImages: allUpdatedImages,
      // Backward compatible fields (from first/only clothing group)
      gridBeforeRepair: firstGrid.gridBefore || null,
      gridAfterRepair: firstGrid.gridAfter || null,
      gridDiff: firstGrid.gridDiff || null,
      cellComparisons: allCellComparisons,
      // NEW: Per-clothing-group results
      gridsByClothing,
      clothingGroupCount: gridsByClothing.length,
      usage: totalUsage
    };

    log.info(`✅ [ENTITY-REPAIR] Repair complete for ${charName}: ${allUpdatedImages.length} pages updated across ${gridsByClothing.length} clothing groups`);

    return repairResult;

  } catch (err) {
    log.error(`❌ [ENTITY-REPAIR] Error repairing ${charName}: ${err.message}`);
    return { success: false, error: err.message };
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

// Gemini's minimum recommended size for good repair results
const GEMINI_MIN_SIZE = 512;

// Gemini-supported aspect ratios for image generation
const GEMINI_ASPECT_RATIOS = [
  { ratio: '1:1', width: 1024, height: 1024 },
  { ratio: '3:4', width: 896, height: 1120 },
  { ratio: '4:3', width: 1120, height: 896 },
  { ratio: '9:16', width: 768, height: 1360 },
  { ratio: '16:9', width: 1360, height: 768 }
];

/**
 * Pad an image to a Gemini-supported aspect ratio
 * @param {Buffer} imageBuffer - Image buffer
 * @returns {Promise<{buffer: Buffer, paddingInfo: object}>}
 */
async function padToGeminiRatio(imageBuffer) {
  const meta = await sharp(imageBuffer).metadata();
  const currentRatio = meta.width / meta.height;

  // Find the closest Gemini aspect ratio
  let bestRatio = GEMINI_ASPECT_RATIOS[0];
  let bestDiff = Infinity;

  for (const ar of GEMINI_ASPECT_RATIOS) {
    const targetRatio = ar.width / ar.height;
    const diff = Math.abs(currentRatio - targetRatio);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestRatio = ar;
    }
  }

  const targetRatio = bestRatio.width / bestRatio.height;

  // Calculate new dimensions to fit the target ratio
  let newWidth, newHeight;
  if (currentRatio > targetRatio) {
    // Image is wider, add padding on top/bottom
    newWidth = meta.width;
    newHeight = Math.round(meta.width / targetRatio);
  } else {
    // Image is taller, add padding on left/right
    newHeight = meta.height;
    newWidth = Math.round(meta.height * targetRatio);
  }

  // Calculate padding
  const padX = Math.max(0, newWidth - meta.width);
  const padY = Math.max(0, newHeight - meta.height);
  const padLeft = Math.floor(padX / 2);
  const padRight = padX - padLeft;
  const padTop = Math.floor(padY / 2);
  const padBottom = padY - padTop;

  // Apply padding with edge extension (more natural than solid color)
  const paddedBuffer = await sharp(imageBuffer)
    .extend({
      top: padTop,
      bottom: padBottom,
      left: padLeft,
      right: padRight,
      extendWith: 'mirror'  // Mirror edges for more natural blending
    })
    .toBuffer();

  return {
    buffer: paddedBuffer,
    paddingInfo: {
      padTop,
      padBottom,
      padLeft,
      padRight,
      originalWidth: meta.width,
      originalHeight: meta.height,
      paddedWidth: newWidth,
      paddedHeight: newHeight,
      aspectRatio: bestRatio.ratio
    }
  };
}

/**
 * Remove padding from a repaired image
 * @param {Buffer} imageBuffer - Padded repaired image
 * @param {object} paddingInfo - Padding info from padToGeminiRatio
 * @returns {Promise<Buffer>}
 */
async function removePadding(imageBuffer, paddingInfo) {
  const meta = await sharp(imageBuffer).metadata();

  // Calculate scale factors (Gemini might have changed the size)
  const scaleX = meta.width / paddingInfo.paddedWidth;
  const scaleY = meta.height / paddingInfo.paddedHeight;

  // Scale padding values
  const left = Math.round(paddingInfo.padLeft * scaleX);
  const top = Math.round(paddingInfo.padTop * scaleY);
  const extractWidth = Math.round(paddingInfo.originalWidth * scaleX);
  const extractHeight = Math.round(paddingInfo.originalHeight * scaleY);

  // Extract the original region
  return sharp(imageBuffer)
    .extract({
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.min(extractWidth, meta.width - left),
      height: Math.min(extractHeight, meta.height - top)
    })
    .toBuffer();
}

/**
 * Prepare an image for Gemini repair (dynamic upscale + pad)
 * @param {Buffer} cropBuffer - Original crop buffer
 * @returns {Promise<object>} Prepared image data
 */
async function prepareForGeminiRepair(cropBuffer) {
  const meta = await sharp(cropBuffer).metadata();
  const minDim = Math.min(meta.width, meta.height);

  let buffer = cropBuffer;
  let upscaleFactor = 1;

  // Only upscale if image is too small
  if (minDim < GEMINI_MIN_SIZE) {
    upscaleFactor = Math.ceil(GEMINI_MIN_SIZE / minDim);
    buffer = await sharp(cropBuffer)
      .resize(meta.width * upscaleFactor, meta.height * upscaleFactor, {
        kernel: sharp.kernel.lanczos3
      })
      .toBuffer();
    log.debug(`[SINGLE-PAGE-REPAIR] Upscaled ${meta.width}x${meta.height} by ${upscaleFactor}x`);
  }

  // Pad to Gemini-supported aspect ratio
  const { buffer: padded, paddingInfo } = await padToGeminiRatio(buffer);

  return {
    buffer: padded,
    paddingInfo,
    upscaleFactor,
    originalWidth: meta.width,
    originalHeight: meta.height
  };
}

// Verification model for comparing repairs
const VERIFICATION_MODEL = 'gemini-2.5-flash';

// Maximum allowed background change (mean pixel diff 0-255)
// JPEG compression can cause ~2-5 difference, so allow some tolerance
const MAX_BACKGROUND_DIFF = 8;

/**
 * Extract border regions from an image (everything except center)
 * Used to verify background wasn't changed during repair
 *
 * @param {Buffer} imageBuffer - Image buffer
 * @param {number} borderPercent - How much of each edge to extract (default 15%)
 * @returns {Promise<Buffer>} Composite of border regions
 */
async function extractBorderRegions(imageBuffer, borderPercent = 0.15) {
  const meta = await sharp(imageBuffer).metadata();
  const borderX = Math.round(meta.width * borderPercent);
  const borderY = Math.round(meta.height * borderPercent);

  // Extract 4 border strips and combine them
  const [top, bottom, left, right] = await Promise.all([
    // Top strip (full width)
    sharp(imageBuffer).extract({ left: 0, top: 0, width: meta.width, height: borderY }).toBuffer(),
    // Bottom strip (full width)
    sharp(imageBuffer).extract({ left: 0, top: meta.height - borderY, width: meta.width, height: borderY }).toBuffer(),
    // Left strip (excluding corners already in top/bottom)
    sharp(imageBuffer).extract({ left: 0, top: borderY, width: borderX, height: meta.height - borderY * 2 }).toBuffer(),
    // Right strip (excluding corners already in top/bottom)
    sharp(imageBuffer).extract({ left: meta.width - borderX, top: borderY, width: borderX, height: meta.height - borderY * 2 }).toBuffer()
  ]);

  // Stack them vertically for comparison
  const topMeta = await sharp(top).metadata();
  const leftMeta = await sharp(left).metadata();

  // Resize strips to same width for stacking
  const targetWidth = Math.max(topMeta.width, leftMeta.width);

  const resizedStrips = await Promise.all([
    sharp(top).resize(targetWidth, null).toBuffer(),
    sharp(bottom).resize(targetWidth, null).toBuffer(),
    sharp(left).resize(targetWidth, null).toBuffer(),
    sharp(right).resize(targetWidth, null).toBuffer()
  ]);

  // Stack vertically
  const stripMetas = await Promise.all(resizedStrips.map(s => sharp(s).metadata()));
  const totalHeight = stripMetas.reduce((sum, m) => sum + m.height, 0);

  return sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .composite([
      { input: resizedStrips[0], top: 0, left: 0 },
      { input: resizedStrips[1], top: stripMetas[0].height, left: 0 },
      { input: resizedStrips[2], top: stripMetas[0].height + stripMetas[1].height, left: 0 },
      { input: resizedStrips[3], top: stripMetas[0].height + stripMetas[1].height + stripMetas[2].height, left: 0 }
    ])
    .jpeg()
    .toBuffer();
}

/**
 * Compute mean absolute difference between two images
 * @param {Buffer} img1 - First image buffer
 * @param {Buffer} img2 - Second image buffer
 * @returns {Promise<number>} Mean absolute difference (0-255)
 */
async function computeImageDifference(img1, img2) {
  const meta1 = await sharp(img1).metadata();
  const meta2 = await sharp(img2).metadata();

  // Resize to same dimensions if needed
  let buf1 = img1;
  let buf2 = img2;

  if (meta1.width !== meta2.width || meta1.height !== meta2.height) {
    const targetWidth = Math.min(meta1.width, meta2.width);
    const targetHeight = Math.min(meta1.height, meta2.height);
    buf1 = await sharp(img1).resize(targetWidth, targetHeight, { fit: 'fill' }).toBuffer();
    buf2 = await sharp(img2).resize(targetWidth, targetHeight, { fit: 'fill' }).toBuffer();
  }

  // Get raw pixel data
  const raw1 = await sharp(buf1).raw().toBuffer();
  const raw2 = await sharp(buf2).raw().toBuffer();

  // Compute mean absolute difference
  let totalDiff = 0;
  const pixelCount = Math.min(raw1.length, raw2.length);
  for (let i = 0; i < pixelCount; i++) {
    totalDiff += Math.abs(raw1[i] - raw2[i]);
  }

  return totalDiff / pixelCount;
}

/**
 * Verify if the repair improved the character consistency
 * Checks two things:
 * 1. Background/borders should NOT change (old vs new border regions)
 * 2. Character should better match reference (Gemini visual comparison)
 *
 * @param {Buffer} referenceBuffer - Styled avatar (source of truth)
 * @param {Buffer} oldBuffer - Original crop before repair
 * @param {Buffer} newBuffer - Repaired crop
 * @param {string} entityName - Character name
 * @returns {Promise<{improved: boolean, confidence: string, explanation: string, metrics: object}>}
 */
async function verifyRepairImprovement(referenceBuffer, oldBuffer, newBuffer, entityName) {
  try {
    // STEP 1: Verify background/borders didn't change
    // Extract border regions from old and new crops
    const oldBorders = await extractBorderRegions(oldBuffer);
    const newBorders = await extractBorderRegions(newBuffer);

    const borderDiff = await computeImageDifference(oldBorders, newBorders);
    log.info(`🔍 [REPAIR-VERIFY] Border diff (old vs new): ${borderDiff.toFixed(2)} (max allowed: ${MAX_BACKGROUND_DIFF})`);

    if (borderDiff > MAX_BACKGROUND_DIFF) {
      log.warn(`⚠️  [REPAIR-VERIFY] Background changed too much! Diff: ${borderDiff.toFixed(2)}`);
      return {
        improved: false,
        confidence: 'high',
        explanation: `Background/borders changed too much (diff: ${borderDiff.toFixed(2)}, max: ${MAX_BACKGROUND_DIFF}). The repair should only modify the character.`,
        metrics: { borderDiff, maxAllowed: MAX_BACKGROUND_DIFF, reason: 'background_changed' }
      };
    }

    // STEP 2: Use Gemini to verify the character improvement
    const model = genAI.getGenerativeModel({
      model: VERIFICATION_MODEL,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048
      }
    });

    const prompt = `You are evaluating a character repair in a children's picture book.

**IMAGE 1 - REFERENCE:** The correct appearance of "${entityName}" (styled avatar - source of truth)
**IMAGE 2 - BEFORE:** The original illustration crop (before repair)
**IMAGE 3 - AFTER:** The repaired illustration crop (after repair)

Compare the character's appearance in BEFORE and AFTER against the REFERENCE.

Evaluate:
1. FACE MATCH - Does the face better match the reference in AFTER vs BEFORE?
2. HAIR MATCH - Does the hair color/style better match?
3. SKIN TONE MATCH - Is skin tone more consistent with reference?
4. OVERALL CONSISTENCY - Which is closer to the reference overall?

CRITICAL: Also check if the AFTER image has any artifacts, blur, or degradation compared to BEFORE.

Respond in JSON format:
{
  "improved": true/false,
  "confidence": "high" | "medium" | "low",
  "face_better": true/false,
  "hair_better": true/false,
  "skin_better": true/false,
  "has_artifacts": true/false,
  "explanation": "Brief explanation of your assessment"
}`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType: 'image/png', data: referenceBuffer.toString('base64') } },
      { inlineData: { mimeType: 'image/png', data: oldBuffer.toString('base64') } },
      { inlineData: { mimeType: 'image/png', data: newBuffer.toString('base64') } }
    ]);

    const text = result.response.text();

    // Parse JSON response
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseErr) {
      log.warn(`⚠️  [REPAIR-VERIFY] Failed to parse response: ${text.substring(0, 200)}`);
      // Background check passed, so accept with low confidence
      return {
        improved: true,
        confidence: 'low',
        explanation: `Background preserved (diff: ${borderDiff.toFixed(2)}). Gemini response parse failed.`,
        metrics: { borderDiff, parseError: true }
      };
    }

    // If there are artifacts, don't accept the repair
    if (parsed.has_artifacts) {
      log.warn(`⚠️  [REPAIR-VERIFY] Repair has artifacts, rejecting`);
      return {
        improved: false,
        confidence: parsed.confidence || 'medium',
        explanation: `Repair rejected due to artifacts: ${parsed.explanation}`,
        metrics: { borderDiff, geminiResult: parsed }
      };
    }

    return {
      improved: parsed.improved,
      confidence: parsed.confidence || 'medium',
      explanation: parsed.explanation || 'No explanation provided',
      metrics: { borderDiff, geminiResult: parsed },
      usage: result.response.usageMetadata
    };

  } catch (err) {
    log.error(`❌ [REPAIR-VERIFY] Verification failed: ${err.message}`);
    // On error, accept the repair but flag low confidence
    return {
      improved: true,
      confidence: 'low',
      explanation: `Verification error: ${err.message}`,
      metrics: { error: err.message }
    };
  }
}

/**
 * Build a human-readable description of character's physical traits
 *
 * @param {object} character - Character object with physical traits
 * @returns {string} Physical traits description
 */
function buildPhysicalTraitsDescription(character) {
  const p = character.physical || {};
  const parts = [];

  // Age and gender
  if (character.age) parts.push(`${character.age} year old`);
  if (character.gender) parts.push(character.gender);

  // Hair
  const hairParts = [];
  if (p.hairColor) hairParts.push(p.hairColor);
  if (p.hairLength) hairParts.push(p.hairLength);
  if (p.hairStyle) hairParts.push(p.hairStyle);
  if (hairParts.length > 0) {
    parts.push(`${hairParts.join(' ')} hair`);
  } else if (p.hair) {
    parts.push(`${p.hair} hair`);
  }

  // Eyes
  if (p.eyeColor) parts.push(`${p.eyeColor} eyes`);

  // Skin
  if (p.skinTone) {
    const skinDesc = p.skinUndertone ? `${p.skinTone} skin with ${p.skinUndertone} undertone` : `${p.skinTone} skin`;
    parts.push(skinDesc);
  }

  // Build
  if (p.build) parts.push(`${p.build} build`);

  // Face shape
  if (p.face) parts.push(`${p.face} face`);

  // Facial hair (for males)
  if (p.facialHair && p.facialHair !== 'none') parts.push(p.facialHair);

  // Other distinctive features
  if (p.other) parts.push(p.other);

  return parts.length > 0 ? parts.join(', ') : 'See reference image for physical traits';
}

/**
 * Build a clothing description for the character in this scene
 *
 * @param {object} character - Character object
 * @param {string} clothingCategory - Clothing category (standard, winter, costumed:wizard, etc.)
 * @param {string} artStyle - Art style being used
 * @returns {string} Clothing description
 */
function buildClothingDescription(character, clothingCategory, artStyle) {
  const avatars = character.avatars;

  // Handle costumed categories (e.g., "costumed:wizard", "costumed:pirate")
  if (clothingCategory.startsWith('costumed:')) {
    const costumeType = clothingCategory.replace('costumed:', '');

    // Check avatars.costumed[costumeType].clothing (where costume clothing is stored)
    if (avatars?.costumed?.[costumeType]?.clothing) {
      return avatars.costumed[costumeType].clothing;
    }

    // Fallback: return costume type as description
    return `${costumeType} costume as shown in reference`;
  }

  // For standard categories, try to get extracted clothing from styled avatar
  if (avatars?.clothing?.[clothingCategory]) {
    return avatars.clothing[clothingCategory];
  }

  // Fall back to structured clothing from character definition
  const clothing = character.clothing;
  if (clothing?.structured) {
    const s = clothing.structured;
    if (s.fullBody) {
      return s.fullBody;
    }
    const parts = [];
    if (s.upperBody) parts.push(s.upperBody);
    if (s.lowerBody) parts.push(s.lowerBody);
    if (s.shoes) parts.push(s.shoes);
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  // Fall back to legacy current clothing
  if (clothing?.current) {
    return clothing.current;
  }

  // Default based on category
  const categoryDefaults = {
    winter: 'Warm winter clothing as shown in reference',
    summer: 'Light summer clothing as shown in reference',
    formal: 'Formal attire as shown in reference',
    standard: 'Casual everyday clothing as shown in reference'
  };

  return categoryDefaults[clothingCategory] || 'Clothing as shown in reference image';
}

/**
 * Repair a single page's entity appearance
 *
 * Simplified approach: Just send styled avatar + target page
 * The avatar already shows the correct appearance in the right style/clothing.
 *
 * @param {object} storyData - Story data with sceneImages, sceneDescriptions, artStyle
 * @param {object} character - Character object with name, photoUrl, avatars
 * @param {number} pageNumber - Page number to repair
 * @param {object} options - Repair options
 * @returns {Promise<object>} Repair result
 */
async function repairSinglePage(storyData, character, pageNumber, options = {}) {
  const charName = character.name;
  const artStyle = storyData.artStyle || 'pixar';

  log.info(`🔧 [SINGLE-PAGE-REPAIR] Starting repair for ${charName} on page ${pageNumber}`);

  try {
    // Collect all appearances for this character
    const sceneImages = storyData.sceneImages || [];
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const entityAppearances = collectEntityAppearances(sceneImages, [character], sceneDescriptions);
    const appearances = entityAppearances.get(charName);

    if (!appearances || appearances.length < 1) {
      return { success: false, error: `No appearances found for ${charName}` };
    }

    // Find the specific page's appearance
    const targetAppearance = appearances.find(a => a.pageNumber === pageNumber);
    if (!targetAppearance) {
      return { success: false, error: `${charName} not found on page ${pageNumber}` };
    }

    // Extract crop for the target page only
    const [targetCrop] = await extractEntityCrops([targetAppearance], { forRegeneration: true });

    if (!targetCrop) {
      return { success: false, error: `Failed to extract crop for page ${pageNumber}` };
    }

    // Determine clothing category for target page
    const clothingCategory = targetCrop.clothing || 'standard';
    log.info(`🔧 [SINGLE-PAGE-REPAIR] Target page ${pageNumber} has clothing: ${clothingCategory}`);

    // Get styled avatar for this clothing category
    const styledAvatar = getStyledAvatarForClothing(character, artStyle, clothingCategory);

    if (!styledAvatar) {
      return { success: false, error: `No styled avatar found for ${charName} with ${clothingCategory} clothing` };
    }

    log.info(`🔧 [SINGLE-PAGE-REPAIR] Using styled avatar for ${clothingCategory}`);

    // Prepare avatar image
    let avatarBuffer;
    if (styledAvatar.startsWith('data:')) {
      const base64Data = styledAvatar.replace(/^data:image\/\w+;base64,/, '');
      avatarBuffer = Buffer.from(base64Data, 'base64');
    } else {
      avatarBuffer = Buffer.from(styledAvatar, 'base64');
    }

    // Prepare the target image for repair (dynamic upscale + pad)
    const preparedTarget = await prepareForGeminiRepair(targetCrop.buffer);

    // Build physical traits description
    const physicalTraits = buildPhysicalTraitsDescription(character);
    const hairColor = character.physical?.hairColor || 'as shown in reference';

    // Build clothing description for this scene
    const clothingDescription = buildClothingDescription(character, clothingCategory, artStyle);

    log.info(`🔧 [SINGLE-PAGE-REPAIR] Physical traits: ${physicalTraits.substring(0, 100)}...`);
    log.info(`🔧 [SINGLE-PAGE-REPAIR] Clothing: ${clothingDescription}`);

    // Load the single-page repair prompt
    const promptTemplate = PROMPT_TEMPLATES.entitySinglePageRepair;
    if (!promptTemplate) {
      log.warn('⚠️  [SINGLE-PAGE-REPAIR] Using fallback prompt (entity-single-page-repair.txt not found)');
    }

    const prompt = promptTemplate
      ? promptTemplate
          .replace(/\{ENTITY_NAME\}/g, charName)
          .replace(/\{PAGE_NUMBER\}/g, pageNumber.toString())
          .replace(/\{CLOTHING_CATEGORY\}/g, clothingCategory)
          .replace(/\{PHYSICAL_TRAITS\}/g, physicalTraits)
          .replace(/\{HAIR_COLOR\}/g, hairColor)
          .replace(/\{CLOTHING_DESCRIPTION\}/g, clothingDescription)
      : buildFallbackSinglePagePrompt(charName, pageNumber, clothingCategory, physicalTraits, clothingDescription);

    // Send to Gemini: avatar + target (simplified - just 2 images)
    log.info(`🔧 [SINGLE-PAGE-REPAIR] Sending to Gemini: styled avatar + page ${pageNumber} target`);

    const model = genAI.getGenerativeModel({
      model: REPAIR_MODEL,
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        temperature: 0.5
      }
    });

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/png',
          data: avatarBuffer.toString('base64')
        }
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: preparedTarget.buffer.toString('base64')
        }
      }
    ]);

    const response = result.response;
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
      log.warn(`⚠️  [SINGLE-PAGE-REPAIR] Gemini returned text instead of image: ${textResponse.substring(0, 200)}`);
      return { success: false, error: 'Gemini did not return an image', textResponse };
    }

    // Post-process: remove padding
    let processedBuffer = await removePadding(repairedBuffer, preparedTarget.paddingInfo);

    // Downscale to original dimensions if we upscaled
    if (preparedTarget.upscaleFactor > 1) {
      processedBuffer = await sharp(processedBuffer)
        .resize(preparedTarget.originalWidth, preparedTarget.originalHeight, {
          kernel: sharp.kernel.lanczos3
        })
        .toBuffer();
      log.debug(`[SINGLE-PAGE-REPAIR] Downscaled back to ${preparedTarget.originalWidth}x${preparedTarget.originalHeight}`);
    }

    // Verify the repair actually improved things
    log.info(`🔍 [SINGLE-PAGE-REPAIR] Verifying repair improvement...`);
    const verification = await verifyRepairImprovement(
      avatarBuffer,
      targetCrop.buffer,
      processedBuffer,
      charName
    );

    log.info(`🔍 [SINGLE-PAGE-REPAIR] Verification: improved=${verification.improved}, confidence=${verification.confidence}`);
    log.info(`🔍 [SINGLE-PAGE-REPAIR] Explanation: ${verification.explanation}`);

    if (!verification.improved) {
      log.warn(`⚠️  [SINGLE-PAGE-REPAIR] Repair did not improve consistency, rejecting`);
      return {
        success: false,
        rejected: true,
        entityName: charName,
        pageNumber,
        reason: verification.explanation,
        verification,
        comparison: {
          before: `data:image/jpeg;base64,${targetCrop.buffer.toString('base64')}`,
          after: `data:image/png;base64,${processedBuffer.toString('base64')}`,
          reference: `data:image/png;base64,${avatarBuffer.toString('base64')}`
        }
      };
    }

    // Composite repaired cell back onto original page
    const { applyVerifiedRepairs } = require('./repairVerification');
    const repair = {
      accepted: true,
      buffer: processedBuffer,
      issue: {
        extraction: {
          paddedBox: targetCrop.paddedBox
        }
      }
    };

    const repairedPageBuffer = await applyVerifiedRepairs(targetCrop.originalImageData, [repair]);
    const repairedPageData = `data:image/jpeg;base64,${repairedPageBuffer.toString('base64')}`;

    // Generate comparison images
    const beforeBuffer = targetCrop.buffer;
    const afterBuffer = processedBuffer;

    // Ensure same dimensions for comparison
    const beforeMeta = await sharp(beforeBuffer).metadata();
    let afterResized = await sharp(afterBuffer)
      .resize(beforeMeta.width, beforeMeta.height, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const diffBuffer = await sharp(beforeBuffer)
      .composite([{ input: afterResized, blend: 'difference' }])
      .modulate({ brightness: 3 })
      .jpeg({ quality: 90 })
      .toBuffer();

    log.info(`✅ [SINGLE-PAGE-REPAIR] Page ${pageNumber} repaired for ${charName} (confidence: ${verification.confidence})`);

    // Combine usage from repair + verification
    const totalUsage = {
      promptTokenCount: (response.usageMetadata?.promptTokenCount || 0) + (verification.usage?.promptTokenCount || 0),
      candidatesTokenCount: (response.usageMetadata?.candidatesTokenCount || 0) + (verification.usage?.candidatesTokenCount || 0),
      totalTokenCount: (response.usageMetadata?.totalTokenCount || 0) + (verification.usage?.totalTokenCount || 0)
    };

    return {
      success: true,
      entityName: charName,
      entityType: 'character',
      pageNumber,
      clothingCategory,
      updatedImages: [{
        pageNumber,
        imageData: repairedPageData,
        clothingCategory
      }],
      cellsRepaired: 1,
      comparison: {
        before: `data:image/jpeg;base64,${beforeBuffer.toString('base64')}`,
        after: `data:image/jpeg;base64,${afterResized.toString('base64')}`,
        diff: `data:image/jpeg;base64,${diffBuffer.toString('base64')}`,
        reference: `data:image/png;base64,${avatarBuffer.toString('base64')}`
      },
      verification: {
        improved: verification.improved,
        confidence: verification.confidence,
        explanation: verification.explanation,
        metrics: verification.metrics
      },
      avatarUsed: `data:image/png;base64,${avatarBuffer.toString('base64')}`,
      usage: totalUsage
    };

  } catch (err) {
    log.error(`❌ [SINGLE-PAGE-REPAIR] Error repairing ${charName} page ${pageNumber}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Fallback prompt for single-page repair if template file doesn't exist
 */
function buildFallbackSinglePagePrompt(entityName, pageNumber, clothingCategory, physicalTraits, clothingDescription) {
  return `# Single Page Entity Repair

You are repairing character consistency in a children's picture book illustration.

## Input Images

**IMAGE 1 - CHARACTER REFERENCE:**
Shows the correct appearance of "${entityName}" in the art style of this book.
This is the ONLY source of truth for how the character should look.

**IMAGE 2 - PAGE TO REPAIR:**
The illustration from page ${pageNumber} where "${entityName}" needs to be fixed.

## Character Details

**Physical Traits:**
${physicalTraits || 'See reference image'}

**Clothing for this scene:**
${clothingDescription || 'As shown in reference image'}

## Your Task

Regenerate IMAGE 2 with "${entityName}" corrected to match IMAGE 1.

### MUST MATCH from IMAGE 1 (reference):
- FACE - exact facial features, eye shape, nose, mouth, face shape as shown
- HAIR - exact color, style, length, texture
- SKIN TONE - exact complexion as shown
- CLOTHING - match the outfit shown in IMAGE 1
- BODY PROPORTIONS - size, build, posture style

### PIXEL-PERFECT PRESERVATION (CRITICAL):
Everything EXCEPT "${entityName}" must be IDENTICAL to IMAGE 2:
- BACKGROUND - every single pixel of scenery, sky, ground, walls, furniture
- OTHER CHARACTERS - do not change any other person or creature
- OBJECTS - every item, prop, and detail stays exactly the same
- LIGHTING - same light direction, shadows, highlights
- COLORS - same color palette for everything except the target character
- COMPOSITION - exact same framing, no cropping, no shifting
- ART STYLE - maintain the exact illustration style

Think of it as: surgically replacing ONLY "${entityName}" while the rest of the image is a protected layer that cannot be modified.

## Output

Generate the repaired version of IMAGE 2:
- EXACT same dimensions as IMAGE 2
- EXACT same aspect ratio as IMAGE 2
- Single image (not a grid or collage)
- The ONLY difference should be "${entityName}" now matching IMAGE 1

## Quality Standards

- Sharp, clean edges on the character
- No blur, smearing, or artifacts
- Character blends naturally with preserved background
- Vibrant colors consistent with the art style`;
}

module.exports = {
  // Main functions
  runEntityConsistencyChecks,
  repairEntityConsistency,
  repairSinglePage,

  // Helper functions (exported for testing)
  collectEntityAppearances,
  collectObjectAppearances,
  extractEntityCrops,
  extractCropFromImage,
  createEntityGrid,
  evaluateEntityConsistency,
  getStyledAvatarForClothing,
  saveEntityGrid,
  saveEntityGrids,
  prepareForGeminiRepair,
  padToGeminiRatio,
  removePadding,
  buildPhysicalTraitsDescription,
  buildClothingDescription,
  verifyRepairImprovement,
  extractBorderRegions,
  computeImageDifference,

  // Constants
  FACE_CROP_SIZE,
  BODY_CROP_SIZE,
  MIN_APPEARANCES,
  MAX_GRID_CELLS,
  GEMINI_MIN_SIZE
};
