/**
 * Repair Verification Module
 *
 * Verifies repaired regions for correctness and checks for newly introduced artifacts.
 * Uses LPIPS for change detection and LLM for semantic verification.
 */

const sharp = require('sharp');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://localhost:5000';

// Verification thresholds
const LPIPS_CHANGE_THRESHOLD = 0.02;  // Min LPIPS to consider changed
const LPIPS_MAX_THRESHOLD = 0.5;      // Max LPIPS before considering too different
const LLM_CONFIDENCE_THRESHOLD = 0.7; // Min confidence to accept

// Gemini model for verification
const VERIFY_MODEL = 'gemini-2.0-flash';

/**
 * Calculate LPIPS score between two images using the photo analyzer service
 *
 * @param {Buffer} original - Original image buffer
 * @param {Buffer} repaired - Repaired image buffer
 * @returns {Promise<{lpipsScore: number, changed: boolean}>}
 */
async function calculateLPIPS(original, repaired) {
  try {
    const response = await fetch(`${PHOTO_ANALYZER_URL}/lpips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: original.toString('base64'),
        image2: repaired.toString('base64')
      })
    });

    if (!response.ok) {
      throw new Error(`LPIPS service returned ${response.status}`);
    }

    const result = await response.json();
    const score = result.lpips_score || result.lpipsScore || 0;

    return {
      lpipsScore: score,
      changed: score > LPIPS_CHANGE_THRESHOLD,
      tooChanged: score > LPIPS_MAX_THRESHOLD
    };
  } catch (err) {
    console.warn(`LPIPS calculation failed: ${err.message}`);
    return { lpipsScore: null, changed: null, error: err.message };
  }
}

/**
 * Use LLM to verify if a repair was successful
 *
 * @param {Buffer} originalBuffer - Original region before repair
 * @param {Buffer} repairedBuffer - Region after repair
 * @param {Object} issue - Issue that was supposed to be fixed
 * @returns {Promise<{fixed: boolean, confidence: number, explanation: string}>}
 */
async function verifyWithLLM(originalBuffer, repairedBuffer, issue) {
  const model = genAI.getGenerativeModel({ model: VERIFY_MODEL });

  const prompt = `Compare these two images: BEFORE (left) and AFTER (right) repair.

The repair was supposed to fix: "${issue.fixInstruction}"
Issue type: ${issue.type}
Issue description: "${issue.description}"

EVALUATE:
1. Was the specific issue fixed?
2. Does the repair look natural and consistent with the art style?
3. Were any NEW problems introduced (extra fingers, distorted faces, floating objects)?

Return JSON only:
{
  "fixed": true/false,
  "confidence": 0.0-1.0,
  "explanation": "brief explanation",
  "newProblems": ["list any new issues"] or []
}`;

  try {
    // Create side-by-side comparison image
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
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        fixed: parsed.fixed === true,
        confidence: parsed.confidence || 0,
        explanation: parsed.explanation || '',
        newProblems: parsed.newProblems || [],
        comparisonImage: comparison
      };
    }

    return {
      fixed: false,
      confidence: 0,
      explanation: 'Could not parse LLM response',
      newProblems: []
    };
  } catch (err) {
    console.error(`LLM verification failed: ${err.message}`);
    return {
      fixed: false,
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
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        hasArtifacts: parsed.hasArtifacts === true,
        artifacts: parsed.artifacts || [],
        severity: parsed.severity || 'none'
      };
    }

    return { hasArtifacts: false, artifacts: [], severity: 'none' };
  } catch (err) {
    console.error(`Artifact check failed: ${err.message}`);
    return { hasArtifacts: false, artifacts: [], error: err.message };
  }
}

/**
 * Verify a single repaired region
 *
 * @param {Buffer} originalBuffer - Original region buffer
 * @param {Buffer} repairedBuffer - Repaired region buffer
 * @param {Object} issue - Issue that was repaired
 * @returns {Promise<{accepted: boolean, reason: string, details: Object}>}
 */
async function verifyRepairedRegion(originalBuffer, repairedBuffer, issue) {
  const results = {
    lpips: null,
    llm: null,
    artifacts: null,
    accepted: false,
    reason: ''
  };

  // Step 1: LPIPS change detection
  results.lpips = await calculateLPIPS(originalBuffer, repairedBuffer);

  if (results.lpips.lpipsScore !== null) {
    if (!results.lpips.changed) {
      results.accepted = false;
      results.reason = 'No visible change detected (LPIPS too low)';
      return results;
    }

    if (results.lpips.tooChanged) {
      results.accepted = false;
      results.reason = 'Region changed too much (LPIPS too high) - may have lost consistency';
      return results;
    }
  }

  // Step 2: LLM verification
  results.llm = await verifyWithLLM(originalBuffer, repairedBuffer, issue);

  if (!results.llm.fixed) {
    results.accepted = false;
    results.reason = `Fix not applied: ${results.llm.explanation}`;
    return results;
  }

  if (results.llm.confidence < LLM_CONFIDENCE_THRESHOLD) {
    results.accepted = false;
    results.reason = `Low confidence fix (${(results.llm.confidence * 100).toFixed(0)}%)`;
    return results;
  }

  if (results.llm.newProblems && results.llm.newProblems.length > 0) {
    results.accepted = false;
    results.reason = `New problems introduced: ${results.llm.newProblems.join(', ')}`;
    return results;
  }

  // Step 3: Artifact check
  results.artifacts = await checkForNewArtifacts(repairedBuffer, issue.type);

  if (results.artifacts.hasArtifacts && results.artifacts.severity !== 'none' && results.artifacts.severity !== 'minor') {
    results.accepted = false;
    results.reason = `Artifacts detected: ${results.artifacts.artifacts.join(', ')}`;
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
    const x = Math.round(xmin * metadata.width);
    const y = Math.round(ymin * metadata.height);
    const width = Math.round((xmax - xmin) * metadata.width);
    const height = Math.round((ymax - ymin) * metadata.height);

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

  // Apply all repairs at once
  const result = await sharp(imageBuffer)
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer();

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
  LPIPS_CHANGE_THRESHOLD,
  LPIPS_MAX_THRESHOLD,
  LLM_CONFIDENCE_THRESHOLD,

  // Core verification
  calculateLPIPS,
  verifyWithLLM,
  checkForNewArtifacts,
  verifyRepairedRegion,

  // Repair application
  applyVerifiedRepairs,
  createComparisonImage
};
