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

test('1. Shift reconciliation correctly incorporates manager-recorded manual audit corrections', async () => {
  // Morning candidate event (mechanic A)
  const res = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T08:35:00.000Z', snapshotRef: 'phase9_recon_1.jpg' }, // 09:35 BST
    null,
    {
      inferenceMs: 40,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [300, 220, 80, 160], confidence: 0.88, class: 'person' }]
    }
  );
  const eventId = res.events[0].eventId;

  // Manager approves mechanic A
  detectionService.verifyWorkerEvent(eventId, 'approve_worker', 'Mechanic A verified', 'manager_dan');

  // Manager performs physical floor walk and discovers Mechanic B was in deep storage blind spot (missed by camera)
  const correction = detectionService.recordManualAuditCorrection(
    'station',
    '2026-10-09',
    'morning',
    'missed_detection',
    'Mechanic B working in deep storage alcove not visible to Camera 05',
    'manager_dan'
  );
  assert.ok(correction.correctionId);
  assert.equal(correction.correctionType, 'missed_detection');

  // Fetch reconciliation report
  const report = detectionService.generateShiftReconciliationReport('station', '2026-10-09');
  assert.equal(report.shifts.morning.summary.managerVerifiedWorkers, 1);
  assert.equal(report.shifts.morning.summary.manualCorrections.totalReported, 1);
  assert.equal(report.shifts.morning.summary.manualCorrections.knownMissedDetections, 1);
  assert.equal(report.totalReconciliationSummary.totalManualMissedDetectionsReported, 1);
  assert.equal(report.totalReconciliationSummary.allAttendanceDecisionsManual, true);
});

test('2. POST /api/cameras/:shopId/reconciliation/corrections records correction via authorized API', async () => {
  // Unauthorized
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/reconciliation/corrections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shiftDate: '2026-10-09',
      shiftKey: 'afternoon',
      correctionType: 'duplicate_anomaly',
      notes: 'Customer tagged twice due to rapid turn'
    })
  });
  assert.equal(unauthRes.status, 401);

  // Authorized
  const authRes = await fetch(`${baseUrl}/api/cameras/station/reconciliation/corrections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-api-key': ADMIN_API_KEY
    },
    body: JSON.stringify({
      shiftDate: '2026-10-09',
      shiftKey: 'afternoon',
      correctionType: 'duplicate_anomaly',
      notes: 'Customer tagged twice due to rapid turn'
    })
  });
  assert.equal(authRes.status, 201);
  const data = await authRes.json();
  assert.equal(data.message, 'Manual audit correction recorded successfully');
  assert.ok(data.correction.correctionId);
  assert.equal(data.correction.shiftKey, 'afternoon');
});

test('3. Candidate event IDs are strictly stable and deduplication merges retries without new event creation', async () => {
  const fakeSnapshot1 = {
    timestamp: '2026-10-09T10:00:00.000Z',
    snapshotRef: 'stable_id_1.jpg'
  };
  const mockDetections = {
    inferenceMs: 38,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 200, 80, 160], confidence: 0.89, class: 'person' }]
  };

  // Frame 1
  const res1 = await detectionService.processStationDetections(fakeSnapshot1, null, mockDetections);
  assert.equal(res1.events[0].isNewArrival, true);
  const initialEventId = res1.events[0].eventId;
  const initialSessionId = res1.events[0].sessionId;

  // Frame 2 (consecutive frame at t=25s)
  const fakeSnapshot2 = {
    timestamp: '2026-10-09T10:00:25.000Z',
    snapshotRef: 'stable_id_2.jpg'
  };
  const res2 = await detectionService.processStationDetections(fakeSnapshot2, null, mockDetections);
  assert.equal(res2.events[0].isNewArrival, false);
  assert.equal(res2.events[0].sessionId, initialSessionId);

  // Total candidate events in store remains 1 (no duplicate event created)
  const allEvents = detectionService.listWorkerEvents({ shopId: 'station' });
  assert.equal(allEvents.length, 1);
  assert.equal(allEvents[0].eventId, initialEventId);
});

test('4. British Summer Time (BST) and Winter (GMT) shift boundaries correctly map to London civil hours', () => {
  // Test case 1: Summer BST morning shift start (08:30 London = 07:30 UTC)
  const bstMorning = new Date('2026-07-15T07:30:00.000Z');
  const bstParts = detectionService.getLondonTimeParts(bstMorning);
  assert.equal(bstParts.hour, 8);
  assert.equal(bstParts.minute, 30);
  assert.equal(detectionService.isWithinShiftHours(bstMorning), true);

  // Test case 2: Winter GMT morning shift start (08:30 London = 08:30 UTC)
  const gmtMorning = new Date('2026-01-14T08:30:00.000Z');
  const gmtParts = detectionService.getLondonTimeParts(gmtMorning);
  assert.equal(gmtParts.hour, 8);
  assert.equal(gmtParts.minute, 30);
  assert.equal(detectionService.isWithinShiftHours(gmtMorning), true);

  // Test case 3: Summer BST evening close (18:00 London = 17:00 UTC)
  const bstEvening = new Date('2026-07-15T17:00:00.000Z');
  const bstEveParts = detectionService.getLondonTimeParts(bstEvening);
  assert.equal(bstEveParts.hour, 18);
  assert.equal(bstEveParts.minute, 0);
  assert.equal(detectionService.isWithinShiftHours(bstEvening), true);

  // Test case 4: After-hours (18:05 London = 17:05 UTC)
  const bstAfterHours = new Date('2026-07-15T17:05:00.000Z');
  assert.equal(detectionService.isWithinShiftHours(bstAfterHours), false);
});
