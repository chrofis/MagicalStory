const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'client/src/components/generation/StoryDisplay.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// Find and replace the second quality score section (standard layout)
// This one has image.qualityScore instead of image?.qualityScore
const oldPattern = `                            {/* Quality Score with Reasoning */}
                            {image.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span>{language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}</span>`;

const newPattern = `                            {/* Quality Score with Reasoning */}
                            {image.qualityScore !== undefined && (
                              <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                                <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                                  <span className="flex items-center gap-2">
                                    {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                                    {image.qualityModelId && <span className="text-xs font-normal text-indigo-500">({image.qualityModelId})</span>}
                                  </span>`;

if (content.includes(oldPattern)) {
  content = content.replace(oldPattern, newPattern);
  fs.writeFileSync(filePath, content);
  console.log('✅ Successfully patched quality score section');
} else {
  console.log('Pattern not found - already patched or structure changed');
}
