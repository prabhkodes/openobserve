// Copyright 2026 OpenObserve Inc.

/**
 * Shared API plumbing for the incidents-list "Alerts" column (alert_groups) e2e spec.
 *
 * The incidents list is enterprise/cloud-gated and empty on a fresh org, so the
 * spec has to fire alerts to create an incident before it can assert the grouped
 * `name ×count` chips. This module is the single source of truth for that
 * seeding/teardown; it deliberately contains NO test/expect calls — assertions
 * belong in the spec files.
 *
 * The alert payloads and log-shape mirror the proven
 * alerts-incident-correlation.spec.js setup (same correlating SQL dimensions), so
 * the three alerts fire into ONE incident and the junction table exposes one
 * alert group per distinct alert. Reuses alerts-api-helpers.js for the alert
 * CRUD + a self-delivering dogfood destination, and cloud-auth.js for auth.
 */

const testLogger = require('./test-logger.js');
const { isCloudEnvironment } = require('./cloud-auth.js');
const alertsApi = require('./alerts-api-helpers.js');

/** Shared stream — persists across runs (matches the correlation spec). */
const STREAM = 'e2e_incidents_rca';

/** Poll ceiling for an incident to appear after triggering (cloud is slower). */
const INCIDENT_POLL_TIMEOUT_MS = Number(
  process.env.O2_INCIDENTS_POLL_TIMEOUT_MS || (isCloudEnvironment() ? 300000 : 240000),
);
const INCIDENT_POLL_INTERVAL_MS = 15000;

/** Unique run id so parallel/repeat runs never collide on alert names. */
const makeRunId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The three alert names this run creates; every name carries the run id. */
const alertNames = (runId) => [
  `e2e_incrca_${runId}_payment_errors`,
  `e2e_incrca_${runId}_all_errors`,
  `e2e_incrca_${runId}_global_errors`,
];

/**
 * Log rows carrying the correlating semantic dimensions. Each row is tagged with
 * `run_id` so the alert SQL WHERE clauses isolate this run's data.
 */
function buildLogRows(runId) {
  const now = Date.now() * 1000; // microseconds
  const services = ['payment', 'checkout', 'inventory'];
  const deployments = ['payment-v1', 'checkout-v1', 'inventory-v1'];
  const records = [];
  for (let i = 0; i < 30; i++) {
    const svcIdx = i % 3;
    records.push({
      _timestamp: now - i * 10 * 1000000, // 10 seconds apart
      run_id: runId,
      k8s_cluster: 'e2e-cluster',
      k8s_deployment_name: deployments[svcIdx],
      k8s_namespace_name: 'production',
      service_name: services[svcIdx],
      severity: 17 + (i % 4), // 17-20 (ERROR-FATAL)
      log: `Error in ${services[svcIdx]}: request failed - e2e ${runId}`,
      level: 'error',
      host: `node-${(i % 3) + 1}`,
    });
  }
  return records;
}

/**
 * Three alerts whose SQL correlates into a single incident: different group
 * values on the same key_type (service/deployment). Mirrors the correlation spec.
 */
function buildCorrelatingAlerts(runId) {
  const [payment, all, global] = alertNames(runId);
  const base = (sql) => ({
    name: '',
    stream_type: 'logs',
    stream_name: STREAM,
    is_real_time: false,
    query_condition: { conditions: null, sql, promql: null, type: 'sql', aggregation: null },
    trigger_condition: {
      threshold: 1, operator: '>=', frequency: 1, silence: 0, period: 5, frequency_type: 'minutes',
    },
    destinations: [alertsApi.DEST],
    enabled: true,
    description: `E2E [${runId}] incidents-rca alert groups`,
    context_attributes: {},
  });

  const paymentAlert = base(
    `SELECT k8s_cluster, k8s_deployment_name, service_name, COUNT(*) as error_count FROM "${STREAM}" WHERE severity >= 17 AND service_name = 'payment' AND run_id = '${runId}' GROUP BY k8s_cluster, k8s_deployment_name, service_name`,
  );
  paymentAlert.name = payment;

  const allAlert = base(
    `SELECT k8s_cluster, k8s_deployment_name, COUNT(*) as error_count FROM "${STREAM}" WHERE severity >= 17 AND run_id = '${runId}' GROUP BY k8s_cluster, k8s_deployment_name`,
  );
  allAlert.name = all;

  const globalAlert = base(
    `SELECT COUNT(*) as total_errors FROM "${STREAM}" WHERE severity >= 17 AND run_id = '${runId}'`,
  );
  globalAlert.name = global;

  return [paymentAlert, allAlert, globalAlert];
}

/** Ingest the correlating log rows into the shared stream. */
async function ingestCorrelationLogs(page, runId) {
  const rows = buildLogRows(runId);
  const res = await alertsApi.ingest(page, STREAM, rows);
  testLogger.info('ingested correlation logs', { status: res.status(), records: rows.length });
  return res;
}

/** Create the three correlating alerts (idempotent via name suffix). */
async function createCorrelatingAlerts(page, runId) {
  let created = 0;
  for (const payload of buildCorrelatingAlerts(runId)) {
    const res = await alertsApi.createAlert(page, payload);
    if (res.ok()) created += 1;
    else testLogger.warn(`create alert ${payload.name}`, { status: res.status() });
  }
  testLogger.info('correlating alerts created', { created });
  return created;
}

/** Force-fire each of the run's alerts so incidents form without the scheduler. */
async function triggerCorrelatingAlerts(page, runId) {
  let triggered = 0;
  for (const name of alertNames(runId)) {
    const id = await alertsApi.findAlertId(page, name);
    if (!id) {
      testLogger.warn(`alert not found to trigger: ${name}`);
      continue;
    }
    const url = `${alertsApi.urls().v2}/alerts/${encodeURIComponent(id)}/trigger?folder=default`;
    const res = await alertsApi.api(page, 'patch', url);
    if (res.ok()) triggered += 1;
    else testLogger.warn(`trigger ${name}`, { status: res.status() });
  }
  testLogger.info('correlating alerts triggered', { triggered });
  return triggered;
}

/** List incidents via the enterprise incidents API. */
async function listIncidents(page, { status, keyword } = {}) {
  let url = `${alertsApi.urls().v2}/alerts/incidents?limit=100&offset=0`;
  if (status) url += `&status=${status}`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
  const res = await alertsApi.api(page, 'get', url);
  if (!res.ok()) return [];
  const body = await res.json().catch(() => ({}));
  return body.incidents || body.list || [];
}

/** The first open incident this run created, matched by title or alert group name. */
async function findRunIncident(page, runId, status = 'open') {
  const incidents = await listIncidents(page, { status });
  return (
    incidents.find((i) => {
      if ((i.title || '').includes(runId)) return true;
      return (i.alert_groups || []).some((g) => (g.alert_name || '').includes(runId));
    }) || null
  );
}

/** Poll until this run's incident appears, or the timeout elapses. */
async function waitForRunIncident(page, runId, timeoutMs = INCIDENT_POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let found = null;
  while (Date.now() < deadline) {
    found = await findRunIncident(page, runId);
    if (found) {
      testLogger.info('incident appeared', { title: found.title, groups: found.alert_groups?.length });
      return found;
    }
    testLogger.info(`no incident for run ${runId} yet, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, INCIDENT_POLL_INTERVAL_MS));
  }
  testLogger.warn(`timed out waiting for incident for run ${runId}`);
  return null;
}

/**
 * One-shot seeding for a run: dogfood destination (idempotent), ingest the
 * correlating logs, create the three alerts, then force-fire them.
 */
async function seedIncidentFixtures(page, runId) {
  await alertsApi.seedAlertFixtures(page);
  await ingestCorrelationLogs(page, runId);
  await createCorrelatingAlerts(page, runId);
  await triggerCorrelatingAlerts(page, runId);
}

/** Best-effort teardown: resolve run incidents, then delete the run's alerts. */
async function teardownIncidentFixtures(page, runId) {
  await resolveRunIncidents(page, runId);
  await cleanupRunAlerts(page, runId);
}

/** Resolve this run's open incidents (best-effort; incidents cannot be deleted). */
async function resolveRunIncidents(page, runId) {
  const open = await listIncidents(page, { status: 'open' });
  let resolved = 0;
  for (const incident of open) {
    if (!(incident.title || '').includes(runId)) continue;
    const url = `${alertsApi.urls().v2}/alerts/incidents/${encodeURIComponent(incident.id)}/update`;
    const res = await alertsApi.api(page, 'patch', url, { status: 'resolved' });
    if (res.ok()) resolved += 1;
  }
  testLogger.info('resolved run incidents', { resolved });
  return resolved;
}

/** Delete this run's alerts (stream data persists). */
async function cleanupRunAlerts(page, runId) {
  const ids = [];
  for (const name of alertNames(runId)) {
    const id = await alertsApi.findAlertId(page, name);
    if (id) ids.push(id);
  }
  await alertsApi.deleteAlerts(page, ids);
  testLogger.info('deleted run alerts', { deleted: ids.length });
  return ids.length;
}

module.exports = {
  STREAM,
  makeRunId,
  alertNames,
  buildLogRows,
  buildCorrelatingAlerts,
  ingestCorrelationLogs,
  createCorrelatingAlerts,
  triggerCorrelatingAlerts,
  listIncidents,
  findRunIncident,
  waitForRunIncident,
  seedIncidentFixtures,
  teardownIncidentFixtures,
  resolveRunIncidents,
  cleanupRunAlerts,
};
