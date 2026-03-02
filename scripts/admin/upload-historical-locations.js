#!/usr/bin/env node
/**
 * Upload historical-locations.json to the historical_locations DB table.
 *
 * Usage:
 *   DATABASE_URL=<railway-url> node scripts/admin/upload-historical-locations.js
 *
 * Idempotent — uses ON CONFLICT DO NOTHING so safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const JSON_PATH = path.join(__dirname, '../../server/data/historical-locations.json');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
  }

  if (!fs.existsSync(JSON_PATH)) {
    console.error(`ERROR: JSON file not found at ${JSON_PATH}`);
    process.exit(1);
  }

  console.log('Reading JSON file...');
  const databank = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const eventIds = Object.keys(databank);
  console.log(`Found ${eventIds.length} events`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway.app') ? { rejectUnauthorized: false } : false,
  });

  // Ensure the table exists (schema matches server/services/database.js)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS historical_locations (
      id SERIAL PRIMARY KEY,
      event_id VARCHAR(100) NOT NULL,
      location_name VARCHAR(255) NOT NULL,
      location_query VARCHAR(255),
      location_type VARCHAR(100),
      aliases JSONB DEFAULT '[]',
      photo_url TEXT NOT NULL DEFAULT '',
      photo_data TEXT,
      photo_attribution TEXT,
      photo_description TEXT,
      photo_score INT,
      photo_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(event_id, location_name, photo_url)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_historical_locations_event ON historical_locations(event_id)`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const eventId of eventIds) {
    const event = databank[eventId];
    const locations = event.locations || [];
    let eventInserted = 0;

    for (const loc of locations) {
      const photos = loc.photos || [];
      if (photos.length === 0) {
        // Insert one row even with no photos (location metadata only)
        const result = await pool.query(
          `INSERT INTO historical_locations (event_id, location_name, location_query, location_type, aliases, photo_url)
           VALUES ($1, $2, $3, $4, $5, '')
           ON CONFLICT DO NOTHING`,
          [eventId, loc.name, loc.query || null, loc.type || null, JSON.stringify(loc.aliases || [])]
        );
        if (result.rowCount > 0) eventInserted++;
        else totalSkipped++;
        continue;
      }

      for (const photo of photos) {
        const result = await pool.query(
          `INSERT INTO historical_locations
           (event_id, location_name, location_query, location_type, aliases,
            photo_url, photo_data, photo_attribution, photo_description, photo_score, photo_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT DO NOTHING`,
          [
            eventId,
            loc.name,
            loc.query || null,
            loc.type || null,
            JSON.stringify(loc.aliases || []),
            photo.photoUrl || '',
            photo.photoData || null,
            photo.attribution || null,
            photo.description || null,
            photo.score != null ? photo.score : null,
            photo.reason || null,
          ]
        );
        if (result.rowCount > 0) eventInserted++;
        else totalSkipped++;
      }
    }

    totalInserted += eventInserted;
    console.log(`  ${eventId}: ${locations.length} locations, ${eventInserted} rows inserted`);
  }

  console.log(`\nDone! ${totalInserted} rows inserted, ${totalSkipped} skipped (already exist)`);

  // Verify
  const counts = await pool.query(
    'SELECT event_id, COUNT(*) as cnt FROM historical_locations GROUP BY event_id ORDER BY event_id'
  );
  console.log('\nVerification — rows per event:');
  for (const row of counts.rows) {
    console.log(`  ${row.event_id}: ${row.cnt}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
