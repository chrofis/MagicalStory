#!/usr/bin/env node
/**
 * Dry-run: compare unified-prompt output in MARKDOWN mode vs TOOL-USE JSON mode.
 *
 * Calls Sonnet twice on the SAME filled prompt — first with the production
 * markdown-marker output instructions, second with a tool-use schema that
 * forces structured JSON. Saves both responses + diff to drafts/json-dryrun/.
 *
 * No production code paths touched. No DB writes. Single read from stories
 * table to fetch a real filled prompt from the latest story.
 *
 * Usage:
 *   node scripts/test-json-output.js --fetch-latest               # pull prompt from latest DB story
 *   node scripts/test-json-output.js --prompt-file=path/to/p.txt  # use a local prompt
 *   node scripts/test-json-output.js --skip-markdown              # only run JSON mode
 *   node scripts/test-json-output.js --skip-json                  # only run markdown mode
 *   node scripts/test-json-output.js --max-tokens=16000           # default 32000
 *
 * Cost per run: ~$0.50–$1.50 per mode (depends on filled prompt size + story length).
 */

'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);

const SONNET_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = parseInt(args['max-tokens'] || '32000', 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY missing in .env');
  process.exit(1);
}

const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT_DIR = path.resolve(__dirname, '..', 'drafts', 'json-dryrun', STAMP);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ───────────────────────────────────────────────────────────────────────────
// JSON SCHEMA for tool-use mode. Mirrors the unified prompt's output shape.
// Designed loose-enough that Sonnet can express what it needs; strict on the
// structural fields (page count, required metadata fields).
// ───────────────────────────────────────────────────────────────────────────
const EMIT_UNIFIED_STORY_TOOL = {
  name: 'emit_unified_story',
  description: 'Emit the complete unified story output: title, clothing requirements, visual bible, and one entry per page with text + scene prose + metadata.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Story title.' },
      clothingRequirements: {
        type: 'object',
        description: 'Per-character clothing categories used across the story. Keyed by character name. Each character has standard/winter/summer/costumed sub-objects with a description + usedOnPages array.',
        additionalProperties: {
          type: 'object',
          properties: {
            standard: { type: 'object', properties: { description: { type: 'string' }, usedOnPages: { type: 'array', items: { type: 'integer' } } } },
            winter:   { type: 'object', properties: { description: { type: 'string' }, usedOnPages: { type: 'array', items: { type: 'integer' } } } },
            summer:   { type: 'object', properties: { description: { type: 'string' }, usedOnPages: { type: 'array', items: { type: 'integer' } } } },
            costumed: { type: 'object', properties: { costume: { type: 'string' }, description: { type: 'string' }, usedOnPages: { type: 'array', items: { type: 'integer' } } } }
          }
        }
      },
      visualBible: {
        type: 'object',
        description: 'Canonical visual entities for image generation. Each list contains entities of that type with id (CHR001, LOC001, etc.), name, and a free-form description object with appearance details.',
        properties: {
          mainCharacters:      { type: 'array', items: { type: 'object' } },
          secondaryCharacters: { type: 'array', items: { type: 'object' } },
          animals:             { type: 'array', items: { type: 'object' } },
          artifacts:           { type: 'array', items: { type: 'object' } },
          locations:           { type: 'array', items: { type: 'object' } },
          vehicles:            { type: 'array', items: { type: 'object' } },
          clothing:            { type: 'array', items: { type: 'object' } },
          changeLog:           { type: 'array', items: { type: 'object' } }
        }
      },
      pages: {
        type: 'array',
        description: 'One entry per story page, in order from 1 to N.',
        items: {
          type: 'object',
          properties: {
            pageNumber: { type: 'integer', description: '1-based page index.' },
            text: { type: 'string', description: 'The story prose shown on this page. Match the reading-level word count.' },
            scene: { type: 'string', description: '250-350 word image-prompt prose (the SCENE block). One continuous paragraph describing the single moment to illustrate.' },
            metadata: {
              type: 'object',
              description: 'Structured scene metadata consumed by the image pipeline.',
              properties: {
                sceneIntent: { type: 'string' },
                characters: { type: 'array', items: { type: 'object' } },
                objects: { type: 'array', items: { type: 'string' } },
                interactions: { type: 'array', items: { type: 'object' } },
                background: { type: 'string' },
                setting: { type: 'string', enum: ['indoor', 'outdoor'] },
                time: { type: 'string', enum: ['morning', 'midday', 'afternoon', 'sunset', 'night'] },
                weather: { type: 'string', enum: ['sunny', 'cloudy', 'rainy', 'snowy', 'n/a'] },
                shot: { type: 'string', enum: ['close-up', 'medium', 'wide', 'ultra-wide'] },
                framingPattern: { type: 'string', enum: ['solo-before', 'solo-after', 'over-the-shoulder', 'side'] },
                textPosition: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-full', 'bottom-full'] },
                textZoneDescription: { type: 'string' },
                era: { type: 'string' },
                landmarkContext: { type: 'string' },
                emptyScenePrompt: { type: 'string' }
              },
              required: ['sceneIntent', 'characters', 'shot', 'setting', 'time', 'textPosition', 'emptyScenePrompt']
            }
          },
          required: ['pageNumber', 'text', 'scene', 'metadata']
        }
      }
    },
    required: ['title', 'pages', 'visualBible', 'clothingRequirements']
  }
};

// ───────────────────────────────────────────────────────────────────────────
// Prompt-fetching helpers
// ───────────────────────────────────────────────────────────────────────────
async function fetchLatestPromptFromDb() {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL not set');
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    const res = await pool.query(
      `SELECT id, data->'outlinePrompt' AS prompt, data->>'title' AS title
       FROM stories WHERE data->'outlinePrompt' IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`
    );
    if (!res.rows.length) throw new Error('No story with outlinePrompt found');
    return { storyId: res.rows[0].id, title: res.rows[0].title, prompt: res.rows[0].prompt };
  } finally {
    await pool.end();
  }
}

function loadPromptFromFile(p) {
  if (!fs.existsSync(p)) throw new Error(`Prompt file not found: ${p}`);
  const content = fs.readFileSync(p, 'utf-8');
  return { storyId: null, title: null, prompt: content };
}

// ───────────────────────────────────────────────────────────────────────────
// Markdown-mode → strip out the tool-use instruction if present (we never add
// one in markdown mode, so this is a no-op for a stock prompt). Returns the
// prompt verbatim.
// ───────────────────────────────────────────────────────────────────────────
function buildMarkdownPrompt(basePrompt) {
  return basePrompt;
}

// ───────────────────────────────────────────────────────────────────────────
// Tool-use-mode → append an instruction that tells Sonnet to emit via the
// tool instead of writing markdown markers. The existing prompt's instructions
// about WHAT to write (character details, prose rules, metadata fields) stay
// verbatim — only the OUTPUT FORMAT changes.
// ───────────────────────────────────────────────────────────────────────────
function buildJsonPrompt(basePrompt) {
  const suffix = `

---
**OUTPUT FORMAT OVERRIDE**

Disregard every prior instruction about writing \`--- Page N ---\` markers,
\`TEXT:\` / \`SCENE:\` / \`METADATA:\` section labels, \`---TITLE---\`,
\`---CLOTHING REQUIREMENTS---\`, \`---VISUAL BIBLE---\`, \`---STORY PAGES---\`,
or any other dashed section header.

Instead, emit your ENTIRE output as a single call to the \`emit_unified_story\`
tool. The tool's schema captures the same structure you would have written in
markdown:

- \`title\` ← the story title
- \`clothingRequirements\` ← the same per-character clothing object
- \`visualBible\` ← the same nested Visual Bible structure
- \`pages[]\` ← one entry per page, with:
  - \`pageNumber\` (integer)
  - \`text\` (the page's story prose)
  - \`scene\` (the 250–350 word image-prompt prose)
  - \`metadata\` (the full per-page METADATA JSON object)

All prose rules (character lock, body-facing vocabulary, depth/position rules,
text-zone constraints, etc.) still apply to the strings inside the tool call.
The tool call is the only output — do not emit any markdown around it.

You MUST call \`emit_unified_story\` exactly once.`;
  return basePrompt + suffix;
}

// ───────────────────────────────────────────────────────────────────────────
// Anthropic calls. Direct HTTP — does NOT go through textModels.js (which
// doesn't support tools yet). This is intentional for the dry-run.
// ───────────────────────────────────────────────────────────────────────────
// Streaming. Headers come back fast (sidesteps Node's 5-min headersTimeout);
// we accumulate content blocks as they arrive and reconstruct a non-streaming-
// shaped response object at the end. This mirrors what production does.
async function callAnthropic(prompt, { useTool }) {
  const body = {
    model: SONNET_MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useTool) {
    body.tools = [EMIT_UNIFIED_STORY_TOOL];
    body.tool_choice = { type: 'tool', name: EMIT_UNIFIED_STORY_TOOL.name };
  }

  const bodyJson = JSON.stringify(body);
  console.log(`    sending ${(bodyJson.length / 1024).toFixed(1)} KB (streaming)`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'accept': 'text/event-stream'
      },
      body: bodyJson,
      signal: AbortSignal.timeout(900_000),
    });
  } catch (fetchErr) {
    const cause = fetchErr.cause?.message || fetchErr.cause?.code || '';
    throw new Error(`fetch failed: ${fetchErr.message} | cause: ${cause}`);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 800)}`);
  }

  // Accumulate stream → reconstruct content array + usage.
  const contentBlocks = [];   // index → { type, text?, name?, partialInputJson? }
  let usage = { input_tokens: 0, output_tokens: 0 };
  let lastProgressAt = t0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'message_start') {
        usage = { ...usage, ...(evt.message?.usage || {}) };
      } else if (evt.type === 'content_block_start') {
        contentBlocks[evt.index] = { ...evt.content_block, partialInputJson: '' };
      } else if (evt.type === 'content_block_delta') {
        const block = contentBlocks[evt.index] || {};
        if (evt.delta?.type === 'text_delta') {
          block.text = (block.text || '') + evt.delta.text;
        } else if (evt.delta?.type === 'input_json_delta') {
          block.partialInputJson = (block.partialInputJson || '') + (evt.delta.partial_json || '');
        }
        contentBlocks[evt.index] = block;
      } else if (evt.type === 'message_delta') {
        if (evt.usage) usage = { ...usage, ...evt.usage };
      }
      // Progress heartbeat
      const now = Date.now();
      if (now - lastProgressAt > 10_000) {
        const elapsed = ((now - t0) / 1000).toFixed(0);
        const collectedChars = contentBlocks.reduce((sum, b) => sum + ((b?.text?.length || 0) + (b?.partialInputJson?.length || 0)), 0);
        console.log(`    [${elapsed}s] streaming… ${collectedChars} chars collected`);
        lastProgressAt = now;
      }
    }
  }
  const ms = Date.now() - t0;

  // Reconstruct content array in non-streaming shape
  const content = contentBlocks.filter(Boolean).map(b => {
    if (b.type === 'tool_use') {
      let parsedInput = null;
      try { parsedInput = JSON.parse(b.partialInputJson || '{}'); } catch (e) {
        throw new Error(`Could not parse tool_use input JSON (${(b.partialInputJson || '').length} chars): ${e.message}`);
      }
      return { type: 'tool_use', id: b.id, name: b.name, input: parsedInput };
    }
    return { type: b.type, text: b.text || '' };
  });

  const data = { content, usage, stop_reason: 'end_turn' };
  return { data, ms };
}

function extractMarkdownText(apiResponse) {
  // Text-mode response: data.content[0].text
  const block = apiResponse.content.find(c => c.type === 'text');
  return block ? block.text : '';
}

function extractToolInput(apiResponse) {
  // Tool-use response: data.content[*].type === 'tool_use', .input is the parsed object
  const block = apiResponse.content.find(c => c.type === 'tool_use');
  if (!block) throw new Error('No tool_use block in response');
  return block.input;
}

// ───────────────────────────────────────────────────────────────────────────
// Quick structural diff. Doesn't try to parse the markdown — just counts
// page-marker hits via regex (matches the production parser's broadened
// regex from commit 9f71b727).
// ───────────────────────────────────────────────────────────────────────────
function countMarkdownPages(text) {
  const matches = text.match(/(?:---\s*Page\s+\d+\s*---|##\s*Page\s+\d+|#{1,3}\s*Page\s+\d+|\*\*\s*Page\s+\d+\s*\*\*)/gi);
  return matches ? matches.length : 0;
}

function summarize(mdResult, jsonResult, baseStoryId) {
  const lines = [];
  lines.push(`# JSON-vs-Markdown Dry Run — ${STAMP}`);
  lines.push('');
  lines.push(`Source story id: ${baseStoryId || 'N/A (file-loaded)'}`);
  lines.push('');
  lines.push('## Per-mode result');
  lines.push('');
  lines.push('| Mode | Wall time | Input tokens | Output tokens | $ (est) | Page count | Valid? |');
  lines.push('|------|-----------|--------------|---------------|---------|------------|--------|');

  for (const [label, r] of [['markdown', mdResult], ['json', jsonResult]]) {
    if (!r) { lines.push(`| ${label} | (skipped) | - | - | - | - | - |`); continue; }
    const { ms, data, valid, pageCount } = r;
    const inT = data.usage?.input_tokens ?? 0;
    const outT = data.usage?.output_tokens ?? 0;
    // Sonnet 4 pricing: $3/M input, $15/M output (placeholder — verify before billing)
    const cost = (inT * 3 + outT * 15) / 1_000_000;
    lines.push(`| ${label} | ${(ms/1000).toFixed(1)}s | ${inT.toLocaleString()} | ${outT.toLocaleString()} | $${cost.toFixed(4)} | ${pageCount ?? 'n/a'} | ${valid ? '✅' : '❌'} |`);
  }

  if (mdResult && jsonResult) {
    lines.push('');
    lines.push('## Structural diff');
    lines.push(`- Markdown pages: ${mdResult.pageCount}`);
    lines.push(`- JSON pages: ${jsonResult.pageCount}`);
    lines.push(`- Match: ${mdResult.pageCount === jsonResult.pageCount ? '✅' : `❌ (Δ=${mdResult.pageCount - jsonResult.pageCount})`}`);

    if (jsonResult.parsed?.pages?.[0] && mdResult.markdownText) {
      lines.push('');
      lines.push('## Page 1 prose side-by-side (first 500 chars)');
      const mdPage1Match = mdResult.markdownText.match(/(?:---\s*Page\s+1\s*---|##\s*Page\s+1)([\s\S]*?)(?=(?:---\s*Page\s+2|##\s*Page\s+2)|$)/i);
      const mdPage1 = mdPage1Match ? mdPage1Match[1].trim() : '(could not extract page 1)';
      const jsonPage1 = JSON.stringify(jsonResult.parsed.pages[0], null, 2);
      lines.push('');
      lines.push('### Markdown page 1 (raw):');
      lines.push('```');
      lines.push(mdPage1.slice(0, 500));
      lines.push('```');
      lines.push('');
      lines.push('### JSON page 1 (parsed):');
      lines.push('```');
      lines.push(jsonPage1.slice(0, 1000));
      lines.push('```');
    }
  }

  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('═══ JSON-output dry run ═══════════════════════════════════');
  console.log(`Output dir: ${OUT_DIR}`);

  let promptSource;
  if (args['prompt-file']) {
    console.log(`Loading prompt from: ${args['prompt-file']}`);
    promptSource = loadPromptFromFile(args['prompt-file']);
  } else if (args['fetch-latest']) {
    console.log('Fetching latest story\'s outlinePrompt from DB…');
    promptSource = await fetchLatestPromptFromDb();
    console.log(`  → story ${promptSource.storyId} (${promptSource.title})`);
  } else {
    console.error('Either --fetch-latest or --prompt-file=PATH is required.');
    process.exit(2);
  }

  const basePrompt = String(promptSource.prompt);
  const promptChars = basePrompt.length;
  console.log(`Base prompt: ${promptChars.toLocaleString()} chars`);
  fs.writeFileSync(path.join(OUT_DIR, 'base-prompt.txt'), basePrompt);

  let mdResult = null;
  let jsonResult = null;

  // Run markdown mode
  if (args['skip-markdown'] !== 'true') {
    console.log('\n→ MARKDOWN mode call…');
    const mdPrompt = buildMarkdownPrompt(basePrompt);
    fs.writeFileSync(path.join(OUT_DIR, 'markdown-prompt.txt'), mdPrompt);
    try {
      const { data, ms } = await callAnthropic(mdPrompt, { useTool: false });
      const text = extractMarkdownText(data);
      fs.writeFileSync(path.join(OUT_DIR, 'markdown-response.txt'), text);
      fs.writeFileSync(path.join(OUT_DIR, 'markdown-raw.json'), JSON.stringify(data, null, 2));
      const pageCount = countMarkdownPages(text);
      console.log(`  ✓ ${(ms/1000).toFixed(1)}s, ${data.usage.input_tokens} in / ${data.usage.output_tokens} out, ${pageCount} page markers`);
      mdResult = { data, ms, valid: text.length > 0, pageCount, markdownText: text };
    } catch (err) {
      console.error(`  ✗ MARKDOWN call failed: ${err.message}`);
      mdResult = { data: { usage: {} }, ms: 0, valid: false, pageCount: 0, markdownText: '', error: err.message };
    }
  }

  // Run JSON tool-use mode
  if (args['skip-json'] !== 'true') {
    console.log('\n→ JSON tool-use mode call…');
    const jsonPrompt = buildJsonPrompt(basePrompt);
    fs.writeFileSync(path.join(OUT_DIR, 'json-prompt.txt'), jsonPrompt);
    try {
      const { data, ms } = await callAnthropic(jsonPrompt, { useTool: true });
      fs.writeFileSync(path.join(OUT_DIR, 'json-raw.json'), JSON.stringify(data, null, 2));
      const parsed = extractToolInput(data);
      fs.writeFileSync(path.join(OUT_DIR, 'json-parsed.json'), JSON.stringify(parsed, null, 2));
      const pageCount = parsed?.pages?.length || 0;
      console.log(`  ✓ ${(ms/1000).toFixed(1)}s, ${data.usage.input_tokens} in / ${data.usage.output_tokens} out, ${pageCount} pages in tool output`);
      jsonResult = { data, ms, valid: true, pageCount, parsed };
    } catch (err) {
      console.error(`  ✗ JSON call failed: ${err.message}`);
      jsonResult = { data: { usage: {} }, ms: 0, valid: false, pageCount: 0, error: err.message };
    }
  }

  const report = summarize(mdResult, jsonResult, promptSource.storyId);
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), report);
  console.log('\n' + '═'.repeat(60));
  console.log(report);
  console.log('═'.repeat(60));
  console.log(`\nAll outputs saved to: ${OUT_DIR}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
