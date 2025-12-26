const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'client/src/components/generation/StoryDisplay.tsx');
let content = fs.readFileSync(filePath, 'utf8');

const coverObjects = ['frontCoverObj', 'initialPageObj', 'backCoverObj'];
let patchCount = 0;

for (const obj of coverObjects) {
  const oldPattern = `                {/* Quality Score */}
                {${obj}.qualityScore !== undefined && (
                  <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                      <span>{language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}</span>`;

  const newPattern = `                {/* Quality Score */}
                {${obj}.qualityScore !== undefined && (
                  <details className="bg-indigo-50 border border-indigo-300 rounded-lg p-3">
                    <summary className="cursor-pointer text-sm font-semibold text-indigo-700 hover:text-indigo-900 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        {language === 'de' ? 'Qualitätsbewertung' : language === 'fr' ? 'Score de qualité' : 'Quality Score'}
                        {${obj}.qualityModelId && <span className="text-xs font-normal text-indigo-500">({${obj}.qualityModelId})</span>}
                      </span>`;

  if (content.includes(oldPattern)) {
    content = content.replace(oldPattern, newPattern);
    patchCount++;
    console.log(`✅ Patched ${obj} quality score section`);
  } else {
    console.log(`⚠️ ${obj} pattern not found - already patched or structure changed`);
  }
}

if (patchCount > 0) {
  fs.writeFileSync(filePath, content);
  console.log(`\n✅ Total: ${patchCount} sections patched`);
} else {
  console.log('\n⚠️ No changes made');
}
