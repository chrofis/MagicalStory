const fs = require('fs');
const p = 'server/lib/sceneComposite.js';
let s = fs.readFileSync(p, 'utf8');
const before = s.length;

// ---------------------------------------------------------------------------
// 1. Prefer the SHORT blend style line over the long generation paragraph.
// ---------------------------------------------------------------------------
const oldStyle = `function _blendStyleLine(artStyle) {
  const key = String(artStyle || '').trim();
  try {
    const { ART_STYLES } = require('./promptBuilders');
    if (ART_STYLES?.[key]) return ART_STYLES[key];
  } catch { /* fall through to the local map */ }
  return BLEND_STYLE_LINES[key] || BLEND_STYLE_LINES.watercolor;
}`;
const newStyle = `function _blendStyleLine(artStyle) {
  const key = String(artStyle || '').trim();
  // BLEND_STYLE_LINES FIRST. It used to be the fallback behind ART_STYLES,
  // which meant every style present there got the long GENERATION paragraph
  // instead of the short blend line this map exists to provide — the map was
  // effectively dead for every mapped style. Two costs, both measured:
  // length (frame creep scales with prompt size — see buildBlendEditPrompt),
  // and content. The realistic paragraph ends "cinematic composition", which
  // asks for a well-composed shot in the same prompt that needs the shot left
  // alone; exp 848 re-framed. ART_STYLES stays as the fallback for a style
  // this map does not carry.
  if (BLEND_STYLE_LINES[key]) return BLEND_STYLE_LINES[key];
  try {
    const { ART_STYLES } = require('./promptBuilders');
    if (ART_STYLES?.[key]) return ART_STYLES[key];
  } catch { /* fall through to the local map */ }
  return BLEND_STYLE_LINES.watercolor;
}`;
if (!s.includes(oldStyle)) throw new Error('_blendStyleLine not found');
s = s.replace(oldStyle, newStyle);

// realistic was missing from the map, which is why it reached ART_STYLES.
const anchor = `  cyber:        "cyberpunk graphic novel illustration — neon reflections, chrome, dense complexity, high contrast, dark atmosphere, volumetric fog",
};`;
if (!s.includes(anchor)) throw new Error('BLEND_STYLE_LINES tail not found');
s = s.replace(anchor, `  cyber:        "cyberpunk graphic novel illustration — neon reflections, chrome, dense complexity, high contrast, dark atmosphere, volumetric fog",
  realistic:    "a photograph — real people, real skin texture, natural hair, natural light",
};`);

// ---------------------------------------------------------------------------
// 2. The prompt itself: one positive description, no DO-NOT list.
// ---------------------------------------------------------------------------
const startMarker = 'function buildBlendEditPrompt(scene, cast = null) {';
const endMarker = `Art style: \${artStyle}.\${buildStagedDepthLine(cast)}\${textDirective}\`;
  }`;
const a = s.indexOf(startMarker);
const b = s.indexOf(endMarker);
if (a === -1 || b === -1) throw new Error('buildBlendEditPrompt body not found');

const newBody = `function buildBlendEditPrompt(scene, cast = null) {
  const people = Array.isArray(cast) ? cast : [];
  if (people.length) {
    const expressions = scene.characterExpressions || {};
    const attention = scene.attentionTargets || {};
    const actions = scene.characterActions || {};
    const occluded = scene.occludedBy || {};
    const artStyle = _blendStyleLine(scene.artStyle);

    const depthWord = (c) => {
      const d = String(c.depth || 'foreground').toLowerCase();
      return d === 'background' ? 'in the distance'
        : d === 'midground' ? 'in the middle distance' : 'close to the camera';
    };

    // One paragraph per person, and every fact stated ONCE. The old build said
    // each action twice (as "doing:" in the census and again under CHANGE
    // THESE), each outfit twice (the scene overview and "wearing:"), and each
    // depth twice (the census word and a trailing "Depths as staged" line) —
    // roughly a third of the prompt was restatement, and what got restated was
    // what to CHANGE rather than what to keep.
    const lines = people.map((c) => {
      const bits = [\`- \${c.name} — \${_ageWord(c.age)}, \${depthWord(c)}.\`];
      if (actions[c.name]) bits.push(\` \${_sentence(actions[c.name])}\`);
      if (attention[c.name]) bits.push(\` Looking at \${attention[c.name]}.\`);
      if (expressions[c.name]) bits.push(\` \${_sentence(expressions[c.name])}\`);
      // Size-neutral, and the occluder is deliberately NOT named: run E of Lab
      // 695-705 named it and the result was worse.
      if (occluded[c.name]) bits.push(' Only part of them shows, which is deliberate — leave them exactly as they are, at exactly the size they are.');
      return bits.join('');
    }).join('\\n');

    const textDirective = buildTextOverlayDirective(scene.textOverlay, scene.artStyle);

    return \`\${artStyle}.

This picture is finished and correctly staged: every person stands where they belong, at the size they belong. What it lacks is life — the faces are blank and the bodies are stiff from being pasted in.

Give each person below their expression, and turn their head and body on the spot toward what they are watching:
\${lines}

Then settle them into the picture: soften the pasted edges, paint out any solid colour fringe around them, match each person to the light and colour of the scene, and give each one a contact shadow where they meet the ground.

Everything else is already right and stays as it is — the camera position, the borders and the crop, the background, and who is in the frame. No lettering anywhere in the picture.\${textDirective}\`;
  }`;

s = s.slice(0, a) + newBody + s.slice(b + endMarker.length);

// Small helper: capitalise a fragment into a sentence.
if (!s.includes('function _sentence(')) {
  s = s.replace('function _ageWord(age) {',
`// Metadata fragments arrive lowercase and unpunctuated ("kneels at the gap",
// "eyes wide with urgency"). The blend reads as prose now, so each one becomes
// its own sentence rather than a bullet fragment.
function _sentence(text) {
  const t = String(text || '').trim().replace(/[.\\s]+$/, '');
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

function _ageWord(age) {`);
}

fs.writeFileSync(p, s);
console.log('rewrote sceneComposite.js:', before, '->', s.length, 'chars');
