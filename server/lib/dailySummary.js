/**
 * Daily admin summary email sweep.
 *
 * Runs on the same hourly setInterval cadence as the trial-reminder sweep
 * (server.js boot block). Sends ONE email per Swiss-local day, after 07:00
 * Swiss time, covering the previous 24 hours of activity. The `config`
 * table row `daily_summary_last_sent` (value = Swiss-local YYYY-MM-DD)
 * is the dedupe key, so restarts and the hourly cadence can't double-send.
 */

'use strict';

const { buildActivityFeed } = require('./adminActivity');
const email = require('../../email');

const SEND_AFTER_HOUR = 7; // Swiss local time

function swissNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) };
}

function swissDateLabel() {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
}

async function runDailySummarySweep(dbPool, log) {
  const { date: today, hour } = swissNowParts();
  if (hour < SEND_AFTER_HOUR) return;

  const last = await dbPool.query(
    "SELECT config_value FROM config WHERE config_key = 'daily_summary_last_sent'"
  );
  if (last.rows[0]?.config_value === today) return; // already sent today

  if (!email.isEmailConfigured || !email.isEmailConfigured()) {
    log.debug('[daily-summary] email not configured — skipping');
    return;
  }

  const feed = await buildActivityFeed(dbPool, 24);
  const result = await email.sendAdminDailySummary(feed, swissDateLabel());
  if (!result) {
    log.warn('[daily-summary] send returned null — will retry next hour');
    return;
  }

  await dbPool.query(
    `INSERT INTO config (config_key, config_value) VALUES ('daily_summary_last_sent', $1)
     ON CONFLICT (config_key) DO UPDATE SET config_value = $1`,
    [today]
  );
  log.info(`[daily-summary] sent for ${today} (${feed.events.length} events)`);
}

module.exports = { runDailySummarySweep };
