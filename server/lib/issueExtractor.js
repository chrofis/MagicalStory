/**
 * Issue Extractor Module
 *
 * Extracts, normalizes, and deduplicates image quality issues from multiple
 * evaluation paths (quality eval, incremental consistency, final consistency).
 * Produces standardized issue regions for batch repair processing.
 *
 * Pattern based on: scripts/extract-faces.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Standard region extraction size (matches face extraction)
const TARGET_REGION_SIZE = 256;

// Adaptive padding by issue type (percent of region size)
const PADDING_BY_TYPE = {
  face: 0.6,      // Face needs identity context
  hand: 0.4,      // Hands need arm context
  anatomy: 0.4,   // Limbs need body context
  clothing: 0.3,  // Clothing needs figure context
  object: 0.3,    // Objects need scene context
  environment: 0.2,
  rendering: 0.3,
  consistency: 0.5,  // Consistency issues need more context
  default: 0.3
};

// Severity ordering for deduplication preference
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 };

/**
 * Generate a unique issue ID using UUID
 * @param {number} pageNumber - Page number
 * @param {string} source - Issue source (quality, incremental, final)
 * @returns {string} Unique ID
 */
function generateIssueId(pageNumber, source) {
  return `page${pageNumber}_${source}_${randomUUID().slice(0, 8)}`;
}

/**
 * Validate that a bounding box is normalized (all values 0-1)
 * @param {[number,number,number,number]} bbox - [ymin, xmin, ymax, xmax]
 * @returns {{valid: boolean, reason?: string}}
 */
function validateNormalizedBbox(bbox) {
  if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) {
    return { valid: false, reason: 'bbox must be array of 4 numbers' };
  }
  const [ymin, xmin, ymax, xmax] = bbox;

  // Check all values are numbers
  if (bbox.some(v => typeof v !== 'number' || isNaN(v))) {
    return { valid: false, reason: 'bbox values must be numbers' };
  }

  // Check if values appear to be pixel coordinates (> 1)
  if (ymax > 1 || xmax > 1) {
    return { valid: false, reason: `bbox appears to be pixel coordinates (max values: ymax=${ymax}, xmax=${xmax})` };
  }

  // Check for negative values
  if (ymin < 0 || xmin < 0) {
    return { valid: false, reason: `bbox has negative values (ymin=${ymin}, xmin=${xmin})` };
  }

  // Check for inverted coordinates
  if (ymax <= ymin || xmax <= xmin) {
    return { valid: false, reason: `bbox has inverted coordinates (ymin=${ymin}, ymax=${ymax}, xmin=${xmin}, xmax=${xmax})` };
  }

  return { valid: true };
}

/**
 * Unified issue format used across the repair pipeline
 * @typedef {Object} UnifiedIssue
 * @property {string} id - Unique identifier "page{N}_issue_{M}"
 * @property {'quality'|'incremental'|'final'} source - Which evaluation path found this
 * @property {number} pageNumber - Page number in story
 * @property {Object} region - Bounding box info
 * @property {[number,number,number,number]} region.bbox - [ymin, xmin, ymax, xmax] normalized 0-1
 * @property {Object} [region.pixelBox] - {x, y, width, height} in pixels
 * @property {'face'|'hand'|'anatomy'|'clothing'|'object'|'environment'} type - Issue category
 * @property {'critical'|'major'|'minor'} severity
 * @property {string} description - What's wrong
 * @property {string} fixInstruction - How to fix it
 * @property {string} [affectedCharacter] - Character name if relevant
 * @property {Object} [extraction] - Extraction results
 * @property {string} extraction.thumbnailPath - Path to 256x256 thumbnail
 * @property {[number,number,number,number]} extraction.paddedBox - Padded bbox used
 * @property {'pending'|'in_grid'|'repaired'|'verified'|'failed'} repairStatus
 * @property {Array} repairAttempts - History of repair attempts
 */

/**
 * Normalize issue from quality evaluation result
 * Quality eval produces: fixable_issues[] with face_bbox from identity_sync
 *
 * @param {Object} issue - Issue from quality eval fixable_issues or fixTargets
 * @param {number} pageNumber - Page number
 * @param {{width: number, height: number}} imgDimensions - Image dimensions
 * @returns {UnifiedIssue}
 */
function normalizeQualityIssue(issue, pageNumber, imgDimensions) {
  // fixTargets format: { element, severity, bounds: [ymin,xmin,ymax,xmax], issue, fix_instruction }
  // fixable_issues format: { type, severity, description, fix }

  const bbox = issue.bounds || issue.face_bbox || null;
  const issueType = mapIssueType(issue.element || issue.type || 'rendering');
  const severity = (issue.severity || 'major').toLowerCase();

  // Validate bounding box if present
  let validatedBbox = bbox;
  if (bbox) {
    const validation = validateNormalizedBbox(bbox);
    if (!validation.valid) {
      console.warn(`Invalid bbox in quality issue: ${validation.reason}, skipping bbox`);
      validatedBbox = null;
    }
  }

  return {
    id: generateIssueId(pageNumber, 'quality'),
    source: 'quality',
    pageNumber,
    region: {
      bbox: validatedBbox,
      pixelBox: validatedBbox ? bboxToPixelBox(validatedBbox, imgDimensions) : null
    },
    type: issueType,
    severity,
    description: issue.issue || issue.description || 'Quality issue',
    fixInstruction: issue.fix_instruction || issue.fix || 'Fix the issue',
    affectedCharacter: issue.affectedCharacter || null,
    repairStatus: 'pending',
    repairAttempts: []
  };
}

/**
 * Normalize issue from incremental consistency evaluation
 * Incremental eval produces: issues[] with fixTarget.region
 *
 * @param {Object} issue - Issue from consistencyResult.issues
 * @param {number} pageNumber - Page number
 * @param {{width: number, height: number}} imgDimensions - Image dimensions
 * @param {Object} characterBboxes - Map of character name → {faceBbox, bodyBbox} from quality eval
 * @returns {UnifiedIssue}
 */
function normalizeIncrementalIssue(issue, pageNumber, imgDimensions, characterBboxes = {}) {
  // Format: { type, severity, description, affectedCharacter, comparedToPage, fixTarget: { region, instruction } }

  let bbox = issue.fixTarget?.region || null;
  const issueType = mapIssueType(issue.type || 'consistency');
  const severity = (issue.severity || 'major').toLowerCase();

  // Validate bounding box if present
  let validatedBbox = null;
  if (bbox) {
    const validation = validateNormalizedBbox(bbox);
    if (validation.valid) {
      validatedBbox = bbox;
    } else {
      console.warn(`Invalid bbox in incremental issue: ${validation.reason}, will try character lookup`);
    }
  }

  // If no valid bbox but we have affectedCharacter, look up from quality eval matches
  if (!validatedBbox && issue.affectedCharacter && characterBboxes) {
    const charName = issue.affectedCharacter.toLowerCase();
    const charBbox = characterBboxes[charName];
    if (charBbox) {
      // Use body box for clothing issues, face box for face issues, body box as default
      if (issueType === 'face' && charBbox.faceBbox) {
        validatedBbox = charBbox.faceBbox;
        console.log(`  Using face bbox from quality eval for ${issue.affectedCharacter}`);
      } else if (charBbox.bodyBbox) {
        validatedBbox = charBbox.bodyBbox;
        console.log(`  Using body bbox from quality eval for ${issue.affectedCharacter}`);
      } else if (charBbox.faceBbox) {
        validatedBbox = charBbox.faceBbox;
        console.log(`  Using face bbox (fallback) from quality eval for ${issue.affectedCharacter}`);
      }
    } else {
      console.warn(`  No bbox found for character "${issue.affectedCharacter}" in quality matches`);
    }
  }

  return {
    id: generateIssueId(pageNumber, 'incremental'),
    source: 'incremental',
    pageNumber,
    region: {
      bbox: validatedBbox,
      pixelBox: validatedBbox ? bboxToPixelBox(validatedBbox, imgDimensions) : null
    },
    type: issueType,
    severity,
    description: issue.description || 'Consistency issue',
    fixInstruction: issue.fixTarget?.instruction || `Fix ${issue.type || 'consistency'} issue`,
    affectedCharacter: issue.affectedCharacter || null,
    comparedToPage: issue.comparedToPage,
    repairStatus: 'pending',
    repairAttempts: []
  };
}

/**
 * Normalize issue from final consistency check
 * Final check produces: pagesToFix[] with issues per page
 *
 * @param {Object} pageIssue - Issue from final consistency pagesToFix
 * @param {number} pageNumber - Page number
 * @param {{width: number, height: number}} imgDimensions - Image dimensions
 * @returns {UnifiedIssue}
 */
function normalizeFinalIssue(pageIssue, pageNumber, imgDimensions) {
  // Format: { character, issue, fix, severity, fixTarget }

  const bbox = pageIssue.fixTarget?.region || pageIssue.fixTarget?.bounds || null;
  const issueType = mapIssueType(pageIssue.type || 'consistency');
  const severity = (pageIssue.severity || 'major').toLowerCase();

  // Validate bounding box if present
  let validatedBbox = bbox;
  if (bbox) {
    const validation = validateNormalizedBbox(bbox);
    if (!validation.valid) {
      console.warn(`Invalid bbox in final issue: ${validation.reason}, skipping bbox`);
      validatedBbox = null;
    }
  }

  return {
    id: generateIssueId(pageNumber, 'final'),
    source: 'final',
    pageNumber,
    region: {
      bbox: validatedBbox,
      pixelBox: validatedBbox ? bboxToPixelBox(validatedBbox, imgDimensions) : null
    },
    type: issueType,
    severity,
    description: pageIssue.issue || 'Final consistency issue',
    fixInstruction: pageIssue.fix || pageIssue.fixTarget?.instruction || 'Fix consistency issue',
    affectedCharacter: pageIssue.character || null,
    repairStatus: 'pending',
    repairAttempts: []
  };
}

/**
 * Map various issue type strings to our standard types
 */
function mapIssueType(type) {
  const typeStr = (type || '').toLowerCase();

  if (typeStr.includes('face') || typeStr.includes('identity')) return 'face';
  if (typeStr.includes('hand') || typeStr.includes('finger')) return 'hand';
  if (typeStr.includes('limb') || typeStr.includes('arm') || typeStr.includes('leg') || typeStr.includes('anatomy')) return 'anatomy';
  if (typeStr.includes('cloth') || typeStr.includes('outfit') || typeStr.includes('dress')) return 'clothing';
  if (typeStr.includes('object') || typeStr.includes('prop') || typeStr.includes('item')) return 'object';
  if (typeStr.includes('environment') || typeStr.includes('background') || typeStr.includes('scene')) return 'environment';

  return 'object';  // Default to object for unknown types
}

/**
 * Convert normalized bbox [ymin, xmin, ymax, xmax] to pixel coordinates
 */
function bboxToPixelBox(bbox, dimensions) {
  if (!bbox || !Array.isArray(bbox) || bbox.length !== 4) return null;

  const [ymin, xmin, ymax, xmax] = bbox;
  return {
    x: Math.round(xmin * dimensions.width),
    y: Math.round(ymin * dimensions.height),
    width: Math.round((xmax - xmin) * dimensions.width),
    height: Math.round((ymax - ymin) * dimensions.height)
  };
}

/**
 * Convert pixel box back to normalized bbox
 */
function pixelBoxToBbox(pixelBox, dimensions) {
  return [
    pixelBox.y / dimensions.height,
    pixelBox.x / dimensions.width,
    (pixelBox.y + pixelBox.height) / dimensions.height,
    (pixelBox.x + pixelBox.width) / dimensions.width
  ];
}

/**
 * Calculate Intersection over Union for two bboxes
 */
function calculateIoU(bbox1, bbox2) {
  if (!bbox1 || !bbox2) return 0;

  const [y1min, x1min, y1max, x1max] = bbox1;
  const [y2min, x2min, y2max, x2max] = bbox2;

  // Validate boxes have positive area (max > min)
  const area1 = Math.max(0, x1max - x1min) * Math.max(0, y1max - y1min);
  const area2 = Math.max(0, x2max - x2min) * Math.max(0, y2max - y2min);

  // Skip if either box has zero/negative area
  if (area1 <= 0 || area2 <= 0) return 0;

  // Calculate intersection
  const xOverlap = Math.max(0, Math.min(x1max, x2max) - Math.max(x1min, x2min));
  const yOverlap = Math.max(0, Math.min(y1max, y2max) - Math.max(y1min, y2min));
  const intersection = xOverlap * yOverlap;

  // Calculate union
  const union = area1 + area2 - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * Collect and normalize issues from all evaluation paths
 *
 * @param {Object} evalResults - All evaluation results
 * @param {Object} evalResults.quality - Result from evaluateImageQuality (has fixTargets, identity_sync)
 * @param {Object} evalResults.incremental - Result from evaluateIncrementalConsistency (has issues[])
 * @param {Object} evalResults.final - Result from runFinalConsistencyChecks (has pagesToFix[])
 * @param {number} pageNumber - Page number
 * @param {{width: number, height: number}} imgDimensions - Image dimensions
 * @param {Object} options - Additional options
 * @param {Array} options.qualityMatches - Character matches from quality eval [{figure, reference, face_bbox}]
 * @param {Object} options.bboxDetection - Bbox detection results {figures: [{label, faceBox, bodyBox}]}
 * @returns {UnifiedIssue[]} Array of normalized issues
 */
function collectAllIssues(evalResults, pageNumber, imgDimensions, options = {}) {
  const issues = [];
  const { quality, incremental, final } = evalResults;
  const { qualityMatches = [], bboxDetection = null } = options;

  // Build character name → bbox mapping from quality matches and bbox detection
  // This allows us to look up bboxes for issues that mention a character by name
  const characterBboxes = {};

  // First, add from quality eval matches (most reliable - has character identification)
  for (const match of qualityMatches) {
    if (match.reference) {
      const charName = match.reference.toLowerCase();
      characterBboxes[charName] = {
        faceBbox: match.face_bbox || null,
        bodyBbox: null,  // Quality matches only have face_bbox
        figureId: match.figure
      };
    }
  }

  // Enhance with body boxes from bbox detection (spatial IoU matching on face bboxes)
  // Quality eval and bbox detection number figures independently, so index-based matching is unreliable
  if (bboxDetection?.figures) {
    for (const [charName, charInfo] of Object.entries(characterBboxes)) {
      if (charInfo.faceBbox) {
        let bestFigure = null;
        let bestIoU = 0;
        for (const figure of bboxDetection.figures) {
          if (!figure.faceBox) continue;
          const iou = calculateIoU(charInfo.faceBbox, figure.faceBox);
          if (iou > bestIoU) { bestIoU = iou; bestFigure = figure; }
        }
        if (bestFigure && bestIoU > 0.3) {
          charInfo.bodyBbox = bestFigure.bodyBox || null;
          if (!charInfo.faceBbox && bestFigure.faceBox) {
            charInfo.faceBbox = bestFigure.faceBox;
          }
        }
      }
    }
  }

  if (Object.keys(characterBboxes).length > 0) {
    console.log(`  [ISSUE-EXTRACT] Character bboxes available: ${Object.keys(characterBboxes).join(', ')}`);
  }

  // Collect from quality evaluation (fixTargets with bounding boxes)
  if (quality?.fixTargets) {
    for (const target of quality.fixTargets) {
      if (target.bounds) {  // Only include issues with bounding boxes
        issues.push(normalizeQualityIssue(target, pageNumber, imgDimensions));
      }
    }
  }

  // Also check identity_sync for face-specific issues with bboxes
  if (quality?.reasoning?.identity_sync) {
    for (const match of quality.reasoning.identity_sync) {
      if (match.face_bbox && match.issues && match.issues.length > 0) {
        for (const issue of match.issues) {
          issues.push(normalizeQualityIssue({
            element: 'face',
            severity: 'major',
            bounds: match.face_bbox,
            issue: issue,
            fix_instruction: `Fix: ${issue}`,
            affectedCharacter: match.matched_reference
          }, pageNumber, imgDimensions));
        }
      }
    }
  }

  // Collect from incremental consistency
  // Now includes issues WITHOUT explicit regions - we can look up bbox by character name
  if (incremental?.issues) {
    for (const issue of incremental.issues) {
      // Include issues with regions OR issues with affected character (we can look up bbox)
      if (issue.fixTarget?.region || issue.affectedCharacter) {
        issues.push(normalizeIncrementalIssue(issue, pageNumber, imgDimensions, characterBboxes));
      }
    }
  }

  // Collect from final consistency (page-specific)
  if (final?.pagesToFix) {
    const pageData = final.pagesToFix.find(p => p.pageNumber === pageNumber);
    if (pageData?.issues) {
      for (const issue of pageData.issues) {
        issues.push(normalizeFinalIssue(issue, pageNumber, imgDimensions));
      }
    }
  }

  return issues;
}

/**
 * Deduplicate issues with overlapping regions (IoU > threshold)
 * Prefers issues with higher severity and better-defined regions
 *
 * @param {UnifiedIssue[]} issues - Array of issues to deduplicate
 * @param {number} iouThreshold - IoU threshold for considering overlap (default 0.5)
 * @returns {UnifiedIssue[]} Deduplicated issues
 */
function deduplicateIssues(issues, iouThreshold = 0.5) {
  if (issues.length <= 1) return issues;

  // Sort by severity (critical first) then by source preference
  const sourceOrder = { quality: 0, incremental: 1, final: 2 };
  const sorted = [...issues].sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] || 2) - (SEVERITY_ORDER[b.severity] || 2);
    if (sevDiff !== 0) return sevDiff;
    return (sourceOrder[a.source] || 2) - (sourceOrder[b.source] || 2);
  });

  const keep = [];
  for (const issue of sorted) {
    // Skip issues without bboxes (can't dedupe spatially)
    if (!issue.region.bbox) {
      keep.push(issue);
      continue;
    }

    // Check if this issue overlaps with any already-kept issue
    const dominated = keep.some(kept => {
      if (!kept.region.bbox) return false;
      return calculateIoU(issue.region.bbox, kept.region.bbox) > iouThreshold;
    });

    if (!dominated) {
      keep.push(issue);
    }
  }

  return keep;
}

/**
 * Get adaptive padding for an issue type
 */
function getAdaptivePadding(issueType) {
  return PADDING_BY_TYPE[issueType] || PADDING_BY_TYPE.default;
}

/**
 * Extract issue region from image with adaptive padding
 * Returns a 256x256 thumbnail of the issue area
 *
 * @param {Buffer} imageBuffer - Image data as buffer
 * @param {UnifiedIssue} issue - Issue with region info
 * @param {{width: number, height: number}} imgDimensions - Image dimensions
 * @returns {Promise<{buffer: Buffer, paddedBox: Object}>} Extracted thumbnail and box used
 */
async function extractIssueRegion(imageBuffer, issue, imgDimensions) {
  const pixelBox = issue.region.pixelBox;
  if (!pixelBox) {
    throw new Error(`Issue ${issue.id} has no pixel box for extraction`);
  }

  const padding = getAdaptivePadding(issue.type);
  const padX = Math.round(pixelBox.width * padding);
  const padY = Math.round(pixelBox.height * padding);

  // Calculate padded region
  let left = Math.round(pixelBox.x - padX);
  let top = Math.round(pixelBox.y - padY);
  let width = Math.round(pixelBox.width + padX * 2);
  let height = Math.round(pixelBox.height + padY * 2);

  // For very small regions, expand to minimum size
  const minCropSize = Math.max(TARGET_REGION_SIZE, imgDimensions.width * 0.1);
  if (width < minCropSize || height < minCropSize) {
    const targetSize = Math.max(width, height, minCropSize);
    const centerX = pixelBox.x + pixelBox.width / 2;
    const centerY = pixelBox.y + pixelBox.height / 2;
    left = Math.round(centerX - targetSize / 2);
    top = Math.round(centerY - targetSize / 2);
    width = Math.round(targetSize);
    height = Math.round(targetSize);
  }

  // Clamp to image bounds
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(imgDimensions.width - left, width);
  height = Math.min(imgDimensions.height - top, height);

  // Extract and resize to 256x256
  const buffer = await sharp(imageBuffer)
    .extract({ left, top, width, height })
    .resize(TARGET_REGION_SIZE, TARGET_REGION_SIZE, { fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer,
    paddedBox: { x: left, y: top, width, height }
  };
}

/**
 * Extract all issues for a page and save to disk
 *
 * @param {number} pageNum - Page number
 * @param {Buffer|string} imageData - Image buffer or base64 data URL
 * @param {UnifiedIssue[]} issues - Issues to extract
 * @param {string} outputDir - Base output directory
 * @returns {Promise<UnifiedIssue[]>} Issues with extraction paths added
 */
async function extractPageIssues(pageNum, imageData, issues, outputDir) {
  // Convert base64 to buffer if needed
  const imageBuffer = Buffer.isBuffer(imageData)
    ? imageData
    : Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const metadata = await sharp(imageBuffer).metadata();
  const imgDimensions = { width: metadata.width, height: metadata.height };

  // Create page directory
  const pageDir = path.join(outputDir, 'issues', `page${pageNum}`);
  if (!fs.existsSync(pageDir)) {
    fs.mkdirSync(pageDir, { recursive: true });
  }

  // Save original for reference
  const originalPath = path.join(pageDir, 'original.jpg');
  await sharp(imageBuffer).jpeg({ quality: 90 }).toFile(originalPath);

  // Extract each issue
  const extractedIssues = [];
  let issueIndex = 1;

  for (const issue of issues) {
    if (!issue.region.pixelBox) {
      console.warn(`  Skipping issue ${issue.id}: no pixel box`);
      extractedIssues.push(issue);
      continue;
    }

    try {
      const { buffer, paddedBox } = await extractIssueRegion(imageBuffer, issue, imgDimensions);

      // Generate filename based on type
      const filename = `issue_${issueIndex}_${issue.type}.jpg`;
      const thumbnailPath = path.join(pageDir, filename);
      fs.writeFileSync(thumbnailPath, buffer);

      // Update issue with extraction info
      extractedIssues.push({
        ...issue,
        extraction: {
          thumbnailPath: path.relative(outputDir, thumbnailPath),
          absolutePath: thumbnailPath,
          paddedBox: pixelBoxToBbox(paddedBox, imgDimensions)
        }
      });

      issueIndex++;
    } catch (err) {
      console.error(`  Failed to extract issue ${issue.id}: ${err.message}`);
      extractedIssues.push(issue);
    }
  }

  return extractedIssues;
}

/**
 * Create or update the issues manifest file
 *
 * @param {string} outputDir - Base output directory
 * @param {Object} manifest - Manifest data
 */
function saveManifest(outputDir, manifest) {
  const manifestPath = path.join(outputDir, 'issues', 'manifest.json');
  const issuesDir = path.join(outputDir, 'issues');
  if (!fs.existsSync(issuesDir)) {
    fs.mkdirSync(issuesDir, { recursive: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

/**
 * Load existing manifest if it exists
 */
function loadManifest(outputDir) {
  const manifestPath = path.join(outputDir, 'issues', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return null;
}

module.exports = {
  // Constants
  TARGET_REGION_SIZE,
  PADDING_BY_TYPE,

  // Normalization functions
  normalizeQualityIssue,
  normalizeIncrementalIssue,
  normalizeFinalIssue,
  mapIssueType,

  // Coordinate conversion
  bboxToPixelBox,
  pixelBoxToBbox,
  calculateIoU,

  // Collection and deduplication
  collectAllIssues,
  deduplicateIssues,

  // Extraction
  getAdaptivePadding,
  extractIssueRegion,
  extractPageIssues,

  // Manifest management
  saveManifest,
  loadManifest
};
