/**
 * Weekly Railway cost email sweep.
 *
 * Same shape as the daily summary sweep (server/lib/dailySummary.js): runs on
 * the hourly setInterval from the server.js boot block, sends ONE email per
 * week, and dedupes through a `config` row so restarts and the hourly cadence
 * can't double-send.
 *
 * WHY weekly rather than waiting for the invoice: Railway bills resident memory
 * per MB per MINUTE, so a container that quietly holds more RAM costs more every
 * hour it stays up, with no in-app signal. A month of that is only visible once
 * it's already been paid. A week bounds the damage.
 *
 * Inert unless RAILWAY_API_TOKEN is set — the report can't be built without it.
 */

'use strict';

const { buildCostReport } = require('./railwayCost');
const email = require('../../email');

const SEND_AFTER_HOUR = 7; // Swiss local
const SEND_WEEKDAY = 1;    // Monday

function swissNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    weekday: 'short', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    weekday: weekdayIndex,
  };
}

async function runWeeklyCostSweep(dbPool, log) {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !projectId) return; // not configured — stay silent

  const { date: today, hour, weekday } = swissNowParts();
  if (weekday !== SEND_WEEKDAY || hour < SEND_AFTER_HOUR) return;

  const last = await dbPool.query(
    "SELECT config_value FROM config WHERE config_key = 'weekly_cost_last_sent'"
  );
  if (last.rows[0]?.config_value === today) return; // already sent today

  if (!email.isEmailConfigured || !email.isEmailConfigured()) {
    log.debug('[weekly-cost] email not configured — skipping');
    return;
  }

  const report = await buildCostReport({ token, projectId, days: 7 });

  // Railway is only part of the bill — attach AI API spend from what the
  // pipeline already records on each story. Never let this sink the email: if
  // the API side fails we still want the infrastructure numbers to arrive.
  try {
    const { buildApiCostReport } = require('./apiCost');
    report.api = await buildApiCostReport({ pool: dbPool, days: 7 });
  } catch (err) {
    log.warn(`[weekly-cost] API cost section failed (sending Railway only): ${err.message}`);
    report.api = null;
  }

  const result = await email.sendAdminWeeklyCostReport(report);
  if (!result) {
    log.warn('[weekly-cost] send returned null — will retry next hour');
    return;
  }

  await dbPool.query(
    `INSERT INTO config (config_key, config_value) VALUES ('weekly_cost_last_sent', $1)
     ON CONFLICT (config_key) DO UPDATE SET config_value = $1`,
    [today]
  );
  log.info(
    `[weekly-cost] sent for ${today} — $${report.current.totals.total.toFixed(2)} ` +
    `(projected $${report.projectedMonthly.toFixed(2)}/month)`
  );
}

module.exports = { runWeeklyCostSweep };
