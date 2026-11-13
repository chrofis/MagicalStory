#!/usr/bin/env node
'use strict';
/**
 * One-off clean of stored `physical.other` ("Sonstiges"), docs/decisions.md 2026-11-13.
 *
 * Older photo analyses wrote glasses, facial hair, face shape and expression into the free-text
 * `other`, which every page and avatar prompt prints verbatim, so a customer who set glasses = none
 * still got glasses. prompts/character-analysis.txt now keeps `other` to marks with no field of
 * their own. This script re-runs THAT prompt on each character's stored original photo and takes the
 * model's new "distinctive markings" as the new `other`. Code never reads the old text: the model
 * decides what remains.
 *
 * Usage
 *   node scripts/admin/clean-physical-other.js [--ids=charId,charId] [--limit=N] [--max-spend=USD]
 *        [--exclude-user=userId,userId] [--plan-out=file]          (dry run: reads production, calls the
 *                                                                    model, writes the plan file, writes NO row)
 *   node scripts/admin/clean-physical-other.js --write --plan=file [--exclude-user=...]
 *                                                                   (applies a reviewed plan, no model call;
 *                                                                    backs the rows up to
 *                                                                    tasks/customer-physical-other-before-clean-<ts>.json)
 * A plan entry is applied only while the stored `other` still equals the value the plan recorded.
 * Characters whose `other` the customer typed themselves (physicalTraitsSource.other === 'user') are skipped.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { isNone } = require('../../server/lib/traitNone');

const NONE = 'none';
// Gemini 2.5 Flash list price, USD per million tokens (https://ai.google.dev/gemini-api/docs/pricing).
const PRICE_IN = 0.30;
const PRICE_OUT = 2.50;
// Gemini 2.5 Flash-Lite, same page: the screening call.
const SCREEN_PRICE_IN = 0.10;
const SCREEN_PRICE_OUT = 0.40;

function arg(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

/**
 * What the new photo reading means for one stored character. Pure: `physical` / `sources` are the
 * stored values, `traits` the new analysis `traits` object.
 * - other: the model's new distinctive markings ('none' when it lists none).
 * - glasses / facialHair: filled from the reading ONLY where the stored character has no value at all
 *   (a stored value, extracted or typed, is never overridden), so a fact the old text carried is not lost
 *   when it leaves `other`.
 */
function buildChange(physical, sources, traits) {
  const p = physical || {};
  const src = sources || {};
  if (src.other === 'user') return { skip: 'other typed by the customer' };
  if (isNone(p.other)) return { skip: 'other already empty' };
  const raw = traits && (traits['distinctive markings'] ?? traits.other);
  if (raw === undefined || raw === null) return { skip: 'new reading has no distinctive markings field' };
  const newOther = isNone(raw) ? NONE : String(raw).trim();
  const set = {};
  for (const f of ['glasses', 'facialHair']) {
    const v = traits[f];
    if (p[f] === undefined && src[f] !== 'user' && v !== undefined && v !== null && String(v).trim() !== '') set[f] = String(v).trim();
  }
  if (newOther === String(p.other).trim() && !Object.keys(set).length) return { skip: 'unchanged' };
  return { oldOther: p.other, newOther, set };
}

function costOf(usage) {
  if (!usage) return 0;
  return ((usage.inputTokens || 0) * PRICE_IN + ((usage.outputTokens || 0) + (usage.thinkingTokens || 0)) * PRICE_OUT) / 1e6;
}

async function connect(readOnly) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  if (readOnly) await client.query('SET default_transaction_read_only = on');
  return { pool, client };
}

async function loadCandidates(client, { ids, excludeUsers }) {
  const r = await client.query(`
    SELECT c.id AS row_id, c.user_id, ch.ord - 1 AS idx, ch.c->>'id' AS char_id,
           ch.c->'physical' AS physical, ch.c->'physicalTraitsSource' AS sources,
           ch.c->'photos'->>'original' AS photo
      FROM characters c, jsonb_array_elements(c.data->'characters') WITH ORDINALITY ch(c, ord)
     WHERE ch.c->'physical'->>'other' IS NOT NULL`);
  return r.rows.filter(x => !excludeUsers.includes(x.user_id)
    && (!ids.length || ids.includes(x.char_id))
    && !isNone(x.physical.other));
}

async function dryRun() {
  const ids = list(arg('ids'));
  const excludeUsers = list(arg('exclude-user'));
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const maxSpend = arg('max-spend') ? Number(arg('max-spend')) : 0;
  if (!(maxSpend > 0)) throw new Error('dry run calls a paid model: pass --max-spend=<USD>');
  const { extractTraitsWithGeminiOnce } = require('../../server/routes/avatars');
  const r2 = require('../../server/lib/r2');
  // The analysis falls back to a one-line inline prompt when the templates are not loaded.
  await require('../../server/services/prompts').loadPromptTemplates();
  const { pool, client } = await connect(true);
  const plan = [];
  let spend = 0, done = 0, stopped = null;
  try {
    let cands = await loadCandidates(client, { ids, excludeUsers });
    const total = cands.length;
    if (!ids.length) {
      // One cheap text call per batch: the model, not this code, decides which notes state a fact that has its own field.
      const { callTextModel } = require('../../server/lib/textModels');
      const { PROMPT_TEMPLATES, fillTemplate } = require('../../server/services/prompts');
      const flagged = new Set();
      for (let i = 0; i < cands.length; i += 60) {
        const entries = cands.slice(i, i + 60).map(c => JSON.stringify({ id: c.char_id, text: c.physical.other })).join('\n');
        const reply = await callTextModel(fillTemplate(PROMPT_TEMPLATES.physicalOtherScreen, { ENTRIES: entries }), null, 'gemini-2.5-flash-lite', { usageLabel: 'physical-other-screen' });
        const u = reply.usage || {};
        spend += ((u.input_tokens || 0) * SCREEN_PRICE_IN + ((u.output_tokens || 0) + (u.thinking_tokens || 0)) * SCREEN_PRICE_OUT) / 1e6;
        for (const id of JSON.parse(reply.text.match(/\{[\s\S]*\}/)[0]).ids) flagged.add(String(id));
      }
      cands = cands.filter(c => flagged.has(c.char_id));
    }
    cands = cands.slice(0, limit);
    console.log(`${cands.length} of ${total} characters with a non-empty other flagged for re-reading (not typed by the customer)`);
    for (const c of cands) {
      if (spend >= maxSpend) { stopped = `spend cap ${maxSpend} reached`; break; }
      if (c.sources?.other === 'user') { continue; }
      const bytes = c.photo ? await r2.bytesFromAnyImage(c.photo) : null;
      if (!bytes) { plan.push({ userId: c.user_id, charId: c.char_id, error: 'no readable original photo' }); continue; }
      const res = await extractTraitsWithGeminiOnce(`data:image/jpeg;base64,${bytes.toString('base64')}`);
      spend += costOf(res && res._usage);
      done++;
      if (!res || !res.traits) { plan.push({ userId: c.user_id, charId: c.char_id, error: 'analysis returned no traits' }); continue; }
      const ch = buildChange(c.physical, c.sources, res.traits);
      if (ch.skip) { plan.push({ userId: c.user_id, charId: c.char_id, skipped: ch.skip }); continue; }
      plan.push({ userId: c.user_id, rowId: c.row_id, charId: c.char_id, idx: c.idx, ...ch });
    }
  } finally { client.release(); await pool.end(); }
  const out = arg('plan-out') || path.join('tasks', `customer-physical-other-plan-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ spendUsd: spend, stopped, plan }, null, 2));
  const changes = plan.filter(p => p.newOther !== undefined);
  console.log(`analysed ${done}, to change ${changes.length}, skipped ${plan.filter(p => p.skipped).length}, errors ${plan.filter(p => p.error).length}, spend USD ${spend.toFixed(4)}${stopped ? ' STOPPED: ' + stopped : ''}`);
  console.log(`plan: ${out}`);
  for (const p of changes) {
    console.log(`user=${p.userId} char=${p.charId} oldLen=${String(p.oldOther).length} new=${JSON.stringify(p.newOther)}${Object.keys(p.set).length ? ' fill=' + JSON.stringify(p.set) : ''}`);
  }
}

async function write() {
  const planFile = arg('plan');
  if (!planFile) throw new Error('--write needs --plan=<file from a dry run>');
  const excludeUsers = list(arg('exclude-user'));
  const { plan } = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const todo = plan.filter(p => p.newOther !== undefined && !excludeUsers.includes(p.userId));
  const { pool, client } = await connect(false);
  const backup = [];
  let applied = 0, stale = 0;
  try {
    await client.query('BEGIN');
    for (const p of todo) {
      const row = await client.query('SELECT data FROM characters WHERE id = $1 FOR UPDATE', [p.rowId]);
      const chars = row.rows[0]?.data?.characters || [];
      const idx = chars.findIndex(c => c.id === p.charId);
      const phys = idx >= 0 ? chars[idx].physical : null;
      if (!phys || phys.other !== p.oldOther || chars[idx].physicalTraitsSource?.other === 'user') { stale++; continue; }
      backup.push({ rowId: p.rowId, userId: p.userId, charId: p.charId, physical: phys, physicalTraitsSource: chars[idx].physicalTraitsSource || null });
      const next = { ...phys, other: p.newOther, ...p.set };
      const src = { ...(chars[idx].physicalTraitsSource || {}), other: 'extracted' };
      for (const f of Object.keys(p.set)) src[f] = 'extracted';
      await client.query(
        `UPDATE characters SET data = jsonb_set(jsonb_set(data, ARRAY['characters',$2::text,'physical'], $3::jsonb),
                                                ARRAY['characters',$2::text,'physicalTraitsSource'], $4::jsonb) WHERE id = $1`,
        [p.rowId, String(idx), JSON.stringify(next), JSON.stringify(src)]);
      applied++;
    }
    const bak = path.join('tasks', `customer-physical-other-before-clean-${Date.now()}.json`);
    fs.writeFileSync(bak, JSON.stringify(backup, null, 2));
    await client.query('COMMIT');
    console.log(`applied ${applied}, stale (changed since the plan) ${stale}; backup ${bak}`);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); await pool.end(); }
}

if (require.main === module) {
  (process.argv.includes('--write') ? write() : dryRun()).catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
module.exports = { buildChange, costOf };
