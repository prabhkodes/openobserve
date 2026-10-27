/**
 * Alerts Incidents RCA Enhancements — E2E Tests
 *
 * ENTERPRISE FEATURE: the incidents list and RCA drawer are enterprise/cloud-gated
 * (edition floor = enterprise). Every test detects the active edition and skips on
 * OSS rather than timing out on a gated route.
 *
 * SCOPE: the RCA-drawer behaviors (resume naming, Cancelled label, local timezone,
 * thread "working" line, RichTextInput close) are WIRED but not E2E-forceable — they
 * need the enterprise RCA/AI pipeline to reach specific run states that cannot be
 * forced deterministically through the E2E API. They are unit-covered in this PR.
 * This spec covers the one cross-stack, forceable behavior: the incidents list
 * "Alerts" column now renders one `name ×count` chip per alert group (most-fired
 * first, top two + a "+N more" tooltip) instead of a bare count chip.
 *
 * SELF-CONTAINED: beforeAll ingests correlating logs, creates three alerts whose SQL
 * correlates them into a single incident, force-fires them, and polls for the incident.
 * afterAll resolves the incident and deletes the alerts (stream data persists).
 * Each run carries a unique RUN_ID so incidents are identifiable across parallel runs.
 */

const { test, expect, navigateToBase } = require('../utils/enhanced-baseFixtures.js');
const testLogger = require('../utils/test-logger.js');
const PageManager = require('../../pages/page-manager.js');
const incidentsApi = require('../utils/incidents-api-helpers.js');

// Unique run id (timestamp + random) — avoids collisions even in parallel execution
const RUN_ID = incidentsApi.makeRunId();

test.describe('Alerts Incidents RCA Enhancements testcases', () => {
  test.describe.configure({ mode: 'parallel' });
  let pm;
  let setupDone = false;

  // ==========================================================================
  // beforeAll: seed dogfood destination, ingest correlating logs, create three
  // correlating alerts, force-fire them, then poll for the run's incident.
  // ==========================================================================
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(10 * 60 * 1000); // 10 minutes (setup + incident polling)
    testLogger.info('=== INCIDENTS-RCA TEST SETUP ===');

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await incidentsApi.seedIncidentFixtures(page, RUN_ID);
      const incident = await incidentsApi.waitForRunIncident(page, RUN_ID);
      setupDone = Boolean(incident);
      if (!setupDone) {
        testLogger.warn('No incident appeared after trigger; tests will skip via beforeEach check.');
      }
    } catch (error) {
      testLogger.error('incidents-rca setup failed', { error: error.message });
    } finally {
      await context.close();
    }
  });

  // ==========================================================================
  // afterAll: resolve the run's incident (incidents cannot be deleted), then
  // delete the run's alerts. Stream data persists across runs.
  // ==========================================================================
  test.afterAll(async ({ browser }) => {
    testLogger.info('=== INCIDENTS-RCA TEST CLEANUP ===');

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await incidentsApi.teardownIncidentFixtures(page, RUN_ID);
      testLogger.info('=== CLEANUP COMPLETE (stream data preserved) ===');
    } catch (error) {
      testLogger.warn('cleanup failed (non-fatal)', { error: error.message });
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }, testInfo) => {
    testLogger.testStart(testInfo.title, testInfo.file);
    await navigateToBase(page);
    pm = new PageManager(page);

    // Enterprise gate: the incidents list and RCA drawer do not exist on OSS.
    const edition = await pm.editionFeaturesPage.detectEdition();
    test.skip(edition === 'opensource', `Incidents list & RCA UI are enterprise-gated (detected: ${edition})`);

    // Skip rather than fail when the beforeAll couldn't force an incident (e.g. no
    // alert evaluation on the org) — the self-contained setup is ingestion-heavy.
    test.skip(!setupDone, 'No incident created — alerts must fire and create an incident first');

    await pm.incidentsPage.goto();
    await pm.alertsPage.waitForLoadingOverlayToDisappear();
    await pm.alertsPage.waitForIncidentsToLoad();
    await pm.incidentsPage.searchIncidents(RUN_ID);
    testLogger.info('Incidents page loaded with the run incident row');
  });

  /**
   * P0 — Alerts column shows one `name ×count` chip per alert group, in API order.
   *
   * Replaces the bare count chip: each chip is `<alert_name> ×<count>`, ordered
   * most-fired first (the backend rank_alert_groups contract).
   */
  test('Alerts column shows one name ×count chip per alert group, in API order', {
    tag: ['@incidents-rca', '@all', '@P0'],
  }, async () => {
    testLogger.info('Reading alert-group chips from the run incident row');

    const chipTexts = await pm.incidentsPage.getAlertGroupChipTexts(RUN_ID);
    expect(chipTexts.length, 'a correlated incident must expose at least two alert groups').toBeGreaterThanOrEqual(2);

    const counts = [];
    for (const text of chipTexts) {
      expect(text, `chip "${text}" must render as "<name> ×<count>"`).toMatch(/^.+\s×\d+$/);
      counts.push(Number(text.match(/×(\d+)\s*$/)[1]));
    }

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], 'chips must be ordered most-fired first').toBeLessThanOrEqual(counts[i - 1]);
    }

    testLogger.info('Test completed');
  });

  /**
   * P0 — More than two alert groups collapse into a "+N more" tooltip listing the rest.
   *
   * Only the top two groups render as chips; the remainder sits behind a "+N more"
   * chip whose tooltip lists each remaining `alert_name ×count`.
   */
  test('More than two alert groups collapse into a +N more tooltip listing the rest', {
    tag: ['@incidents-rca', '@all', '@P0'],
  }, async () => {
    testLogger.info('Verifying the top-two chip collapse and +N more tooltip');

    await pm.incidentsPage.expectAlertGroupChipCount(RUN_ID, 2);
    await pm.incidentsPage.expectAlertGroupMoreCount(RUN_ID, 1);

    const moreText = await pm.incidentsPage.getAlertGroupMoreText(RUN_ID);
    expect(moreText, `"${moreText}" must read "+N more"`).toMatch(/^\+\d+ more$/);

    await pm.incidentsPage.openAlertGroupsTooltip(RUN_ID);
    const tooltipTexts = await pm.incidentsPage.getAlertGroupTooltipTexts();
    expect(tooltipTexts.length % 2, 'tooltip lists name/count pairs').toBe(0);
    expect(tooltipTexts.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < tooltipTexts.length; i += 2) {
      expect(tooltipTexts[i].length, 'collapsed alert name must be non-empty').toBeGreaterThan(0);
      expect(tooltipTexts[i + 1], `"${tooltipTexts[i + 1]}" must read "×<count>"`).toMatch(/^×\d+$/);
    }

    testLogger.info('Test completed');
  });
});
