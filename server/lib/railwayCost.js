/**
 * Railway usage → cost, so the bill stops being a monthly surprise.
 *
 * Railway bills resident memory per MB per MINUTE, around the clock. That makes
 * cost a function of what the containers HOLD, not what they do — a process that
 * ratchets its RSS up and never gives it back keeps charging while idle, and
 * nothing in the app surfaces that until the invoice lands. This module pulls the
 * same usage numbers Railway bills from and prices them, so a weekly email can
 * show the trend while it's still cheap to react to.
 *
 * Used by:
 *   - scripts/admin/cost-report.js  (npm run cost:report — on demand)
 *   - server/lib/costReport.js      (weekly email sweep)
 */

'use strict';

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/**
 * Unit prices in USD.
 *
 * MEMORY is exact: taken straight off the invoice line ("Memory (per MB / min)
 * … $0.00000023148148 each"). The others are Railway's published rates converted
 * to the units the usage API returns, so treat them as close-but-not-invoice-exact.
 * Memory is the one that matters — it was ~90% of the bill that triggered this.
 */
const RATES = {
  memoryPerMbMinute: 0.00000023148148,        // invoice-exact
  cpuPerVcpuMinute: 20 / (30 * 24 * 60),      // $20/vCPU/month
  egressPerGb: 0.05,                          // $0.05/GB
  diskPerGbMinute: 0.15 / (30 * 24 * 60),     // $0.15/GB/month
};

const MEASUREMENTS = ['MEMORY_USAGE_GB', 'CPU_USAGE', 'NETWORK_TX_GB', 'DISK_USAGE_GB'];

async function gql(token, query, variables) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

/** Resolve service/environment UUIDs to names so the report is readable. */
async function fetchNames(token, projectId) {
  const d = await gql(
    token,
    `query N($id: String!) {
       project(id: $id) {
         name
         services { edges { node { id name } } }
         environments { edges { node { id name } } }
       }
     }`,
    { id: projectId }
  );
  const services = {};
  const environments = {};
  for (const e of d.project.services.edges) services[e.node.id] = e.node.name;
  for (const e of d.project.environments.edges) environments[e.node.id] = e.node.name;
  return { projectName: d.project.name, services, environments };
}

/**
 * Sum usage over one window, grouped by service+environment.
 * The API returns one row per measurement per time bucket, so everything is
 * accumulated rather than read as a single value.
 */
async function fetchWindow(token, projectId, startISO, endISO, names) {
  const d = await gql(
    token,
    `query U($pid: String!, $s: DateTime!, $e: DateTime!, $m: [MetricMeasurement!]!) {
       usage(projectId: $pid, measurements: $m, groupBy: [SERVICE_ID, ENVIRONMENT_ID],
             startDate: $s, endDate: $e) {
         measurement value tags { serviceId environmentId }
       }
     }`,
    { pid: projectId, s: startISO, e: endISO, m: MEASUREMENTS }
  );

  const rows = new Map(); // "svc|env" -> accumulator
  for (const r of d.usage) {
    const svc = names.services[r.tags.serviceId] || 'unknown';
    const env = names.environments[r.tags.environmentId] || 'unknown';
    const key = `${svc}|${env}`;
    if (!rows.has(key)) {
      rows.set(key, { service: svc, environment: env, memoryGbMin: 0, cpuMinutes: 0, egressGb: 0, diskGbMin: 0 });
    }
    const acc = rows.get(key);
    if (r.measurement === 'MEMORY_USAGE_GB') acc.memoryGbMin += r.value;
    else if (r.measurement === 'CPU_USAGE') acc.cpuMinutes += r.value;
    else if (r.measurement === 'NETWORK_TX_GB') acc.egressGb += r.value;
    else if (r.measurement === 'DISK_USAGE_GB') acc.diskGbMin += r.value;
  }

  const windowMinutes = (new Date(endISO) - new Date(startISO)) / 60000;
  const items = [...rows.values()].map((r) => {
    const cost = {
      memory: r.memoryGbMin * 1024 * RATES.memoryPerMbMinute,
      cpu: r.cpuMinutes * RATES.cpuPerVcpuMinute,
      egress: r.egressGb * RATES.egressPerGb,
      disk: r.diskGbMin * RATES.diskPerGbMinute,
    };
    cost.total = cost.memory + cost.cpu + cost.egress + cost.disk;
    // The number that explains the memory bill: average GB held for the window.
    // Cost is linear in this, so it's the one figure worth watching week to week.
    const avgResidentGb = windowMinutes > 0 ? r.memoryGbMin / windowMinutes : 0;
    return { ...r, avgResidentGb, cost };
  });

  items.sort((a, b) => b.cost.total - a.cost.total);
  const totals = items.reduce(
    (t, i) => ({
      memory: t.memory + i.cost.memory,
      cpu: t.cpu + i.cost.cpu,
      egress: t.egress + i.cost.egress,
      disk: t.disk + i.cost.disk,
      total: t.total + i.cost.total,
    }),
    { memory: 0, cpu: 0, egress: 0, disk: 0, total: 0 }
  );

  return { startISO, endISO, windowMinutes, items, totals };
}

/**
 * Two consecutive windows (default 7 days each) so the email can show a delta.
 * `now` is injectable to keep this testable.
 */
async function buildCostReport({ token, projectId, days = 7, now = new Date() }) {
  if (!token) throw new Error('RAILWAY_API_TOKEN missing');
  if (!projectId) throw new Error('RAILWAY_PROJECT_ID missing');

  const names = await fetchNames(token, projectId);
  const ms = days * 24 * 60 * 60 * 1000;
  const end = new Date(now);
  const mid = new Date(end.getTime() - ms);
  const start = new Date(mid.getTime() - ms);

  const current = await fetchWindow(token, projectId, mid.toISOString(), end.toISOString(), names);
  const previous = await fetchWindow(token, projectId, start.toISOString(), mid.toISOString(), names);

  // Same-key lookup so the email can put "was X" next to each line.
  const prevByKey = new Map(previous.items.map((i) => [`${i.service}|${i.environment}`, i]));
  for (const item of current.items) {
    item.previous = prevByKey.get(`${item.service}|${item.environment}`) || null;
  }

  const projectedMonthly = current.totals.total * (30 / days);

  return {
    projectName: names.projectName,
    days,
    generatedAt: end.toISOString(),
    current,
    previous,
    projectedMonthly,
    deltaTotal: current.totals.total - previous.totals.total,
  };
}

module.exports = { buildCostReport, fetchWindow, fetchNames, RATES };
