#!/usr/bin/env node
/**
 * THE IDEA FUNNEL — how often the wizard's two story ideas get clicked, and how
 * often the customer throws both away and asks again.
 *
 * WHY (owner, 2026-09-21): the story-idea quality series optimised a RATER's
 * proxy for "would a parent buy this" across eight rounds, and a blind re-rate
 * showed the proxy is unreliable. The click is not a proxy. This script reads
 * the signal:
 *
 *   idea_events (migrations/039) — one row per generation, one per pick
 *   stories.data->'ideaPick'     — the same pick, on the story it became
 *
 * The two agree by construction (both written from the same create-story
 * payload); stories.data is reported alongside as the cross-check, and a gap
 * between them means events are being dropped, not that picks are.
 *
 *   node scripts/admin/idea-funnel.js [--staging] [--days=30]
 *        [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * All timestamps are Swiss local (CH), via scripts/lib/chTime.js — this repo
 * never shows UTC.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const STAGING = args.includes('--staging');
const flag = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const DAYS = flag('days') ? parseInt(flag('days'), 10) : 30;
const FROM = flag('from');
const TO = flag('to');

const pct = (n, d) => d > 0 ? `${(100 * n / d).toFixed(1)}%` : '—';
const pad = (s, w) => String(s ?? '').padEnd(w);
const padL = (s, w) => String(s ?? '').padStart(w);

/**
 * Rows -> one table's worth of counts. Pure, so the arithmetic is testable
 * without a database: every rate here is picks / generations-that-offered-that
 * cell, never picks / picks.
 *
 * keyOf may return a string, null, or an array (a generation offers TWO worlds
 * and TWO shapes, and belongs in both cells).
 *
 * @param {Array} gens   idea_generated rows
 * @param {Array} picks  idea_picked rows
 * @param {(row:object)=>string|string[]|null} keyOf
 * @returns {Array<{key:string, offered:number, picked:number, rate:string}>}
 */
function tabulate(gens, picks, keyOf) {
  const offered = new Map();
  const picked = new Map();
  const bump = (m, k) => { if (k !== null && k !== undefined) m.set(k, (m.get(k) || 0) + 1); };
  for (const g of gens) for (const k of [].concat(keyOf(g) ?? [])) bump(offered, k);
  for (const p of picks) for (const k of [].concat(keyOf(p) ?? [])) bump(picked, k);
  const keys = [...new Set([...offered.keys(), ...picked.keys()])].sort();
  return keys.map(key => ({
    key,
    offered: offered.get(key) || 0,
    picked: picked.get(key) || 0,
    rate: pct(picked.get(key) || 0, offered.get(key) || 0),
  }));
}

/** The world(s) a row belongs to: both arms for a generation, one for a pick. */
function worldKeys(r) {
  if (r.event === 'idea_generated') return Array.isArray(r.worlds) ? r.worlds : [];
  return r.worlds && r.worlds.world ? [r.worlds.world] : [];
}

/** The premise shape(s) a row belongs to, as "<id> <name>". */
function shapeKeys(r) {
  const label = s => (s && (s.id !== null && s.id !== undefined || s.name)) ? `${s.id} ${s.name}` : null;
  if (r.event === 'idea_generated') {
    return Array.isArray(r.shapes) ? r.shapes.map(label).filter(Boolean) : [];
  }
  const one = label(r.shapes);
  return one ? [one] : [];
}

/** The band the youngest character falls in (the age-band plot modes). */
function ageBand(youngest) {
  if (youngest === null || youngest === undefined) return '(unknown)';
  return youngest <= 4 ? '0-4' : youngest <= 6 ? '5-6' : youngest <= 9 ? '7-9' : '10+';
}

function printTable(title, rows, keyHeader = 'value') {
  console.log(`\n${title}`);
  console.log(`  ${pad(keyHeader, 26)}${padL('offered', 9)}${padL('picked', 9)}${padL('rate', 9)}`);
  if (!rows.length) { console.log('  (no rows)'); return; }
  for (const r of rows) {
    console.log(`  ${pad(r.key, 26)}${padL(r.offered, 9)}${padL(r.picked, 9)}${padL(r.rate, 9)}`);
  }
}

async function main() {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const where = [];
  const params = [];
  if (FROM) { params.push(FROM); where.push(`occurred_at >= $${params.length}::date`); }
  if (TO) { params.push(TO); where.push(`occurred_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (!FROM && !TO) { params.push(DAYS); where.push(`occurred_at > NOW() - ($${params.length} * INTERVAL '1 day')`); }

  const exists = await pool.query(`SELECT to_regclass('public.idea_events') AS t`);
  if (!exists.rows[0].t) {
    console.error('idea_events does not exist in this database. Apply migrations/039_idea_events.sql first:');
    console.error(`  node scripts/admin/apply-migration.js 039_idea_events.sql${STAGING ? ' --staging' : ''}`);
    await pool.end();
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT * FROM idea_events WHERE ${where.join(' AND ')} ORDER BY occurred_at`, params);

  const gens = rows.filter(r => r.event === 'idea_generated');
  const picks = rows.filter(r => r.event === 'idea_picked');

  const rangeLabel = (FROM || TO) ? `${FROM || 'start'} .. ${TO || 'now'}` : `last ${DAYS} days`;
  console.log(`\n=== IDEA FUNNEL — ${STAGING ? 'staging' : 'production'} — ${rangeLabel} ===`);
  if (!rows.length) { console.log('\n(no idea_events rows in this range)\n'); await pool.end(); return; }
  console.log(`    first row ${ch(rows[0].occurred_at)}   last row ${ch(rows[rows.length - 1].occurred_at)}`);

  // --- headline -------------------------------------------------------------
  const regens = gens.filter(g => g.regenerated).length;
  const firstAsks = gens.length - regens;
  const ownPremise = picks.filter(p => p.arm_index === null).length;
  const carded = picks.length - ownPremise;
  const cost = gens.reduce((s, g) => s + Number(g.cost_usd || 0), 0);
  console.log(`\nGENERATIONS       ${gens.length}   (first ask ${firstAsks}, regeneration ${regens} = ${pct(regens, gens.length)})`);
  console.log(`PICKS             ${picks.length}   (${pct(picks.length, gens.length)} of generations became a story)`);
  console.log(`  a card clicked  ${carded}   (${pct(carded, picks.length)} of picks)`);
  console.log(`  own premise     ${ownPremise}   (${pct(ownPremise, picks.length)} of picks — a verdict on the pair too)`);
  console.log(`MODEL COST        $${cost.toFixed(4)} over ${gens.length} generations ($${gens.length ? (cost / gens.length).toFixed(4) : '0.0000'}/generation)`);

  // --- per arm --------------------------------------------------------------
  // "offered" for an arm is every generation (both arms are always offered), so
  // the two arm rates sum to the card-click rate, not to 100%.
  printTable('PER ARM (which card, by position)', [0, 1].map(i => {
    const n = picks.filter(p => p.arm_index === i).length;
    return { key: `arm ${i}`, offered: gens.length, picked: n, rate: pct(n, gens.length) };
  }), 'arm');

  printTable('PER WORLD', tabulate(gens, picks, worldKeys), 'world');
  printTable('PER PREMISE SHAPE (prompts/premise-shapes.txt)', tabulate(gens, picks, shapeKeys), 'shape');
  printTable('PER CATEGORY', tabulate(gens, picks, r => r.category || '(none)'), 'category');
  printTable('PER LANGUAGE', tabulate(gens, picks, r => r.language || '(none)'), 'language');
  printTable('PER WORLD MODE (what the customer steered to)',
    tabulate(gens, picks, r => r.world_mode || 'auto'), 'worldMode');
  printTable('PER AGE BAND (youngest in the cast)',
    tabulate(gens, picks, r => ageBand(r.youngest_age)), 'youngest');

  // How deep customers go before they accept a pair. A pick rate that RISES
  // with attempt number means the ideas improve on rerun; a flat one means the
  // customer is only getting tired.
  printTable('PER ATTEMPT (1 = first pair shown)',
    tabulate(gens, picks, r => r.attempt ? `attempt ${Math.min(r.attempt, 5)}${r.attempt > 5 ? '+' : ''}` : '(unknown)'),
    'attempt');

  // --- cross-check against stories.data -------------------------------------
  const storyPicks = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE (data->'ideaPick'->>'index') IS NOT NULL)::int AS carded
       FROM stories
      WHERE data ? 'ideaPick'
        AND created_at > NOW() - ($1 * INTERVAL '1 day')`,
    [(FROM || TO) ? 3650 : DAYS]);
  const sp = storyPicks.rows[0];
  console.log(`\nCROSS-CHECK  stories.data->'ideaPick': ${sp.n} stories carry a pick (${sp.carded} clicked a card).`);
  console.log(`             idea_events idea_picked:  ${picks.length}.`);
  if (sp.n !== picks.length) {
    console.log('             They disagree — idea_events is best-effort by design, so the gap means dropped EVENTS, not dropped picks.');
  }
  console.log('');

  await pool.end();
}

module.exports = { tabulate, worldKeys, shapeKeys, ageBand };

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
