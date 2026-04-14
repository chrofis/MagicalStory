const helpers = require('../../server/lib/storyHelpers');

const sample = `Seven-year-old Lukas stands in the right foreground...

---METADATA---

\`\`\`
{
  "characters": [
    {"name": "Lukas", "clothing": "standard", "position": "right foreground"},
    {"name": "Verena", "clothing": "standard", "position": "center-left"},
    {"name": "Roger", "clothing": "standard", "position": "center"}
  ],
  "objects": ["LOC002"],
  "textPosition": "top-right"
}
\`\`\`
`;

const meta = helpers.extractSceneMetadata(sample);
console.log('With position field:');
console.log('  characters:', meta?.characters);
console.log('  characterPositions:', JSON.stringify(meta?.characterPositions));

const noPosSample = sample.replace(/, "position": "[^"]+"/g, '');
const meta2 = helpers.extractSceneMetadata(noPosSample);
console.log();
console.log('Without position field (backward compat):');
console.log('  characters:', meta2?.characters);
console.log('  characterPositions:', JSON.stringify(meta2?.characterPositions));
