// Step 3: re-run Gemini 2.5 Flash bbox detection on the saved page images
// and produce a comparison report (Step 4).
// Does NOT run any local cascade — Flask service is not running.

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OUT_DIR = path.join(__dirname, '..', '..', 'tmp', 'bbox-investigation');
const PROMPT_FILE = path.join(__dirname, '..', '..', 'prompts', 'bounding-box-detection.txt');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const MODEL_ID = 'gemini-2.5-flash';

function buildPrompt(expectedCharacters, sceneContext) {
  let prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  if (expectedCharacters?.length) {
    const charSection = `EXPECTED CHARACTERS (identify by name if found):\n` +
      expectedCharacters.map((c, i) =>
        `${i + 1}. ${c.name} - ${c.description}`
      ).join('\n');
    prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', charSection);
  } else {
    prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', '(No expected characters provided)');
  }
  prompt = prompt.replace('{{EXPECTED_OBJECTS}}', '(No expected objects provided)');
  if (sceneContext) {
    prompt = prompt.replace('{{SCENE_CONTEXT}}', `SCENE DESCRIPTION (use to identify characters):\n${sceneContext}`);
  } else {
    prompt = prompt.replace('{{SCENE_CONTEXT}}', '');
  }
  return prompt;
}

async function callGemini(base64Data, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: base64Data } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      maxOutputTokens: 2500,
      temperature: 0.5,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    // strip fences if any
    const cleaned = text.replace(/```json|```/g, '').trim();
    try { return JSON.parse(cleaned); } catch { return { rawText: text.slice(0, 500) }; }
  }
}

// Normalize bbox to 0-1 [ymin,xmin,ymax,xmax]
function normBbox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const max = Math.max(...b);
  if (max > 1.5) return b.map(v => v / 1000);
  return b.slice();
}
function yCenter(b) { if (!b) return null; return (b[0] + b[2]) / 2; }

(async () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'recorded-boxes.json'), 'utf-8'));
  const characters = recorded.characters;
  const freshResults = [];

  for (const page of recorded.pages) {
    const imgPath = path.join(OUT_DIR, page.imageFile);
    if (!fs.existsSync(imgPath)) { console.log(`skip p${page.page} (no image)`); continue; }
    const base64 = fs.readFileSync(imgPath).toString('base64');
    const prompt = buildPrompt(characters, page.sceneDescription);

    console.log(`Gemini fresh detect p${page.page}...`);
    let det;
    try {
      det = await callGemini(base64, prompt);
    } catch (e) {
      console.log('  error:', e.message);
      det = { error: e.message };
    }
    freshResults.push({ page: page.page, detection: det });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'gemini-fresh.json'), JSON.stringify(freshResults, null, 2));
  console.log('Wrote gemini-fresh.json');

  // --- Build comparison report (Step 4) ---
  const lines = [];
  lines.push(`# Bbox Investigation — Story ${recorded.storyId}`);
  lines.push('');
  lines.push(`Comparing three box sources per figure, per page:`);
  lines.push('');
  lines.push(`- **pipeline.faceBox** — the merged face bbox the pipeline actually used downstream (from \`story.sceneImages[].imageVersions[].bboxDetection.figures[].faceBox\`).`);
  lines.push(`- **pipeline.geminiFaceBox** — the raw Gemini face bbox the pipeline recorded *before* merging with cascade hits (\`_geminiFaceBox\` on same figure).`);
  lines.push(`- **fresh.geminiFaceBox** — Gemini 2.5 Flash re-run just now against the active page image (same prompt the pipeline uses).`);
  lines.push(`- **pipeline.bodyBox** — body bbox from pipeline; reference.`);
  lines.push('');
  lines.push(`All coordinates are \`[ymin, xmin, ymax, xmax]\` normalized 0–1. "yCenter" is the vertical centre of the face bbox — **yCenter ≥ 0.5 means the face bbox centre lies in the lower half of the frame**, which for a full-standing character is almost always torso/legs (i.e. wrong).`);
  lines.push('');
  lines.push(`**Flask service note**: \`photo_analyzer.py\` was NOT running on port 5000 during this investigation, so anime cascade / Haar runs could not be executed independently. Their influence is still visible via \`_cascadeFace\` flag on the pipeline figures ("both" / "anime" / "haar_only" = which cascade matched).`);
  lines.push('');

  const named = new Set(characters.map(c => c.name));

  // Per-page tables
  for (const page of recorded.pages) {
    lines.push(`## Page ${page.page}`);
    lines.push('');
    lines.push(`- Active source: \`${page.bestSource}\` (version ${page.activeVersionIndex})`);
    lines.push(`- Image: \`${page.imageFile}\``);
    if (page.sceneDescription) lines.push(`- Scene: ${page.sceneDescription.replace(/\s+/g,' ').slice(0, 200)}…`);
    lines.push('');
    lines.push(`| Character | Source | face yCenter | Box [y,x,Y,X] | Lower-half flag |`);
    lines.push(`|---|---|---|---|---|`);

    const bd = page.activeBboxDetection;
    const freshEntry = freshResults.find(f => f.page === page.page);
    const freshFigs = freshEntry?.detection?.figures || [];
    const freshFigByName = new Map(freshFigs.filter(f => f && named.has(f.name)).map(f => [f.name, f]));

    const pipelineFigs = (bd?.figures || []).filter(f => named.has(f.name));
    const seen = new Set();

    for (const f of pipelineFigs) {
      seen.add(f.name);
      const fb = normBbox(f.faceBox);
      const gb = normBbox(f._geminiFaceBox);
      const bb = normBbox(f.bodyBox);
      const fy = yCenter(fb), gy = yCenter(gb);
      const flag = v => v != null && v >= 0.5 ? 'LOWER-HALF' : '';
      lines.push(`| ${f.name} | pipeline.faceBox (${f._cascadeFace || 'n/a'}) | ${fy?.toFixed(3) ?? 'n/a'} | ${fb ? '['+fb.map(n=>n.toFixed(3)).join(', ')+']' : 'null'} | ${flag(fy)} |`);
      lines.push(`| ${f.name} | pipeline.geminiFaceBox | ${gy != null ? gy.toFixed(3) : 'n/a'} | ${gb ? '['+gb.map(n=>n.toFixed(3)).join(', ')+']' : 'n/a'} | ${flag(gy)} |`);
      const ff = freshFigByName.get(f.name);
      const ffb = ff ? normBbox(ff.face_box || ff.faceBox) : null;
      const ffy = yCenter(ffb);
      lines.push(`| ${f.name} | fresh.geminiFaceBox | ${ffy != null ? ffy.toFixed(3) : 'n/a'} | ${ffb ? '['+ffb.map(n=>n.toFixed(3)).join(', ')+']' : 'n/a'} | ${flag(ffy)} |`);
      lines.push(`| ${f.name} | pipeline.bodyBox | — | ${bb ? '['+bb.map(n=>n.toFixed(3)).join(', ')+']' : 'n/a'} | — |`);
    }

    // Characters in fresh result but absent from pipeline active
    for (const [name, ff] of freshFigByName) {
      if (seen.has(name)) continue;
      const ffb = normBbox(ff.face_box || ff.faceBox);
      const ffy = yCenter(ffb);
      const flag = ffy != null && ffy >= 0.5 ? 'LOWER-HALF' : '';
      lines.push(`| ${name} | fresh.geminiFaceBox (NEW in fresh) | ${ffy != null ? ffy.toFixed(3) : 'n/a'} | ${ffb ? '['+ffb.map(n=>n.toFixed(3)).join(', ')+']' : 'n/a'} | ${flag} |`);
    }
    lines.push('');
  }

  // ---- Summary ----
  lines.push(`## Summary`);
  lines.push('');
  const bad = [];
  for (const page of recorded.pages) {
    const bd = page.activeBboxDetection;
    if (!bd) continue;
    for (const f of (bd.figures || [])) {
      if (!named.has(f.name)) continue;
      const fb = normBbox(f.faceBox);
      const gb = normBbox(f._geminiFaceBox);
      const fy = yCenter(fb), gy = yCenter(gb);
      if (fy == null) continue;
      if (fy >= 0.5) {
        bad.push({ page: page.page, name: f.name, merged: fy, gemini: gy, cascade: f._cascadeFace });
      }
    }
  }
  lines.push(`Pipeline figures whose merged **faceBox** centre landed in the lower half of the frame (likely on torso/legs, not face):`);
  lines.push('');
  lines.push(`| Page | Char | merged yCenter | pipeline-recorded gemini yCenter | cascade source |`);
  lines.push(`|---|---|---|---|---|`);
  for (const b of bad) {
    lines.push(`| ${b.page} | ${b.name} | ${b.merged.toFixed(3)} | ${b.gemini != null ? b.gemini.toFixed(3) : 'n/a'} | ${b.cascade || 'n/a'} |`);
  }
  lines.push('');

  // Fresh Gemini alone
  const freshLowerHalf = [];
  for (const fe of freshResults) {
    const figs = fe.detection?.figures || [];
    for (const f of figs) {
      if (!named.has(f.name)) continue;
      const fb = normBbox(f.face_box || f.faceBox);
      const fy = yCenter(fb);
      if (fy != null && fy >= 0.5) freshLowerHalf.push({ page: fe.page, name: f.name, y: fy });
    }
  }
  // Merge mechanism note
  lines.push(`### Why the merged faceBox is so often oversized / displaced`);
  lines.push('');
  lines.push(`See \`server/lib/entityConsistency.js::mergeCascadeFacesWithGemini\` (lines 118–194). When a cascade face matches a Gemini figure, the code replaces the original tight Gemini \`faceBox\` with the cascade's **paddedBox**:`);
  lines.push('');
  lines.push('```js');
  lines.push('const newFace = [');
  lines.push('  cf.paddedBox.y / imgHeight,                          // ymin');
  lines.push('  cf.paddedBox.x / imgWidth,                           // xmin');
  lines.push('  (cf.paddedBox.y + cf.paddedBox.height) / imgHeight,  // ymax');
  lines.push('  (cf.paddedBox.x + cf.paddedBox.width) / imgWidth,    // xmax');
  lines.push('];');
  lines.push('fig.faceBox = newFace;');
  lines.push('```');
  lines.push('');
  lines.push(`The cascade's \`paddedBox\` = tight face + \`pad_percent\` (default 60%) on each side. A 100×100 face becomes a 260×260 box. When the underlying tight face is ~10–15% of the frame height, the padded replacement is 25–40% of the frame height — and since the padding is symmetrical from the face centre, the padded box extends well into the torso. That matches the height-inflation pattern observed above.`);
  lines.push('');
  lines.push(`Additionally, the match condition (lines 145–154) accepts any cascade face whose **centre is within 1.5× body widths horizontally** and penalizes vertical distance only if it's > 0.3 body heights below the body top. Haar cascade false positives on clothing folds / chest shadows in the lower torso can slip past this filter (seen on p7 Manuel, cascade="haar_only", merged yCenter 0.704 vs Gemini 0.361).`);
  lines.push('');
  lines.push(`For comparison — **fresh Gemini alone** (same prompt, re-run now) puts the face in the lower half for these cases:`);
  lines.push('');
  if (!freshLowerHalf.length) {
    lines.push(`(none)`);
  } else {
    lines.push(`| Page | Char | fresh gemini yCenter |`);
    lines.push(`|---|---|---|`);
    for (const b of freshLowerHalf) lines.push(`| ${b.page} | ${b.name} | ${b.y.toFixed(3)} |`);
  }
  lines.push('');

  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), lines.join('\n'));
  console.log('Wrote report.md');
})().catch(e => { console.error(e); process.exit(1); });
