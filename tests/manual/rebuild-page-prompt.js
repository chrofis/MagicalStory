// Rebuilds a stored page's image prompt with the CURRENT prompt builders.
// No paid API calls. Usage: node tests/manual/rebuild-page-prompt.js <storyJson> <pageNumber>
const fs = require('fs');
const { buildImagePrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

(async () => {
await loadPromptTemplates();
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pageNumber = Number(process.argv[3] || 2);
const scene = (data.sceneImages || []).find(s => s.pageNumber === pageNumber);
if (!scene) throw new Error(`page ${pageNumber} not stored`);

const inputData = {
  language: data.language,
  artStyle: data.artStyle || data.inputData?.artStyle,
  characters: data.characters,
  layout: data.layout || { textInImage: true },
  season: data.season,
};
const vbRefElementIds = (data.visualBible?.artifacts || []).map(a => a.id);
const prompt = buildImagePrompt(
  scene.sceneDescription, inputData, scene.sceneCharacters || null,
  data.visualBible || null, pageNumber, scene.referencePhotos || null,
  { skipVisualBible: true, vbRefElementIds }
);
console.log(prompt);
})();
