import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// THE DEFECT THIS PINS (2026-09-14). Two different things were both called
// `eval_findings`: the Lab's curated findings REGISTRY (migration 013, live in
// staging + prod) and a per-page eval STATS SINK declared only inside the dead
// `initializeDatabase()` in server/services/database.js. The migration owned the
// name, so the sink's INSERT targeted the registry's schema, failed on
// `column "story_id" does not exist`, was swallowed at warn level — and the sink
// recorded ZERO rows for its entire lifetime. Fix: the sink is
// `eval_finding_stats` (migration 037) and failures are loud.

const STATS_MIGRATION = 'migrations/037_eval_finding_stats.sql';
const REGISTRY_MIGRATION = 'migrations/013_eval_findings.sql';

/** Column names actually declared by the migration — the REAL schema, parsed. */
function migrationColumns(file: string, table: string): string[] {
  const sql = read(file);
  const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`));
  if (!m) throw new Error(`no CREATE TABLE ${table} in ${file}`);
  return m[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('--'))
    .map(l => l.split(/\s+/)[0].replace(/,$/, ''))
    .filter(c => !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(c));
}

/**
 * The REAL row shape the eval pipeline hands the sink: the real bucket vector
 * from evalBuckets.mapIssuesToBuckets over real fixable_issues, combined with
 * the real storyMeta keys images.js threads (server/lib/images.js ~:2491).
 * Not hand-built — the same construction as evalPipeline.js's sink block.
 */
function realSinkRows() {
  const { mapIssuesToBuckets } = require_('../../server/lib/evalBuckets.js');
  const fixableIssues = [
    { type: 'character_mismatch', severity: 'MAJOR', description: 'hair colour differs from reference', character: 'Levin' },
    { type: 'clothing_mismatch', severity: 'MODERATE', description: 'coat is green, brief says red', character: 'Levin' },
  ];
  const vec = mapIssuesToBuckets(fixableIssues);
  const sm = {
    storyId: 'job_1788471969309', pageNumber: 4, artStyle: 'watercolor',
    genre: 'adventure', language: 'de', charCount: 2,
  };
  return Object.entries(vec).map(([bucket, m]: [string, any]) => ({
    story_id: sm.storyId, page_number: sm.pageNumber, bucket,
    severity: String(m.severity).toLowerCase(), eval_type: 'scene',
    art_style: sm.artStyle, genre: sm.genre, language: sm.language,
    char_count: sm.charCount, judges: 'gemini',
  }));
}

describe('eval stats sink records to its own table', () => {
  let queries: Array<{ sql: string; params: any[] }>;
  let db: any;

  let shouldFail = false;
  let realQuery: any;

  beforeEach(() => {
    queries = [];
    shouldFail = false;
    // database.js is CJS and resolves `pg` through the same CJS cache, so
    // patching the real Pool.prototype is what actually intercepts its queries
    // (a vi.doMock('pg') does not reach a createRequire'd module). No socket is
    // ever opened because query() never reaches the real implementation.
    const pg = require_('pg');
    realQuery = pg.Pool.prototype.query;
    pg.Pool.prototype.query = async function (sql: string, params: any[] = []) {
      queries.push({ sql, params });
      if (shouldFail) throw new Error('relation "eval_finding_stats" does not exist');
      return { rows: [], rowCount: 1, command: 'INSERT' };
    };
    db = require_('../../server/services/database.js');
    db.initializePool();
  });

  afterEach(() => {
    require_('pg').Pool.prototype.query = realQuery;
    vi.restoreAllMocks();
  });

  it('a completed evaluation writes one row per bucket into eval_finding_stats', async () => {
    const rows = realSinkRows();
    expect(rows.length).toBeGreaterThan(1);

    await db.recordEvalFindings(rows);

    // ONE statement carrying every row — atomic. The old per-row loop could
    // leave a partial batch behind when a later row failed.
    const inserts = queries.filter(q => /INSERT INTO/.test(q.sql));
    expect(inserts).toHaveLength(1);
    const valueTuples = inserts[0].sql.match(/\(\$\d+(?:,\$\d+)*\)/g)!;
    expect(valueTuples).toHaveLength(rows.length);

    // Against the OLD code this INSERT named `eval_findings` — the registry.
    expect(inserts[0].sql).toContain('INSERT INTO eval_finding_stats');
    expect(inserts[0].sql).not.toMatch(/INSERT INTO eval_findings\b/);
    expect(db.EVAL_FINDING_STATS_TABLE).toBe('eval_finding_stats');

    // Every inserted column exists in the REAL migrated schema, and the
    // placeholder count matches the params actually bound.
    const declared = migrationColumns(STATS_MIGRATION, 'eval_finding_stats');
    const cols = inserts[0].sql.match(/\(([^)]*)\)\s*VALUES/)![1]
      .split(',').map(c => c.trim());
    for (const c of cols) expect(declared).toContain(c);
    expect(inserts[0].params).toHaveLength(cols.length * rows.length);
    // Placeholders are numbered contiguously across the whole batch.
    const nums = inserts[0].sql.match(/\$\d+/g)!.map(s => Number(s.slice(1)));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    // Second row's bucket sits at its own offset in the flat param list.
    expect(inserts[0].params[cols.length + cols.indexOf('bucket')]).toBe(rows[1].bucket);

    // story_id is the column the old target did NOT have — the exact failure.
    expect(cols).toContain('story_id');
    expect(inserts[0].params[0]).toBe('job_1788471969309');
    expect(db.getEvalFindingStatsFailureCount()).toBe(0);
  });

  it('an empty or all-invalid batch issues no query', async () => {
    await expect(db.recordEvalFindings([])).resolves.toBeUndefined();
    await expect(db.recordEvalFindings([null, { bucket: 'x' }])).resolves.toBeUndefined();
    expect(queries.filter(q => /INSERT INTO/.test(q.sql))).toHaveLength(0);
  });

  it('a write failure is logged at error level and does not throw', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    shouldFail = true;

    await expect(db.recordEvalFindings(realSinkRows())).resolves.toBeUndefined();

    expect(err).toHaveBeenCalled();
    const text = err.mock.calls.map(c => c.join(' ')).join('\n');
    expect(text).toContain('eval_finding_stats');
    expect(text).toContain('NOT recorded');
    expect(db.getEvalFindingStatsFailureCount()).toBeGreaterThan(0);
    // Loud means error, not the warn level that hid this for its whole lifetime.
    expect(warn).not.toHaveBeenCalled();
  });

  it('the reader aggregates from the same table constant as the writer', async () => {
    await db.getEvalFindingsStats({ groupBy: 'art_style' });
    const select = queries.find(q => /SELECT/.test(q.sql) && /FROM/.test(q.sql));
    expect(select!.sql).toContain('FROM eval_finding_stats');
  });
});

describe('the eval_findings name collision cannot be reintroduced', () => {
  it('exactly one definition of each table, in a migration file', () => {
    const files = [
      ...fs.readdirSync(path.join(ROOT, 'migrations')).map(f => `migrations/${f}`),
      'server/services/database.js',
    ];
    const defs: Record<string, string[]> = { eval_findings: [], eval_finding_stats: [] };
    for (const f of files) {
      const text = read(f);
      for (const t of Object.keys(defs)) {
        // \b so `eval_findings` does not match inside `eval_finding_stats`.
        const re = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${t}\\b`, 'g');
        for (const _ of text.matchAll(re)) defs[t].push(f);
      }
    }
    expect(defs.eval_findings).toEqual([REGISTRY_MIGRATION]);
    expect(defs.eval_finding_stats).toEqual([STATS_MIGRATION]);
  });

  it('the registry keeps its curated shape and the sink keeps the story columns', () => {
    const registry = migrationColumns(REGISTRY_MIGRATION, 'eval_findings');
    expect(registry).toContain('slug');
    expect(registry).toContain('rationale');
    expect(registry).not.toContain('story_id'); // why the old INSERT could never work

    const stats = migrationColumns(STATS_MIGRATION, 'eval_finding_stats');
    for (const c of ['story_id', 'page_number', 'bucket', 'severity', 'art_style', 'genre']) {
      expect(stats).toContain(c);
    }
    expect(stats).not.toContain('slug');
  });

  it('the pipeline never swallows a sink rejection silently', () => {
    const text = read('server/lib/evalPipeline.js');
    expect(text).toMatch(/recordEvalFindings\(rows\)\s*\.catch\(/);
    expect(text).not.toMatch(/recordEvalFindings\(rows\)\.catch\(\(\)\s*=>\s*\{\}\)/);
  });
});
