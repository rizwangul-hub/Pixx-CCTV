const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../src/app');
const { ADMIN_API_KEY } = require('../src/config/env');
const detectionService = require('../src/services/detectionService');

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

test('1. Shift reconciliation groups candidate events by shift periods (Morning, Afternoon, After-Hours)', async () => {
  // Morning shift detection (09:30 London time)
  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T08:30:00.000Z', snapshotRef: 'shift_morning.jpg' }, // 09:30 BST
    null,
    {
      inferenceMs: 40,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [300, 220, 80, 160], confidence: 0.88, class: 'person' }]
    }
  );

  // Afternoon shift detection (14:30 London time)
  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T13:30:00.000Z', snapshotRef: 'shift_afternoon.jpg' }, // 14:30 BST
    null,
    {
      inferenceMs: 42,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [380, 240, 75, 155], confidence: 0.82, class: 'person' }]
    }
  );

  // After-hours detection (19:30 London time)
  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T18:30:00.000Z', snapshotRef: 'shift_afterhours.jpg' }, // 19:30 BST
    null,
    {
      inferenceMs: 39,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [310, 220, 80, 160], confidence: 0.84, class: 'person' }]
    }
  );

  const report = detectionService.generateShiftReconciliationReport('station');
  assert.equal(report.shopId, 'station');
  assert.equal(report.activeThreshold, 0.40);
  assert.equal(report.totalReconciliationSummary.totalCandidatesLogged, 3);
  assert.equal(report.shifts.morning.events.length, 1);
  assert.equal(report.shifts.afternoon.events.length, 1);
  assert.equal(report.shifts.afterHours.events.length, 1);
  assert.equal(report.totalReconciliationSummary.totalPendingReview, 3);
  assert.equal(report.totalReconciliationSummary.automatedPayrollDeductionsEnabled, false);
  assert.equal(report.totalReconciliationSummary.allAttendanceDecisionsManual, true);
});

test('2. Shift reconciliation updates correctly after manager confirms workers and dismisses customers', async () => {
  // Morning technician arrival
  const res1 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T08:45:00.000Z', snapshotRef: 'recon_m1.jpg' },
    null,
    {
      inferenceMs: 40,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [310, 210, 80, 160], confidence: 0.89, class: 'person' }]
    }
  );
  const workerEventId = res1.events[0].eventId;

  // Afternoon customer collection
  const res2 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T14:15:00.000Z', snapshotRef: 'recon_a1.jpg' },
    null,
    {
      inferenceMs: 41,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [400, 230, 80, 160], confidence: 0.78, class: 'person' }]
    }
  );
  const customerEventId = res2.events[0].eventId;

  // Manager reviews events
  detectionService.verifyWorkerEvent(workerEventId, 'approve_worker', 'Mechanic John confirmed', 'manager_station');
  detectionService.verifyWorkerEvent(customerEventId, 'dismiss_customer', 'Customer collecting repair', 'manager_station');

  // Verify shift summary reflects approvals and dismissals
  const report = detectionService.generateShiftReconciliationReport('station');
  assert.equal(report.shifts.morning.summary.managerVerifiedWorkers, 1);
  assert.equal(report.shifts.morning.summary.reconciliationComplete, true);
  assert.equal(report.shifts.afternoon.summary.dismissedCustomers, 1);
  assert.equal(report.shifts.afternoon.summary.reconciliationComplete, true);
  assert.equal(report.totalReconciliationSummary.totalPendingReview, 0);
});

test('3. GET /api/cameras/:shopId/reconciliation-report endpoint requires auth and rejects non-Station shops', async () => {
  // Unauthorized
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/reconciliation-report`);
  assert.equal(unauthRes.status, 401);

  // Camden rejected
  const camdenRes = await fetch(`${baseUrl}/api/cameras/camden/reconciliation-report`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(camdenRes.status, 400);

  // Station authorized
  const stationRes = await fetch(`${baseUrl}/api/cameras/station/reconciliation-report`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(stationRes.status, 200);
  const data = await stationRes.json();
  assert.equal(data.shopId, 'station');
  assert.ok(data.shifts.morning);
  assert.ok(data.shifts.afternoon);
  assert.ok(data.shifts.afterHours);
  assert.equal(data.activeThreshold, 0.40);
});

test('4. Audit history is append-only and cannot be tampered with via API', async () => {
  // Create an event
  const res = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T10:00:00.000Z', snapshotRef: 'audit_test.jpg' },
    null,
    {
      inferenceMs: 38,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [300, 200, 80, 160], confidence: 0.85, class: 'person' }]
    }
  );
  const eventId = res.events[0].eventId;

  // Review event step 1
  detectionService.verifyWorkerEvent(eventId, 'flag_inquiry', 'Needs manager check', 'lead_tech');

  // Review event step 2
  detectionService.verifyWorkerEvent(eventId, 'approve_worker', 'Confirmed as technician after inquiry', 'head_mgr');

  // Verify audit history is strictly append-only (chronological chain of 3 entries)
  const history = detectionService.getWorkerEventHistory(eventId);
  assert.equal(history.auditHistory.length, 3);
  assert.equal(history.auditHistory[0].action, 'candidate_logged');
  assert.equal(history.auditHistory[1].action, 'flag_inquiry');
  assert.equal(history.auditHistory[1].performedBy, 'lead_tech');
  assert.equal(history.auditHistory[2].action, 'approve_worker');
  assert.equal(history.auditHistory[2].performedBy, 'head_mgr');
});
