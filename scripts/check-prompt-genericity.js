#!/usr/bin/env node
/**
 * Genericity check for prompts/*.txt — run after ANY prompt edit, before
 * committing. Prompts run on every story, so they must contain archetypes
 * only ("the main character", "a vehicle"), never names, places, or plot
 * objects from a specific (test) story.
 *
 * Two layers:
 *   1. Proper-noun scan: repeated capitalized tokens that are not template
 *      keywords or sentence-start words — listed for human review.
 *   2. Optional model check (--llm): asks the configured text model to flag
 *      story-specific wording per file (needs .env keys).
 *
 * Usage:
 *   node scripts/check-prompt-genericity.js            # changed files vs HEAD
 *   node scripts/check-prompt-genericity.js --all      # every prompt file
 *   node scripts/check-prompt-genericity.js --llm      # add the model layer
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const args = process.argv.slice(2);
const useAll = args.includes('--all');
const useLlm = args.includes('--llm');

// Template/formatting words that are legitimately capitalized mid-sentence.
const ALLOW = new Set([
  'JSON', 'CRITICAL', 'MAJOR', 'MINOR', 'MODERATE', 'CATASTROPHIC', 'PASS', 'FAIL', 'SOFT_FAIL',
  'IMPORTANT', 'NEVER', 'ALWAYS', 'MUST', 'DO', 'NOT', 'ONLY', 'ALL', 'THE', 'THIS', 'IMAGE',
  'DEPICTS', 'STEP', 'STAGE', 'SCENE', 'INTENT', 'STORY_TEXT', 'IMAGE_PROMPT', 'VISION_INVENTORY',
  'ORIGINAL_PROMPT', 'DECLARED', 'INTERACTIONS', 'EXPECTED', 'CHARACTERS', 'OBJECTS', 'COPY', 'SPACE',
  'English', 'German', 'French', 'Italian', 'Art', 'Director', 'Visual', 'Bible',
]);

function properNouns(text) {
  const counts = new Map();
  // Words starting uppercase that are NOT at sentence start and not in ALLOW /
  // not {{PLACEHOLDER}} tokens.
  for (const m of text.matchAll(/(?<![.!?:\n\-•*]\s{0,3})(?<=\s)([A-Z][a-zäöüéèà]{2,})\b/g)) {
    const w = m[1];
    if (ALLOW.has(w) || ALLOW.has(w.toUpperCase())) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function llmCheck(file, text) {
  require('dotenv').config();
  const { callTextModel } = require('../server/lib/textModels');
  const res = await callTextModel(
    `You review a prompt template that runs on EVERY story of a children's-book generator. Flag wording that is specific to one story or scene: character names, place names, plot objects, or rules that only fit a single situation. Broad archetypes (a guard, the main character, a vehicle) are fine. Template:\n\n${text.slice(0, 12000)}\n\nReply JSON only: {"generic": true|false, "issues": ["..."]}.`,
    600, null, { usageLabel: 'genericity_check' }
  );
  const m = String(res.text || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { generic: true, issues: [] };
}

(async () => {
  let files;
  if (useAll) {
    files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.txt')).map(f => path.join(PROMPTS_DIR, f));
  } else {
    const changed = execSync('git diff --name-only HEAD -- prompts/ && git diff --name-only --cached -- prompts/', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    files = [...new Set(changed)].map(f => path.join(__dirname, '..', f)).filter(f => fs.existsSync(f));
    if (files.length === 0) { console.log('No changed prompt files vs HEAD. Use --all to scan everything.'); return; }
  }

  let flagged = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const nouns = properNouns(text);
    const suspicious = nouns.filter(([, n]) => n >= 1);
    let llm = null;
    if (useLlm) { try { llm = await llmCheck(file, text); } catch (e) { llm = { error: e.message }; } }
    const hasIssue = suspicious.length > 0 || (llm && llm.generic === false);
    if (hasIssue) flagged++;
    console.log(`\n${path.basename(file)}${hasIssue ? '  ⚠️' : '  ✓'}`);
    if (suspicious.length) console.log(`  capitalized non-template words (review each): ${suspicious.map(([w, n]) => `${w}×${n}`).join(', ')}`);
    if (llm?.issues?.length) llm.issues.forEach(i => console.log(`  model: ${i}`));
    if (llm?.error) console.log(`  model check failed: ${llm.error}`);
  }
  console.log(`\n${flagged === 0 ? 'All checked prompts look generic.' : `${flagged} file(s) need review — names/places/plot objects do not belong in prompts.`}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
