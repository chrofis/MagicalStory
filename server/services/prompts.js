/**
 * Prompt Templates Service
 *
 * Loads and manages prompt templates from prompts/ folder
 */

const fs = require('fs').promises;
const path = require('path');
const { log } = require('../utils/logger');

const PROMPT_TEMPLATES = {};

async function loadPromptTemplates() {
  try {
    const promptsDir = path.join(__dirname, '../../prompts');

    PROMPT_TEMPLATES.outline = await fs.readFile(path.join(promptsDir, 'outline.txt'), 'utf-8');
    PROMPT_TEMPLATES.storyText = await fs.readFile(path.join(promptsDir, 'story-text.txt'), 'utf-8');
    PROMPT_TEMPLATES.sceneDescriptions = await fs.readFile(path.join(promptsDir, 'scene-descriptions.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGeneration = await fs.readFile(path.join(promptsDir, 'image-generation.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationDe = await fs.readFile(path.join(promptsDir, 'image-generation-de.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationFr = await fs.readFile(path.join(promptsDir, 'image-generation-fr.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequential = await fs.readFile(path.join(promptsDir, 'image-generation-sequential.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequentialDe = await fs.readFile(path.join(promptsDir, 'image-generation-sequential-de.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequentialFr = await fs.readFile(path.join(promptsDir, 'image-generation-sequential-fr.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationStorybook = await fs.readFile(path.join(promptsDir, 'image-generation-storybook.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageEvaluation = await fs.readFile(path.join(promptsDir, 'image-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.coverImageEvaluation = await fs.readFile(path.join(promptsDir, 'cover-image-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.frontCover = await fs.readFile(path.join(promptsDir, 'front-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageWithDedication = await fs.readFile(path.join(promptsDir, 'initial-page-with-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageNoDedication = await fs.readFile(path.join(promptsDir, 'initial-page-no-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.backCover = await fs.readFile(path.join(promptsDir, 'back-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.storybookCombined = await fs.readFile(path.join(promptsDir, 'storybook-combined.txt'), 'utf-8');
    PROMPT_TEMPLATES.rewriteBlockedScene = await fs.readFile(path.join(promptsDir, 'rewrite-blocked-scene.txt'), 'utf-8');
    // Character analysis prompt
    PROMPT_TEMPLATES.characterAnalysis = await fs.readFile(path.join(promptsDir, 'character-analysis.txt'), 'utf-8');
    // Avatar generation prompts
    PROMPT_TEMPLATES.avatarSystemInstruction = await fs.readFile(path.join(promptsDir, 'avatar-system-instruction.txt'), 'utf-8');
    PROMPT_TEMPLATES.avatarMainPrompt = await fs.readFile(path.join(promptsDir, 'avatar-main-prompt.txt'), 'utf-8');
    PROMPT_TEMPLATES.avatarRetryPrompt = await fs.readFile(path.join(promptsDir, 'avatar-retry-prompt.txt'), 'utf-8');
    PROMPT_TEMPLATES.avatarEvaluation = await fs.readFile(path.join(promptsDir, 'avatar-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.styledCostumedAvatar = await fs.readFile(path.join(promptsDir, 'styled-costumed-avatar.txt'), 'utf-8');
    // Visual Bible and editing prompts
    PROMPT_TEMPLATES.visualBibleAnalysis = await fs.readFile(path.join(promptsDir, 'visual-bible-analysis.txt'), 'utf-8');
    PROMPT_TEMPLATES.illustrationEdit = await fs.readFile(path.join(promptsDir, 'illustration-edit.txt'), 'utf-8');
    // Auto-repair / Inpainting prompt
    PROMPT_TEMPLATES.imageInspection = await fs.readFile(path.join(promptsDir, 'image-inspection.txt'), 'utf-8');
    // Scene expansion for regeneration
    PROMPT_TEMPLATES.sceneExpansion = await fs.readFile(path.join(promptsDir, 'scene-expansion.txt'), 'utf-8');
    PROMPT_TEMPLATES.sceneExpansionDe = await fs.readFile(path.join(promptsDir, 'scene-expansion-de.txt'), 'utf-8');
    PROMPT_TEMPLATES.sceneExpansionFr = await fs.readFile(path.join(promptsDir, 'scene-expansion-fr.txt'), 'utf-8');

    log.info('📝 Prompt templates loaded from prompts/ folder');
  } catch (err) {
    log.error('❌ Failed to load prompt templates:', err.message);
    log.error('   Falling back to hardcoded prompts');
  }
}

/**
 * Replace placeholders in prompt templates
 * @param {string} template - Template string with {PLACEHOLDER} syntax
 * @param {Object} replacements - Key-value pairs for replacements
 * @returns {string} Filled template
 */
function fillTemplate(template, replacements) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

module.exports = {
  PROMPT_TEMPLATES,
  loadPromptTemplates,
  fillTemplate
};
