#!/usr/bin/env node
/**
 * Fill in `landmark_index.type` for rows that have none, from the Wikidata
 * "instance of" (P31) claim.
 *
 * WHY: 983 of 4764 rows have type NULL. Type drives landmark ranking — an
 * untyped row earns no boost, which is why Grossmünster, Fraumünster and
 * Zytglogge scored 0 and were never offered to the story writer. It also means
 * the ranker has to GUESS what an untyped row is, and events ("Lucerne
 * Festival", a cycling championship) slip through as if they were landmarks.
 *
 * Every one of those 983 rows has a wikidata_qid, so P31 can answer it.
 *
 * Uses SPARQL rather than wbgetentities: one query resolves ~200 QIDs to
 * already-labelled classes, so the whole job is ~5 requests instead of 983.
 *
 * Usage:
 *   node scripts/admin/backfill-landmark-types.js --dry-run   # report only
 *   node scripts/admin/backfill-landmark-types.js             # write
 *   node scripts/admin/backfill-landmark-types.js --limit=200
 */

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// --revalidate-all also re-derives types that are already set. The existing
// values are not trustworthy: a railway station is typed Castle, a bridge is
// typed Church, a hotel is typed Tower.
const revalidateAll = args.includes('--revalidate-all');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
const QIDS_PER_QUERY = 200;
const USER_AGENT = 'MagicalStory/1.0 (https://magicalstory.ch; landmark type backfill)';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Wikidata class label -> our `type` vocabulary. Ordered: the FIRST match wins,
// so put the specific before the generic ("cathedral" before "building").
// `Event` is deliberately a type of its own: a festival or a battle has
// coordinates but is not somewhere a scene can be set, and the ranker demotes it.
const TYPE_RULES = [
  [/\b(cathedral|minster|münster)\b/i,                     'Cathedral'],
  [/\b(church|chapel|basilica|kirche|parish)\b/i,          'Church'],
  [/\b(abbey|monastery|convent|priory|kloster)\b/i,        'Abbey'],
  [/\b(castle|fortress|fortification|burg|schloss|palace|château)\b/i, 'Castle'],
  [/\b(ruin)\b/i,                                          'Castle'],
  [/\b(museum|gallery)\b/i,                                'Museum'],
  [/\b(bridge|viaduct)\b/i,                                'Bridge'],
  [/\b(tower|belfry|gate|city gate)\b/i,                   'Tower'],
  [/\b(fountain|well)\b/i,                                 'Fountain'],
  [/\b(square|plaza|piazza|platz)\b/i,                     'Square'],
  [/\b(theatre|theater|opera|cinema|concert hall)\b/i,     'Theatre'],
  [/\b(library|archive)\b/i,                               'Library'],
  [/\b(park|garden|zoo|cemetery|graveyard)\b/i,            'Park'],
  [/\b(monument|memorial|statue|sculpture|obelisk)\b/i,    'Monument'],
  [/\b(railway station|train station|metro station|bahnhof)\b/i, 'Station'],
  [/\b(airport|aerodrome)\b/i,                             'Station'],
  [/\b(lake|reservoir|pond|see)\b/i,                       'Lake'],
  [/\b(river|stream|brook|waterfall|canal)\b/i,            'River'],
  [/\b(mountain|peak|summit|hill|pass|glacier|alp)\b/i,    'Mountain'],
  [/\b(forest|wood|nature reserve|national park)\b/i,      'Forest'],
  [/\b(island|peninsula)\b/i,                              'Island'],
  [/\b(valley|gorge|ravine)\b/i,                           'Valley'],
  // Not places at all — these exist so the ranker can demote them explicitly
  // instead of inferring from a missing type.
  // `race` matters here: a road bicycle race would otherwise hit the `road`
  // rule below and be typed Infrastructure, which is how a cycling
  // championship ended up offered as a place to set a scene.
  // Trailing `s?` is load-bearing: Wikidata's class is "UCI Road World
  // ChampionshipS", and \bchampionship\b cannot match a plural, so it fell
  // through to the `road` rule and a bicycle race was typed Infrastructure.
  [/\b(festival|championship|competition|tournament|conference|congress|exhibition|ceremony|race|regatta|marathon|game)s?\b/i, 'Event'],
  [/\b(battle|siege|war|campaign|revolt|uprising)\b/i,     'Event'],
  [/\b(accident|disaster|crash|incident|fire|flood|earthquake)\b/i, 'Event'],
  [/\b(company|enterprise|business|brand|corporation|bank|chain)\b/i, 'Organisation'],
  [/\b(association|organization|organisation|society|club|foundation)\b/i, 'Organisation'],
  [/\b(municipality|commune|city|town|village|hamlet|settlement|locality|district|canton)\b/i, 'City'],
  // Generic built things last.
  [/\b(hotel|restaurant|inn)\b/i,                          'Building'],
  [/\b(university|school|college|hospital|prison)\b/i,     'Building'],
  [/\b(building|house|villa|farmhouse|barn|mill|factory|hall|architectural structure)\b/i, 'Building'],
  [/\b(road|motorway|highway|street|tunnel|railway line|thoroughfare|avenue|boulevard)\b/i, 'Infrastructure'],
  [/\b(tram|funicular|cable car|aerial lift|railway|metro|bus)\b/i, 'Infrastructure'],
  [/\b(stadium|arena|sports? (field|ground|hall|venue|centre|center)|swimming pool|ice rink)\b/i, 'Building'],
  [/\b(school|kantonsschule|gymnasium|academy|educational|higher education|institution|campus)\b/i, 'Building'],
  [/\b(observatory|planetarium|clinic|town hall|rathaus|courthouse|barracks|shopping)\b/i, 'Building'],
  // A Wikimedia list article is not a place at all — an index page that happens
  // to carry coordinates. Typed so the ranker can demote it outright.
  [/\b(wikimedia|list article|disambiguation)\b/i, 'Other'],
  [/\b(sports season|season|edition of)\b/i,               'Event'],
  [/\b(neighborhood|neighbourhood|quarter|borough|suburb)\b/i, 'City'],
  [/\b(institute|research|arts centre|arts center|cultural centre)\b/i, 'Building'],
];

// Everything reaching here has a P31 we have no rule for, or no P31 at all.
// Left NULL these rows would keep the exact defect this script exists to remove,
// so they take a generic built-landmark type — the class the ranker already
// assumed for untyped rows, now stated rather than inferred.
const FALLBACK_TYPE = 'Landmark';

function mapClassToType(labels) {
  for (const [re, type] of TYPE_RULES) {
    for (const l of labels) if (re.test(l)) return type;
  }
  return null;
}

function sparql(query) {
  const body = 'query=' + encodeURIComponent(query) + '&format=json';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'query.wikidata.org',
      path: '/sparql',
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  let q = `SELECT id, name, type AS old_type, wikidata_qid FROM landmark_index
           WHERE wikidata_qid IS NOT NULL ${revalidateAll ? '' : 'AND type IS NULL'} ORDER BY id`;
  if (limit) q += ` LIMIT ${limit}`;
  const { rows } = await pool.query(q);
  console.log(`Untyped rows with a QID: ${rows.length}${dryRun ? '  (DRY RUN — no writes)' : ''}\n`);
  if (rows.length === 0) { await pool.end(); return; }

  const byQid = new Map();
  for (const r of rows) {
    if (!byQid.has(r.wikidata_qid)) byQid.set(r.wikidata_qid, []);
    byQid.get(r.wikidata_qid).push(r);
  }
  const qids = [...byQid.keys()];

  const classLabels = new Map();   // qid -> [class label, ...]
  for (let i = 0; i < qids.length; i += QIDS_PER_QUERY) {
    const slice = qids.slice(i, i + QIDS_PER_QUERY);
    const values = slice.map(q => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?typeLabel WHERE {
      VALUES ?item { ${values} }
      ?item wdt:P31 ?type .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,fr". }
    }`;
    try {
      const json = await sparql(query);
      for (const b of json.results.bindings) {
        const qid = b.item.value.split('/').pop();
        if (!classLabels.has(qid)) classLabels.set(qid, []);
        classLabels.get(qid).push(b.typeLabel.value);
      }
      console.log(`  resolved ${Math.min(i + QIDS_PER_QUERY, qids.length)}/${qids.length} QIDs`);
    } catch (err) {
      console.error(`  [ERROR] batch at ${i}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  const counts = {};
  const unresolved = [];
  const changed = [];
  let written = 0;
  for (const [qid, landmarkRows] of byQid) {
    const labels = classLabels.get(qid);
    let type = labels ? mapClassToType(labels) : null;
    if (!type) {
      unresolved.push({ name: landmarkRows[0].name, labels: labels ? labels.slice(0, 3) : null });
      type = FALLBACK_TYPE;
    }
    counts[type] = (counts[type] || 0) + landmarkRows.length;
    for (const r of landmarkRows) {
      if (revalidateAll && r.old_type && r.old_type !== type) {
        changed.push({ name: r.name, from: r.old_type, to: type });
      }
      if (!dryRun && r.old_type !== type) {
        await pool.query('UPDATE landmark_index SET type = $1 WHERE id = $2', [type, r.id]);
        written++;
      }
    }
  }

  console.log(`\nTypes assigned${dryRun ? ' (would be)' : ''}:`);
  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t.padEnd(16)} ${n}`));
  console.log(`\n  total typed : ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  console.log(`  no rule matched (got ${FALLBACK_TYPE}): ${unresolved.length}`);
  if (revalidateAll) {
    console.log(`  existing types CHANGED: ${changed.length}`);
    console.log('\n  sample changes:');
    changed.slice(0, 25).forEach(c => console.log(`    ${String(c.name).slice(0, 34).padEnd(36)} ${c.from} -> ${c.to}`));
  }
  if (!dryRun) console.log(`  rows written: ${written}`);
  if (unresolved.length) {
    console.log('\n  sample unresolved (name -> wikidata classes):');
    unresolved.slice(0, 12).forEach(u => console.log(`    ${String(u.name).slice(0, 34).padEnd(36)} ${u.labels ? u.labels.join(', ').slice(0, 60) : '(no P31)'}`));
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
