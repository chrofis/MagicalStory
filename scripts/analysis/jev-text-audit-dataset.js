#!/usr/bin/env node
/**
 * Build evals/datasets/jev-text-audit-v1/items.jsonl from the stored stories,
 * the hand-labelled real pages and the hand-written injections.
 *
 * Deterministic (seeded) — re-running produces the same file. $0, no network.
 *
 *   node scripts/analysis/jev-text-audit-dataset.js --extract   # pull story text from prod + staging (DATABASE_URL, STAGING_DATABASE_URL)
 *   node scripts/analysis/jev-text-audit-dataset.js             # build items.jsonl
 *
 * The story text is not committed (GDPR erasure; .gitignore): --extract rebuilds
 * stories/<id>.json from story_ids.json.
 *
 * Stories were pulled from prod + staging `stories.data` (storyText, writerText,
 * outline ---ARC--- / ---PAGE PLAN---, visualBible cast, sceneDescriptions)
 * into evals/datasets/jev-text-audit-v1/stories/<id>.json on 2026-09-27.
 * see docs/decisions.md 2026-09-27 "Jev text audit"
 */
const fs = require('fs');
const path = require('path');
const { splitParagraphs, splitSentences, buildMarkedStoryState, normalizeShot } = require('../../server/lib/jevAudit');

const DIR = path.join(__dirname, '../../evals/datasets/jev-text-audit-v1');

// ── --extract: stories.data → stories/<id>.json ──
function pagesOf(t) {
  if (!t) return [];
  const re = /(?:^|\n)(?:--- Page (\d+) ---|## Page (\d+))\s*\n/g;
  const idx = []; let m;
  while ((m = re.exec(t))) idx.push({ n: +(m[1] || m[2]), s: m.index, e: re.lastIndex });
  return idx.map((x, i) => ({ pageNumber: x.n, text: t.slice(x.e, i + 1 < idx.length ? idx[i + 1].s : t.length).trim().replace(/^TEXT:\s*/, '').split(/\nSCENE HINT:/)[0].trim() }));
}
function section(o, name) {
  if (!o) return null;
  const i = o.indexOf(`---${name}---`);
  if (i < 0) return null;
  const rest = o.slice(i + name.length + 6);
  const j = rest.search(/\n---[A-Z _]+---/);
  return (j < 0 ? rest : rest.slice(0, j)).trim();
}
function briefOf(sd) {
  const desc = String(sd.description || '');
  if (desc.includes('---METADATA---')) {
    let meta = {};
    try { meta = JSON.parse(desc.split('---METADATA---')[1]); } catch (e) { /* prose-only brief */ }
    return { pageNumber: sd.pageNumber, camera: meta.shot || null, imageSummary: sd.imageSummary || meta.sceneIntent || null, prose: desc.split('---METADATA---')[0].trim(), characters: (meta.characters || []).map(c => c.name) };
  }
  let j = null;
  try { j = JSON.parse(desc.replace(/^```json|```$/g, '')); } catch (e) { /* not JSON */ }
  const sc = j?.scene || j || {};
  return { pageNumber: sd.pageNumber, camera: sc.setting?.camera || null, imageSummary: sc.imageSummary || null, depthLayers: sc.setting?.depthLayers || null, characters: (sc.characters || []).map(c => c.name) };
}
async function extract() {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  const { Pool } = require('pg');
  const ids = JSON.parse(fs.readFileSync(path.join(DIR, 'story_ids.json'), 'utf8'));
  fs.mkdirSync(path.join(DIR, 'stories'), { recursive: true });
  for (const [env, url] of [['prod', process.env.DATABASE_URL], ['staging', process.env.STAGING_DATABASE_URL]]) {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    for (const id of ids[env]) {
      const r = await pool.query("select data->>'title' title, data->>'language' language, data->>'storyText' st, data->>'writerText' wt, data->>'outline' o, data->'characters' ch, data->'visualBible' vb, data->'sceneDescriptions' sd, data->>'trialMode' tm from stories where id=$1", [id]);
      const d = r.rows[0];
      if (!d) throw new Error(`story ${id} not found on ${env}`);
      const vb = d.vb || {};
      const cast = [
        ...(d.ch || []).map(c => ({ name: c.name, kind: 'main', age: c.age || null, gender: c.gender || null })),
        ...(vb.secondaryCharacters || []).map(c => ({ name: c.name, kind: 'secondary', description: [c.age, c.species].filter(Boolean).join(', ') })),
        ...(vb.animals || []).map(a => ({ name: a.name || a.label, kind: 'animal', description: [a.species, a.type, a.description].filter(Boolean).join(', ').slice(0, 200) })),
      ];
      const rec = { id, env, title: d.title, language: d.language, trial: d.tm === 'true', pages: pagesOf(d.st), writerPages: pagesOf(d.wt), arc: section(d.o, 'ARC'), pagePlan: section(d.o, 'PAGE PLAN'), cast, briefs: (d.sd || []).map(briefOf) };
      fs.writeFileSync(path.join(DIR, 'stories', `${id}.json`), JSON.stringify(rec, null, 1));
      console.log(env, id, rec.pages.length, 'pages');
    }
    await pool.end();
  }
}
if (process.argv.includes('--extract')) { extract().catch(e => { console.error(e); process.exit(1); }); return; }
const stories = fs.readdirSync(path.join(DIR, 'stories')).sort().map(f => JSON.parse(fs.readFileSync(path.join(DIR, 'stories', f), 'utf8')));
const byId = Object.fromEntries(stories.map(s => [s.id, s]));
const inj = JSON.parse(fs.readFileSync(path.join(DIR, 'injections.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(DIR, 'real_labels.json'), 'utf8'));

let seed = 20260927;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const lang2 = s => s.language.split('-')[0];
const para = t => t.replace(/ ¶ /g, '\n\n');
const items = [];
const push = it => items.push({ id: `i${String(items.length).padStart(5, '0')}`, ...it });

// ── labels of real pages ──
function realLabel(storyId, pageNumber) {
  const st = real.stories[storyId];
  if (!st) return null; // story not read in full: treated as unlabelled-clean
  const p = st.pages[String(pageNumber)];
  return { ids: p?.ids || [], borderline: p?.borderline || [] };
}
const idsOfCheck = (ids, prefix) => ids.filter(i => i.startsWith(prefix));
function isCleanFor(storyId, pageNumber, prefix) {
  const l = realLabel(storyId, pageNumber);
  return !l || (idsOfCheck(l.ids, prefix).length === 0 && idsOfCheck(l.borderline, prefix).length === 0);
}

function storyText(pages) { return pages.map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n'); }
function replacePage(pages, pageNumber, text) { return pages.map(p => (p.pageNumber === pageNumber ? { ...p, text } : p)); }
function paragraphOf(text, needle) { return splitParagraphs(text).find(p => p.includes(needle)) || null; }

// ── grammar mutations: one error in one sentence ──
const MUT = {
  de: {
    case: [[/\bmit dem\b/, 'mit den'], [/\bzum\b/, 'zur'], [/\bin der\b/, 'in den'], [/\bauf dem\b/, 'auf das'], [/\bvon der\b/, 'von die']],
    agree: [[/\b(Er|er) ([a-zäöü]+te)\b/, '$1 $2n'], [/\b(war er)\b/, 'waren er'], [/\b(hatte er)\b/, 'hatten er']],
    foreign: [[/ aber /, ' but '], [/ und /, ' and '], [/ sehr /, ' very ']],
    tense: [[/\b(Er|Sie) war\b/, '$1 ist'], [/\b(er|sie) hatte\b/, '$1 hat'], [/\bsagte (er|sie)\b/, 'sagt $1']],
  },
  fr: {
    case: [[/\bla porte\b/, 'le porte'], [/\ble chemin\b/, 'la chemin'], [/\bune petite\b/, 'un petit'], [/\bla ([a-zé]{4,})\b/, 'le $1'], [/\ble ([a-zé]{4,})\b/, 'la $1']],
    agree: [[/\bil a\b/, 'il ont'], [/\belle est\b/, 'elle sont'], [/\bils sont\b/, 'ils est'], [/\bIl ([a-zé]+e) /, 'Il $1nt ']],
    foreign: [[/ mais /, ' but '], [/ et /, ' and '], [/ très /, ' very ']],
    tense: [[/\b(il|elle) est\b/, '$1 fut'], [/\b(Il|Elle) regarde\b/, '$1 regardera']],
  },
  en: {
    case: [[/\ba ([bcdfgklmnprst][a-z]+)/, 'an $1'], [/\bhis\b/, 'her'], [/\bthem\b/, 'they']],
    agree: [[/\b(He|She|he|she) was\b/, '$1 were'], [/\b(They|they) were\b/, '$1 was'], [/\b(He|She) has\b/, '$1 have']],
    foreign: [[/ and /, ' und '], [/ but /, ' aber '], [/ very /, ' sehr ']],
    tense: [[/\b(He|She|he|she) (looked|walked|turned|said)\b/, (m, a, b) => `${a} ${({ looked: 'looks', walked: 'walks', turned: 'turns', said: 'says' })[b]}`]],
  },
};
function nonword(sentence) {
  const words = sentence.match(/[A-Za-zÀ-ÿäöüÄÖÜ]{9,}/g);
  if (!words) return null;
  const w = words[0];
  const mid = Math.floor(w.length / 2);
  return sentence.replace(w, w.slice(0, mid + 3) + w.slice(mid, mid + 3) + w.slice(mid + 3));
}
function mutateSentence(sentence, kind, lang) {
  if (/[«»"“”]/.test(sentence) && kind === 'tense') return null; // dialogue may be in any tense
  if (kind === 'nonword') return nonword(sentence);
  for (const [re, rep] of MUT[lang][kind] || []) {
    if (re.test(sentence)) {
      const out = sentence.replace(re, rep);
      if (out !== sentence) return out;
    }
  }
  return null;
}
const GRAM_KIND_ID = { case: 'GRAM_ARTICLE_CASE', agree: 'GRAM_AGREEMENT', foreign: 'GRAM_FOREIGN_WORD', nonword: 'GRAM_NONWORD', tense: 'GRAM_TENSE' };
const KINDS = ['case', 'agree', 'foreign', 'nonword', 'tense'];

let kindCursor = 0;
for (const s of stories) {
  const L = lang2(s);
  if (!MUT[L]) continue;
  const clean = s.pages.filter(p => isCleanFor(s.id, p.pageNumber, 'GRAM_'));
  // story-level clean control
  push({ check: 'grammar', unit: 'story', kind: 'original', story: s.id, language: s.language, pageNumber: null, positive: [], state: storyText(s.pages) });
  const step = Math.max(1, Math.floor(clean.length / 4));
  let made = 0;
  for (let i = 0; i < clean.length && made < 4; i += step) {
    const page = clean[i];
    const sents = splitSentences(page.text).filter(x => x.length > 40);
    let done = false;
    for (let k = 0; k < KINDS.length && !done; k++) {
      const kind = KINDS[(kindCursor + k) % KINDS.length];
      for (const sent of sents) {
        const bad = mutateSentence(sent, kind, L);
        if (!bad) continue;
        const flat = page.text.replace(/\s+/g, ' ');
        if (!flat.includes(sent)) continue;
        // rebuild page text keeping paragraph breaks: replace inside the paragraph that holds the sentence
        const paras = splitParagraphs(page.text);
        const pi = paras.findIndex(p => p.replace(/\s+/g, ' ').includes(sent));
        if (pi < 0) continue;
        const badPara = paras[pi].replace(/\s+/g, ' ').replace(sent, bad);
        const badPage = paras.map((p, j) => (j === pi ? badPara : p)).join('\n\n');
        const label = [GRAM_KIND_ID[kind]];
        const meta = { kind, original: sent, mutated: bad };
        for (const [unit, pos, neg] of [
          ['sentence', bad, sent],
          ['paragraph', badPara, paras[pi]],
          ['page', badPage, page.text],
        ]) {
          push({ check: 'grammar', unit, kind: 'injected', story: s.id, language: s.language, pageNumber: page.pageNumber, paragraphIndex: pi, positive: label, state: pos, meta });
          push({ check: 'grammar', unit, kind: 'original', story: s.id, language: s.language, pageNumber: page.pageNumber, paragraphIndex: pi, positive: [], state: neg, meta: { pairOf: items[items.length - 1].id } });
        }
        push({ check: 'grammar', unit: 'story', kind: 'injected', story: s.id, language: s.language, pageNumber: page.pageNumber, positive: label, state: storyText(replacePage(s.pages, page.pageNumber, badPage)), meta });
        done = true; made++; kindCursor++;
        break;
      }
    }
  }
}

// real writer errors, re-inserted
for (const w of real.writer_errors.items) {
  const s = byId[w.story];
  const page = s.pages.find(p => p.pageNumber === w.page);
  if (!page.text.includes(w.right)) { console.error('writer_error: right text not found', w.story, w.page, w.right); process.exit(1); }
  const badPage = page.text.replace(w.right, w.wrong);
  const paraGood = paragraphOf(page.text, w.right);
  const paraBad = paragraphOf(badPage, w.wrong);
  for (const [unit, pos, neg] of [['sentence', w.wrong, w.right], ['paragraph', paraBad, paraGood], ['page', badPage, page.text]]) {
    push({ check: 'grammar', unit, kind: 'real_writer', story: s.id, language: s.language, pageNumber: w.page, positive: [w.label], state: pos, meta: w });
    push({ check: 'grammar', unit, kind: 'original', story: s.id, language: s.language, pageNumber: w.page, positive: [], state: neg, meta: { pairOf: items[items.length - 1].id } });
  }
}

// real labelled pages (grammar, slop): page + paragraph units
for (const [sid, st] of Object.entries(real.stories)) {
  const s = byId[sid];
  for (const page of s.pages) {
    const l = realLabel(sid, page.pageNumber);
    for (const [check, prefix] of [['grammar', 'GRAM_'], ['slop', 'SLOP_']]) {
      push({ check, unit: 'page', kind: 'real', story: sid, language: s.language, pageNumber: page.pageNumber, positive: idsOfCheck(l.ids, prefix), borderline: idsOfCheck(l.borderline, prefix), state: page.text });
    }
    splitParagraphs(page.text).forEach((pt, pi) => {
      // paragraph-level labels only where the page is clean (a page label does not say which paragraph)
      for (const [check, prefix] of [['grammar', 'GRAM_'], ['slop', 'SLOP_']]) {
        if (idsOfCheck(l.ids, prefix).length || idsOfCheck(l.borderline, prefix).length) continue;
        push({ check, unit: 'paragraph', kind: 'real', story: sid, language: s.language, pageNumber: page.pageNumber, paragraphIndex: pi, positive: [], state: pt });
      }
    });
  }
}

// ── slop injections ──
const NAME = s => (s.cast.find(c => c.kind === 'main') || s.cast[0]).name.split(' ')[0];
const slopPool = {};
for (const s of stories) {
  const L = lang2(s);
  if (!['de', 'fr', 'en'].includes(L)) continue;
  (slopPool[L] = slopPool[L] || []).push(...s.pages.filter(p => isCleanFor(s.id, p.pageNumber, 'SLOP_') && p.pageNumber > 1).map(p => ({ s, p })));
}
const cursor = { de: 0, fr: 0, en: 0 };
const PER = { de: 3, fr: 2, en: 1 };
for (const [type, byLang] of Object.entries(inj.slop)) {
  for (const [L, sentences] of Object.entries(byLang)) {
    for (const sentence of sentences) {
      for (let r = 0; r < PER[L]; r++) {
        const pool = slopPool[L];
        const { s, p } = pool[(cursor[L] = (cursor[L] + 7) % pool.length)];
        const text = sentence.replace(/\{NAME\}/g, NAME(s));
        const paras = splitParagraphs(p.text);
        const pi = Math.floor(rnd() * paras.length);
        const sents = splitSentences(paras[pi]);
        const at = Math.max(1, Math.floor(sents.length / 2));
        const badPara = [...sents.slice(0, at), text, ...sents.slice(at)].join(' ');
        const badPage = paras.map((x, j) => (j === pi ? badPara : x)).join('\n\n');
        const meta = { type, inserted: text };
        push({ check: 'slop', unit: 'paragraph', kind: 'injected', story: s.id, language: s.language, pageNumber: p.pageNumber, paragraphIndex: pi, positive: [type], state: badPara, meta });
        push({ check: 'slop', unit: 'page', kind: 'injected', story: s.id, language: s.language, pageNumber: p.pageNumber, positive: [type], state: badPage, meta });
      }
    }
  }
}
// slop / grammar page-level originals for every story not read in full (unlabelled-clean negatives)
for (const s of stories) {
  if (real.stories[s.id]) continue;
  for (const p of s.pages) {
    push({ check: 'slop', unit: 'page', kind: 'unlabelled', story: s.id, language: s.language, pageNumber: p.pageNumber, positive: [], state: p.text });
  }
}

// ── logic ──
const logicStories = [...new Set(inj.logic.map(x => x.story))];
function applyEdit(text, e) {
  if (e.replace) {
    const [a, b] = e.replace.map(para);
    if (!text.includes(a)) { console.error('logic replace not found', e.story, e.page, a); process.exit(1); }
    return text.replace(a, b);
  }
  return e.at === 'start' ? `${e.insert} ${text}` : `${text} ${e.insert}`;
}
function logicStates(pages, pageNumber, cast) {
  const page = pages.find(p => p.pageNumber === pageNumber);
  const castLine = `CAST: ${cast.map(c => `${c.name} (${c.kind === 'animal' ? 'animal' : 'person'})`).join(', ')}\n\n`;
  return {
    page: `--- Page ${pageNumber} (PAGE TO JUDGE) ---\n${page.text}`,
    story_prefix: buildMarkedStoryState(pages, pageNumber, { includeLater: false }),
    story_marked: buildMarkedStoryState(pages, pageNumber, { includeLater: true }),
    story_marked_cast: castLine + buildMarkedStoryState(pages, pageNumber, { includeLater: true }),
  };
}
for (const sid of logicStories) {
  const s = byId[sid];
  for (const p of s.pages) {
    const l = realLabel(sid, p.pageNumber);
    const pos = l ? idsOfCheck(l.ids, 'LOGIC_') : [];
    const bl = l ? idsOfCheck(l.borderline, 'LOGIC_') : [];
    for (const [unit, state] of Object.entries(logicStates(s.pages, p.pageNumber, s.cast))) {
      push({ check: 'logic', unit, kind: l ? 'real' : 'unlabelled', story: sid, language: s.language, pageNumber: p.pageNumber, positive: pos, borderline: bl, state });
    }
  }
}
for (const e of inj.logic) {
  const s = byId[e.story];
  const page = s.pages.find(p => p.pageNumber === e.page);
  const pages = replacePage(s.pages, e.page, applyEdit(page.text, e));
  const l = realLabel(e.story, e.page);
  const pos = [...new Set([e.label, ...(l ? idsOfCheck(l.ids, 'LOGIC_') : [])])];
  for (const [unit, state] of Object.entries(logicStates(pages, e.page, s.cast))) {
    push({ check: 'logic', unit, kind: 'injected', story: e.story, language: s.language, pageNumber: e.page, positive: pos, state, meta: e });
  }
}

// ── arc: page text vs plan line ──
function planLines(s) {
  if (!s.pagePlan) return [];
  return s.pagePlan.split('\n').map(l => l.match(/^Page (\d+):\s*(.+)$/)).filter(Boolean).map(m => {
    const parts = m[2].split(' — ');
    return { pageNumber: +m[1], shot: parts[0].trim(), line: parts.slice(1).join(' — ').trim() };
  });
}
for (const s of stories) {
  const plan = planLines(s);
  if (!plan.length) continue;
  for (const pl of plan) {
    const page = s.pages.find(p => p.pageNumber === pl.pageNumber);
    if (!page) continue;
    push({ check: 'arc', unit: 'page', kind: 'original', story: s.id, language: s.language, pageNumber: pl.pageNumber, positive: [], plan: pl.line, state: page.text });
    const other = plan[(plan.indexOf(pl) + Math.max(3, Math.floor(plan.length / 2))) % plan.length];
    push({ check: 'arc', unit: 'page', kind: 'shuffled', story: s.id, language: s.language, pageNumber: pl.pageNumber, positive: ['ARC_MISMATCH'], plan: other.line, state: page.text, meta: { planOf: other.pageNumber } });
  }
}
for (const e of inj.arc_subtle) {
  const s = byId[e.story];
  const pl = planLines(s).find(x => x.pageNumber === e.page);
  const page = s.pages.find(p => p.pageNumber === e.page);
  push({ check: 'arc', unit: 'page', kind: 'injected', story: s.id, language: s.language, pageNumber: e.page, positive: ['ARC_MISMATCH'], plan: pl.line, state: applyEdit(page.text, e), meta: e });
}

// ── arc: every cast member has a beat ──
for (const s of stories) {
  if (!s.arc) continue;
  const lines = s.arc.split('\n');
  const names = [...new Set(s.cast.map(c => c.name).filter(n => n && n.length > 2))];
  const has = (text, n) => text.toLowerCase().includes(n.toLowerCase());
  push({ check: 'arc_cast', unit: 'arc', kind: 'original', story: s.id, language: s.language, names, present: names.map(n => has(s.arc, n)), state: s.arc });
  for (const n of names) {
    if (!has(s.arc, n)) continue;
    const cut = lines.filter(l => !has(l, n)).join('\n');
    push({ check: 'arc_cast', unit: 'arc', kind: 'removed', story: s.id, language: s.language, names, present: names.map(m => has(cut, m)), removed: n, state: cut });
  }
}

// ── shot type ──
const SHOT_WORDS = /\b(?:extreme\s+)?(?:close-up|close up|closeup|medium|wide|ultra-wide|over-the-shoulder|high-angle|low-angle|establishing)(?:\s+(?:shot|view|angle))?\b/gi;
for (const s of stories) {
  for (const b of s.briefs) {
    const label = normalizeShot(b.camera);
    if (!label) continue;
    const text = b.prose ? b.prose.replace(SHOT_WORDS, '').replace(/\s+/g, ' ').trim()
      : [b.imageSummary, b.depthLayers].filter(Boolean).join(' ');
    if (!text) continue;
    push({ check: 'shot', unit: 'brief', kind: 'original', story: s.id, language: s.language, pageNumber: b.pageNumber, label, rawLabel: b.camera, state: text });
  }
}

fs.writeFileSync(path.join(DIR, 'items.jsonl'), items.map(x => JSON.stringify(x)).join('\n') + '\n');
const count = {};
for (const it of items) { const k = `${it.check}/${it.unit}/${it.kind}`; count[k] = (count[k] || 0) + 1; }
console.log(items.length, 'items'); console.table(count);
