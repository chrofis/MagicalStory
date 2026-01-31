/**
 * Repair Verification Module
 *
 * Verifies repaired regions for correctness using Gemini visual comparison.
 * Simplified approach: per-repair verification without LPIPS dependency.
 */

const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Verification thresholds
const LLM_CONFIDENCE_THRESHOLD = 0.7; // Min confidence to accept

// Gemini model for verification (same as quality eval for consistency)
const VERIFY_MODEL = 'gemini-2.5-flash';

/**
 * Create a side-by-side comparison image for verification
 *
 * @param {Buffer} originalBuffer - Original region buffer
 * @param {Buffer} repairedBuffer - Repaired region buffer
 * @returns {Promise<Buffer>} Side-by-side comparison JPEG
 */
async function createVerificationComparison(originalBuffer, repairedBuffer) {
  const [origMeta, repairMeta] = await Promise.all([
    sharp(originalBuffer).metadata(),
    sharp(repairedBuffer).metadata()
  ]);

  const compWidth = Math.max(origMeta.width, repairMeta.width);
  const compHeight = Math.max(origMeta.height, repairMeta.height);

  const comparison = await sharp({
    create: {
      width: compWidth * 2 + 20,
      height: compHeight + 40,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([
      {
        input: await sharp(originalBuffer).resize(compWidth, compHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer(),
        left: 0,
        top: 30
      },
      {
        input: await sharp(repairedBuffer).resize(compWidth, compHeight, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).toBuffer(),
        left: compWidth + 20,
        top: 30
      },
      {
        input: Buffer.from(`
          <svg width="${compWidth * 2 + 20}" height="30">
            <text x="${compWidth / 2}" y="20" text-anchor="middle" font-size="16" font-family="Arial" fill="black">BEFORE</text>
            <text x="${compWidth * 1.5 + 20}" y="20" text-anchor="middle" font-size="16" font-family="Arial" fill="black">AFTER</text>
          </svg>
        `),
        left: 0,
        top: 0
      }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return comparison;
}

/**
 * Create a diff image showing the difference between two images
 * Highlights changes in red/magenta for easy visual comparison
 *
 * @param {Buffer} originalBuffer - Original image buffer
 * @param {Buffer} repairedBuffer - Repaired image buffer
 * @returns {Promise<Buffer>} Diff image as JPEG buffer
 */
async function createDiffImage(originalBuffer, repairedBuffer) {
  try {
    // Get dimensions and ensure they match
    const [origMeta, repairMeta] = await Promise.all([
      sharp(originalBuffer).metadata(),
      sharp(repairedBuffer).metadata()
    ]);

    const width = origMeta.width;
    const height = origMeta.height;

    // Resize repaired to match original if different
    let resizedRepaired = repairedBuffer;
    if (repairMeta.width !== width || repairMeta.height !== height) {
      resizedRepaired = await sharp(repairedBuffer)
        .resize(width, height, { fit: 'fill' })
        .toBuffer();
    }

    // Get raw pixel data from both images
    const [origRaw, repairRaw] = await Promise.all([
      sharp(originalBuffer).ensureAlpha().raw().toBuffer(),
      sharp(resizedRepaired).ensureAlpha().raw().toBuffer()
    ]);

    // Create diff buffer - highlight differences
    const diffBuffer = Buffer.alloc(origRaw.length);
    let totalDiff = 0;
    const pixelCount = width * height;

    for (let i = 0; i < origRaw.length; i += 4) {
      const rDiff = Math.abs(origRaw[i] - repairRaw[i]);
      const gDiff = Math.abs(origRaw[i + 1] - repairRaw[i + 1]);
      const bDiff = Math.abs(origRaw[i + 2] - repairRaw[i + 2]);
      const maxDiff = Math.max(rDiff, gDiff, bDiff);

      if (maxDiff > 10) {
        // Highlight differences in magenta, intensity based on difference
        const intensity = Math.min(255, maxDiff * 3);
        diffBuffer[i] = 255;     // R - red for changes
        diffBuffer[i + 1] = 0;   // G
        diffBuffer[i + 2] = intensity; // B - magenta tint
        diffBuffer[i + 3] = 255; // A
        totalDiff += maxDiff;
      } else {
        // No significant difference - show grayscale version of original
        const gray = Math.round((origRaw[i] + origRaw[i + 1] + origRaw[i + 2]) / 3);
        diffBuffer[i] = gray;
        diffBuffer[i + 1] = gray;
        diffBuffer[i + 2] = gray;
        diffBuffer[i + 3] = 255;
      }
    }

    // Create diff image from raw buffer
    const diffImage = await sharp(diffBuffer, {
      raw: { width, height, channels: 4 }
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Calculate diff percentage
    const avgDiff = totalDiff / pixelCount;
    console.log(`  [DIFF] Avg pixel difference: ${avgDiff.toFixed(2)} (${((avgDiff / 255) * 100).toFixed(1)}%)`);

    return diffImage;
  } catch (err) {
    console.error(`Failed to create diff image: ${err.message}`);
    return null;
  }
}

/**
 * Unified repair verification using Gemini
 *
 * Replaces the previous three-stage verification (LPIPS + LLM + artifacts)
 * with a single Gemini call that checks:
 * 1. Is the issue fixed?
 * 2. Is there a visible change?
 * 3. Are there any new problems?
 *
 * @param {Buffer} originalBuffer - Original region before repair
 * @param {Buffer} repairedBuffer - Region after repair
 * @param {Object} issue - Issue that was supposed to be fixed
 * @returns {Promise<{fixed: boolean, changed: boolean, confidence: number, explanation: string, newProblems: string[]}>}
 */
async function verifyRepairWithGemini(originalBuffer, repairedBuffer, issue) {
  const model = genAI.getGenerativeModel({ model: VERIFY_MODEL });

  // Type-specific artifact checks to include in prompt
  const typeChecks = {
    face: 'asymmetrical eyes, distorted features, merged faces, missing features',
    hand: 'wrong finger count (not 5), merged fingers, floating fingers, backwards hands',
    anatomy: 'floating limbs, detached body parts, impossible poses, missing joints',
    clothing: 'patterns don\'t align, colors bleeding, floating fabric',
    object: 'floating objects, objects merging with background, impossible physics'
  };

  const specificChecks = typeChecks[issue.type] || typeChecks.object;

  // Use template from prompts/ folder, with fallback to inline prompt
  const promptTemplate = PROMPT_TEMPLATES.repairVerification || `Compare these two image regions: BEFORE (left) and AFTER (right).

The original issue was: "{ISSUE_DESCRIPTION}"
Fix instruction was: "{FIX_INSTRUCTION}"
Issue type: {ISSUE_TYPE}

EVALUATE carefully:
1. Is the issue FIXED in the AFTER image? Look for the specific problem mentioned.
2. Is there any VISIBLE CHANGE between BEFORE and AFTER? (Even subtle changes count)
3. Are there any NEW PROBLEMS in the AFTER image? Check for:
   - {TYPE_SPECIFIC_CHECKS}
   - Blurry or smeared areas
   - Unnatural color transitions
   - Objects that don't connect properly

Return JSON only:
{
  "fixed": true/false,
  "changed": true/false,
  "confidence": 0.0-1.0,
  "explanation": "brief explanation of what you see",
  "newProblems": ["list any new issues found"] or []
}`;

  const prompt = fillTemplate(promptTemplate, {
    ISSUE_DESCRIPTION: issue.description || '',
    FIX_INSTRUCTION: issue.fixInstruction || '',
    ISSUE_TYPE: issue.type || 'object',
    TYPE_SPECIFIC_CHECKS: specificChecks
  });

  try {
    // Create side-by-side comparison
    const comparison = await createVerificationComparison(originalBuffer, repairedBuffer);

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: comparison.toString('base64')
        }
      }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // Validate required fields exist
        if (typeof parsed.fixed !== 'boolean') {
          console.warn('Verification response missing "fixed" field, defaulting to false');
        }
        if (typeof parsed.changed !== 'boolean') {
          console.warn('Verification response missing "changed" field, defaulting to false');
        }
        return {
          fixed: parsed.fixed === true,
          changed: parsed.changed === true,
          positionPreserved: parsed.positionPreserved !== false, // Default true if not specified
          stylePreserved: parsed.stylePreserved !== false, // Default true if not specified
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
          explanation: parsed.explanation || '',
          newProblems: Array.isArray(parsed.newProblems) ? parsed.newProblems : [],
          comparisonImage: comparison
        };
      } catch (parseErr) {
        console.warn(`Failed to parse verification JSON: ${parseErr.message}`);
        return {
          fixed: false,
          changed: false,
          confidence: 0,
          explanation: `JSON parse error: ${parseErr.message}`,
          newProblems: [],
          error: 'json_parse_error'
        };
      }
    }

    return {
      fixed: false,
      changed: false,
      confidence: 0,
      explanation: 'No JSON found in verification response',
      newProblems: [],
      error: 'no_json'
    };
  } catch (err) {
    console.error(`Gemini verification failed: ${err.message}`);
    return {
      fixed: false,
      changed: false,
      confidence: 0,
      explanation: `Verification error: ${err.message}`,
      newProblems: [],
      error: err.message
    };
  }
}

/**
 * Check for common AI artifacts in a repaired region
 *
 * @param {Buffer} repairedBuffer - Repaired region buffer
 * @param {string} issueType - Type of issue that was fixed
 * @returns {Promise<{hasArtifacts: boolean, artifacts: string[]}>}
 */
async function checkForNewArtifacts(repairedBuffer, issueType) {
  const model = genAI.getGenerativeModel({ model: VERIFY_MODEL });

  // Type-specific checks
  const typeChecks = {
    face: 'asymmetrical eyes, distorted features, merged faces, missing features',
    hand: 'wrong finger count (not 5), merged fingers, floating fingers, backwards hands',
    anatomy: 'floating limbs, detached body parts, impossible poses, missing joints',
    clothing: 'patterns don\'t align, colors bleeding, floating fabric',
    object: 'floating objects, objects merging with background, impossible physics'
  };

  const specificChecks = typeChecks[issueType] || typeChecks.object;

  const prompt = `Examine this image region for AI generation artifacts.

CHECK FOR:
- ${specificChecks}
- Blurry or smeared areas
- Unnatural color transitions
- Objects that don't connect properly

Return JSON only:
{
  "hasArtifacts": true/false,
  "artifacts": ["list specific problems found"] or [],
  "severity": "none" | "minor" | "major" | "critical"
}`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: repairedBuffer.toString('base64')
        }
      }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          hasArtifacts: parsed.hasArtifacts === true,
          artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
          severity: parsed.severity || 'none'
        };
      } catch (parseErr) {
        console.warn(`Failed to parse artifact check JSON: ${parseErr.message}`);
        return { hasArtifacts: false, artifacts: [], severity: 'none', error: 'json_parse_error' };
      }
    }

    return { hasArtifacts: false, artifacts: [], severity: 'none', error: 'no_json' };
  } catch (err) {
    console.error(`Artifact check failed: ${err.message}`);
    return { hasArtifacts: false, artifacts: [], error: err.message };
  }
}

/**
 * Verify a single repaired region
 *
 * Uses unified Gemini verification that checks in one call:
 * - Is the issue fixed?
 * - Is there a visible change?
 * - Are there any new problems/artifacts?
 *
 * Acceptance criteria:
 * - fixed: true (the issue was addressed)
 * - changed: true (there's a visible difference, not identical)
 * - newProblems: [] (no new artifacts introduced)
 * - confidence >= threshold
 *
 * @param {Buffer} originalBuffer - Original region buffer
 * @param {Buffer} repairedBuffer - Repaired region buffer
 * @param {Object} issue - Issue that was repaired
 * @returns {Promise<{accepted: boolean, reason: string, details: Object}>}
 */
async function verifyRepairedRegion(originalBuffer, repairedBuffer, issue) {
  const results = {
    gemini: null,
    accepted: false,
    reason: ''
  };

  // Single unified verification call
  results.gemini = await verifyRepairWithGemini(originalBuffer, repairedBuffer, issue);

  // Check 1: Was the image actually changed?
  if (!results.gemini.changed) {
    results.accepted = false;
    results.reason = 'No visible change detected - repair may have failed';
    return results;
  }

  // Check 2: Was the issue fixed?
  if (!results.gemini.fixed) {
    results.accepted = false;
    results.reason = `Issue not fixed: ${results.gemini.explanation}`;
    return results;
  }

  // Check 3: Position preserved? (elements must not move)
  if (results.gemini.positionPreserved === false) {
    results.accepted = false;
    results.reason = `Position changed - elements shifted or resized`;
    return results;
  }

  // Check 4: Style preserved? (art style must match)
  if (results.gemini.stylePreserved === false) {
    results.accepted = false;
    results.reason = `Style changed - art style, colors, or lighting don't match`;
    return results;
  }

  // Check 5: Sufficient confidence?
  if (results.gemini.confidence < LLM_CONFIDENCE_THRESHOLD) {
    results.accepted = false;
    results.reason = `Low confidence (${(results.gemini.confidence * 100).toFixed(0)}%)`;
    return results;
  }

  // Check 6: No new problems introduced?
  if (results.gemini.newProblems && results.gemini.newProblems.length > 0) {
    results.accepted = false;
    results.reason = `New problems: ${results.gemini.newProblems.join(', ')}`;
    return results;
  }

  // All checks passed
  results.accepted = true;
  results.reason = 'Repair verified successfully';
  return results;
}

/**
 * Apply verified repairs to the original image
 *
 * @param {Buffer|string} originalImage - Original full image (buffer or base64)
 * @param {Object[]} verifiedRepairs - Array of verified repairs with buffer and issue info
 * @returns {Promise<Buffer>} Image with repairs applied
 */
async function applyVerifiedRepairs(originalImage, verifiedRepairs) {
  // Convert to buffer if needed
  const imageBuffer = Buffer.isBuffer(originalImage)
    ? originalImage
    : Buffer.from(originalImage.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  if (verifiedRepairs.length === 0) {
    return imageBuffer;
  }

  const metadata = await sharp(imageBuffer).metadata();
  const composites = [];

  for (const repair of verifiedRepairs) {
    if (!repair.accepted || !repair.buffer || !repair.issue) continue;

    const paddedBox = repair.issue.extraction?.paddedBox;
    if (!paddedBox) continue;

    // Convert normalized paddedBox back to pixels
    const [ymin, xmin, ymax, xmax] = paddedBox;
    let x = Math.round(xmin * metadata.width);
    let y = Math.round(ymin * metadata.height);
    let width = Math.round((xmax - xmin) * metadata.width);
    let height = Math.round((ymax - ymin) * metadata.height);

    // Clamp to image bounds to prevent canvas extension
    if (x < 0) { width += x; x = 0; }
    if (y < 0) { height += y; y = 0; }
    if (x + width > metadata.width) { width = metadata.width - x; }
    if (y + height > metadata.height) { height = metadata.height - y; }

    // Skip if dimensions become invalid
    if (width <= 0 || height <= 0) {
      console.warn(`Skipping repair: invalid dimensions after clamping (${width}x${height})`);
      continue;
    }

    try {
      // Resize repaired region to match the original extraction size
      const resizedRepair = await sharp(repair.buffer)
        .resize(width, height, { fit: 'fill' })
        .toBuffer();

      composites.push({
        input: resizedRepair,
        left: x,
        top: y,
        blend: 'over'
      });
    } catch (err) {
      console.error(`Failed to prepare repair for compositing: ${err.message}`);
    }
  }

  if (composites.length === 0) {
    return imageBuffer;
  }

  // Apply all repairs at once, ensuring output matches original dimensions
  const result = await sharp(imageBuffer)
    .composite(composites)
    .resize(metadata.width, metadata.height, { fit: 'cover', position: 'top-left' })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Verify dimensions match
  const resultMeta = await sharp(result).metadata();
  if (resultMeta.width !== metadata.width || resultMeta.height !== metadata.height) {
    console.warn(`⚠️ Dimension mismatch after repair: ${resultMeta.width}x${resultMeta.height} vs original ${metadata.width}x${metadata.height}`);
  }

  return result;
}

/**
 * Create a comparison image showing before/after for all repairs
 *
 * @param {Buffer} originalImage - Original full image
 * @param {Buffer} repairedImage - Repaired full image
 * @param {Object[]} repairs - Repair info with accepted status
 * @returns {Promise<Buffer>} Side-by-side comparison image
 */
async function createComparisonImage(originalImage, repairedImage, repairs) {
  const origBuffer = Buffer.isBuffer(originalImage)
    ? originalImage
    : Buffer.from(originalImage.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const repairBuffer = Buffer.isBuffer(repairedImage)
    ? repairedImage
    : Buffer.from(repairedImage.replace(/^data:image\/\w+;base64,/, ''), 'base64');

  const [origMeta, repairMeta] = await Promise.all([
    sharp(origBuffer).metadata(),
    sharp(repairBuffer).metadata()
  ]);

  const maxWidth = 800;
  const scale = Math.min(1, maxWidth / origMeta.width);
  const scaledWidth = Math.round(origMeta.width * scale);
  const scaledHeight = Math.round(origMeta.height * scale);

  const labelHeight = 30;
  const summaryHeight = 60;

  // Create scaled versions
  const [scaledOrig, scaledRepair] = await Promise.all([
    sharp(origBuffer).resize(scaledWidth, scaledHeight).toBuffer(),
    sharp(repairBuffer).resize(scaledWidth, scaledHeight).toBuffer()
  ]);

  // Summary text
  const acceptedCount = repairs.filter(r => r.accepted).length;
  const rejectedCount = repairs.length - acceptedCount;

  const comparison = await sharp({
    create: {
      width: scaledWidth * 2 + 20,
      height: scaledHeight + labelHeight + summaryHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([
      {
        input: Buffer.from(`
          <svg width="${scaledWidth * 2 + 20}" height="${labelHeight}">
            <text x="${scaledWidth / 2}" y="22" text-anchor="middle" font-size="18" font-family="Arial" font-weight="bold" fill="#333">BEFORE</text>
            <text x="${scaledWidth * 1.5 + 20}" y="22" text-anchor="middle" font-size="18" font-family="Arial" font-weight="bold" fill="#333">AFTER</text>
          </svg>
        `),
        left: 0,
        top: 0
      },
      { input: scaledOrig, left: 0, top: labelHeight },
      { input: scaledRepair, left: scaledWidth + 20, top: labelHeight },
      {
        input: Buffer.from(`
          <svg width="${scaledWidth * 2 + 20}" height="${summaryHeight}">
            <rect width="100%" height="100%" fill="#f0f0f0"/>
            <text x="50%" y="25" text-anchor="middle" font-size="14" font-family="Arial" fill="#333">
              Repairs: ${acceptedCount} accepted, ${rejectedCount} rejected
            </text>
            <text x="50%" y="45" text-anchor="middle" font-size="12" font-family="Arial" fill="#666">
              ${repairs.map(r => r.accepted ? '✓' : '✗').join(' ')}
            </text>
          </svg>
        `),
        left: 0,
        top: labelHeight + scaledHeight
      }
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return comparison;
}

module.exports = {
  // Thresholds
  LLM_CONFIDENCE_THRESHOLD,

  // Core verification
  verifyRepairWithGemini,
  checkForNewArtifacts,
  verifyRepairedRegion,

  // Helpers
  createVerificationComparison,
  createDiffImage,

  // Repair application
  applyVerifiedRepairs,
  createComparisonImage
};
