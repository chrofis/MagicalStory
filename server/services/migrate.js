// Tiny SQL migration runner.
//
// Reads `migrations/00N_*.sql` files in lexical order, applies any that
// aren't yet recorded in the `_migrations` tracking table, and records
// each successful apply inside the same transaction. On error the
// transaction rolls back and the app refuses to boot — fail loud, no
// silent fallback to a half-initialised DB.
//
// To add a new schema change: drop a new file in migrations/ with the
// next number (`002_add_foo.sql`). Never edit a file that's already been
// applied to any environment.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureTrackingTable(dbPool) {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function getAppliedSet(dbPool) {
  const { rows } = await dbPool.query('SELECT filename FROM _migrations');
  return new Set(rows.map(r => r.filename));
}

async function applyOne(dbPool, filename) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.message = `Migration ${filename} failed: ${err.message}`;
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations(dbPool, log = console) {
  if (!dbPool) {
    throw new Error('runMigrations called without a database pool');
  }
  await dbPool.query('SELECT 1');
  await ensureTrackingTable(dbPool);
  const files = listMigrationFiles();
  const applied = await getAppliedSet(dbPool);
  const pending = files.filter(f => !applied.has(f));
  if (pending.length === 0) {
    log.info(`✓ Schema up to date (${files.length} migration${files.length === 1 ? '' : 's'} on record)`);
    return;
  }
  log.info(`→ Applying ${pending.length} pending migration${pending.length === 1 ? '' : 's'}: ${pending.join(', ')}`);
  for (const filename of pending) {
    const t0 = Date.now();
    await applyOne(dbPool, filename);
    log.info(`  ✓ ${filename} (${Date.now() - t0}ms)`);
  }
  log.info('✓ Schema migrations complete');
}

module.exports = { runMigrations };
