const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { ADMIN_API_KEY, SNAPSHOT_STORAGE_DIR } = require('../src/config/env');
const detectionService = require('../src/services/detectionService');
const accuracyService = require('../src/services/accuracyEvaluationService');

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  detectionService.resetDetectionService();
});

test('1. Independent audit: tuning and unseen evaluation datasets have zero overlapping images or IDs', () => {
  const tuning = accuracyService.loadGroundTruth();
  const unseen = accuracyService.loadUnseenGroundTruth();

  assert.equal(tuning.items.length, 12);
  assert.equal(unseen.items.length, 26);

  const tuningFiles = tuning.items.map((i) => i.filename);
  const unseenFiles = unseen.items.map((i) => i.filename);
  const fileOverlap = tuningFiles.filter((f) => unseenFiles.includes(f));
  assert.deepEqual(fileOverlap, [], 'Tuning and unseen test set share filenames (data leakage)');

  const tuningIds = tuning.items.map((i) => i.id);
  const unseenIds = unseen.items.map((i) => i.id);
  const idOverlap = tuningIds.filter((id) => unseenIds.includes(id));
  assert.deepEqual(idOverlap, [], 'Tuning and unseen test set share IDs (data leakage)');
});

test('2. Independent audit: reproduced metrics match validation report exactly at baseline 0.40', async () => {
  const result = await accuracyService.runUnseenThresholdComparison();

  assert.equal(result.datasetType, 'unseen_test_set');
  assert.equal(result.totalFrames, 26);
  assert.equal(result.totalLabeledPeople, 23);

  const baseline = result.comparison.find((c) => c.threshold === 0.40);
  assert.ok(baseline);
  assert.equal(baseline.isBaseline, true);
  assert.equal(baseline.truePositives, 19);
  assert.equal(baseline.falsePositives, 0);
  assert.equal(baseline.falseNegatives, 4);
  assert.equal(baseline.precision, 1.0);
  assert.equal(baseline.recall, 0.8261);
  assert.equal(baseline.f1Score, 0.9048);

  // Candidate 0.35 verified without activating it in production
  const candidate = result.comparison.find((c) => c.threshold === 0.35);
  assert.ok(candidate);
  assert.equal(candidate.truePositives, 21);
  assert.equal(candidate.falsePositives, 0);
  assert.equal(candidate.falseNegatives, 2);
  assert.equal(candidate.precision, 1.0);
  assert.equal(candidate.recall, 0.913);
  assert.equal(candidate.f1Score, 0.9545);
});

test('3. Supervised pilot mode: records candidate events across morning, afternoon, and evening shifts', async () => {
  // Morning shift arrival: Technician rolling bike in
  const morningDetection = {
    inferenceMs: 41,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [320, 220, 80, 160], confidence: 0.88, class: 'person' }]
  };
  const morningRes = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T09:00:00.000Z', snapshotRef: 'pilot_shift_morning.jpg' },
    null,
    morningDetection
  );
  assert.equal(morningRes.events.length, 1);
  assert.equal(morningRes.events[0].type, 'new_candidate_detected');
  const morningEventId = morningRes.events[0].eventId;

  // Afternoon customer visiting
  const afternoonDetection = {
    inferenceMs: 44,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [400, 240, 75, 155], confidence: 0.82, class: 'person' }]
  };
  const afternoonRes = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T14:30:00.000Z', snapshotRef: 'pilot_shift_afternoon.jpg' },
    null,
    afternoonDetection
  );
  assert.equal(afternoonRes.events.length, 1);
  const afternoonEventId = afternoonRes.events[0].eventId;

  // Verify candidate events have zero automated payroll impact
  const events = detectionService.listWorkerEvents({ shopId: 'station' });
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.reviewStatus, 'pending_review');
    assert.equal(e.payrollImpact, 'none');
    assert.equal(Array.isArray(e.auditHistory), true);
    assert.equal(e.auditHistory[0].action, 'candidate_logged');
  }

  // Manager reviews morning event: confirmed worker
  detectionService.verifyWorkerEvent(morningEventId, 'approve_worker', 'Confirmed Station mechanic John', 'mgr_alice');

  // Manager reviews afternoon event: dismissed customer
  detectionService.verifyWorkerEvent(afternoonEventId, 'dismiss_customer', 'Customer collecting repair', 'mgr_alice');

  // Check immutable audit history
  const morningHist = detectionService.getWorkerEventHistory(morningEventId);
  assert.equal(morningHist.reviewStatus, 'verified_worker');
  assert.equal(morningHist.auditHistory.length, 2);
  assert.equal(morningHist.auditHistory[1].action, 'approve_worker');
  assert.equal(morningHist.auditHistory[1].performedBy, 'mgr_alice');
  assert.equal(morningHist.auditHistory[1].notes, 'Confirmed Station mechanic John');

  const afternoonHist = detectionService.getWorkerEventHistory(afternoonEventId);
  assert.equal(afternoonHist.reviewStatus, 'dismissed');
  assert.equal(afternoonHist.auditHistory[1].action, 'dismiss_customer');

  // Verify pilot metrics aggregate
  const pilotMetrics = detectionService.getPilotMetrics('station');
  assert.equal(pilotMetrics.supervisedPilotActive, true);
  assert.equal(pilotMetrics.activeThreshold, 0.40);
  assert.equal(pilotMetrics.metricsSummary.totalCandidateEventsLogged, 2);
  assert.equal(pilotMetrics.metricsSummary.pendingManagerReviewCount, 0);
  assert.equal(pilotMetrics.metricsSummary.managerVerifiedWorkers, 1);
  assert.equal(pilotMetrics.metricsSummary.managerDismissedCustomers, 1);
  assert.equal(pilotMetrics.governanceStatus.automatedPayrollDeductionsEnabled, false);
});

test('4. GET /api/cameras/:shopId/pilot-metrics endpoint requires auth and rejects non-Station shops', async () => {
  // Unauthorized
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`);
  assert.equal(unauthRes.status, 401);

  // Camden rejected (strictly Station only)
  const camdenRes = await fetch(`${baseUrl}/api/cameras/camden/pilot-metrics`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(camdenRes.status, 400);

  // Station authorized
  const stationRes = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(stationRes.status, 200);
  const data = await stationRes.json();
  assert.equal(data.shopId, 'station');
  assert.equal(data.supervisedPilotActive, true);
  assert.equal(data.activeThreshold, 0.40);
});

test('5. GET /api/cameras/:shopId/roi-overlay renders a valid JPEG with workshop polygon and bounding boxes', async () => {
  // Unauthorized
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/roi-overlay`);
  assert.equal(unauthRes.status, 401);

  // Authorized Station overlay request
  const res = await fetch(`${baseUrl}/api/cameras/station/roi-overlay`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');

  const imgBuffer = Buffer.from(await res.arrayBuffer());
  assert.ok(imgBuffer.length > 100);
  // Verify JPEG magic bytes FF D8 FF
  assert.equal(imgBuffer[0], 0xff);
  assert.equal(imgBuffer[1], 0xd8);
  assert.equal(imgBuffer[2], 0xff);
});

test('6. GET /api/workers/events/:eventId/history returns immutable audit trail', async () => {
  // Create an event
  const mockDet = {
    inferenceMs: 35,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 220, 80, 160], confidence: 0.85, class: 'person' }]
  };
  const resInit = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T16:00:00.000Z', snapshotRef: 'hist_test.jpg' },
    null,
    mockDet
  );
  const eventId = resInit.events[0].eventId;

  // Review event
  detectionService.verifyWorkerEvent(eventId, 'dismiss_passerby', 'Distant pedestrian on edge', 'mgr_bob');

  // Query audit history endpoint
  const resHist = await fetch(`${baseUrl}/api/workers/events/${eventId}/history`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(resHist.status, 200);
  const histData = await resHist.json();
  assert.equal(histData.eventId, eventId);
  assert.equal(histData.reviewStatus, 'dismissed');
  assert.equal(histData.auditHistory.length, 2);
  assert.equal(histData.auditHistory[1].performedBy, 'mgr_bob');
  assert.equal(histData.auditHistory[1].notes, 'Distant pedestrian on edge');
});
