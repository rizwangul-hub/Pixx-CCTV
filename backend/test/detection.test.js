const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { ADMIN_API_KEY, SNAPSHOT_STORAGE_DIR } = require('../src/config/env');
const detectionService = require('../src/services/detectionService');
const { resetShops } = require('../src/services/cameraService');

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
  resetShops();
});

test('1. POST /api/cameras/:shopId/detect-workers requires administrator authentication', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/station/detect-workers`, {
    method: 'POST'
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Unauthorized');
});

test('2. POST /api/cameras/:shopId/detect-workers rejects shops other than Station', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/detect-workers`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.details, /Station only/i);
});

test('3. Evaluates person detection on actual Station Camera 05 snapshot', async () => {
  const snapshotFile = 'snap_station_1791559172253_acdd72bd.jpg';
  const filePath = path.join(SNAPSHOT_STORAGE_DIR, snapshotFile);

  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    const result = await detectionService.detectPersons(buffer);

    assert.equal(typeof result.inferenceMs, 'number');
    assert.ok(result.inferenceMs < 2000); // Standard CPU inference is fast (accommodates first-time ONNX initialization)
    assert.equal(result.imageDimensions.width, 704);
    assert.equal(result.imageDimensions.height, 576);
    // Verified empty scene has 0 detected persons
    assert.equal(result.personCount, 0);
    assert.equal(result.detections.length, 0);
  }
});

test('4. Spatial IoU calculation accurately measures overlap', () => {
  const box1 = [100, 100, 50, 100];
  const box2 = [100, 100, 50, 100];
  assert.equal(detectionService.calculateIoU(box1, box2), 1.0);

  const boxNonOverlap = [300, 300, 50, 50];
  assert.equal(detectionService.calculateIoU(box1, boxNonOverlap), 0.0);

  const boxPartial = [125, 100, 50, 100]; // 50% horizontal overlap
  const iou = detectionService.calculateIoU(box1, boxPartial);
  assert.ok(iou > 0.3 && iou < 0.4);
});

test('5. De-duplication merges consecutive snapshots of the same person into one session', async () => {
  const fakeSnapshot1 = {
    timestamp: '2026-10-09T10:00:00.000Z',
    snapshotRef: 'fake_1.jpg'
  };
  const fakeSnapshot2 = {
    timestamp: '2026-10-09T10:00:30.000Z', // 30 seconds later
    snapshotRef: 'fake_2.jpg'
  };

  const mockDetections = {
    inferenceMs: 40,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [250, 200, 80, 160], confidence: 0.88, class: 'person' }]
  };

  // Frame 1
  const res1 = await detectionService.processStationDetections(fakeSnapshot1, null, mockDetections);
  assert.equal(res1.events.length, 1);
  assert.equal(res1.events[0].type, 'new_candidate_detected');
  assert.equal(res1.events[0].isNewArrival, true);
  const sessionId = res1.events[0].sessionId;

  // Frame 2 (consecutive, overlapping box)
  const res2 = await detectionService.processStationDetections(fakeSnapshot2, null, mockDetections);
  assert.equal(res2.events.length, 1);
  assert.equal(res2.events[0].type, 'session_update');
  assert.equal(res2.events[0].isNewArrival, false);
  assert.equal(res2.events[0].sessionId, sessionId);
  assert.equal(res2.events[0].sampleCount, 2);
  assert.equal(res2.events[0].dwellTimeSeconds, 30);
});

test('6. Non-biometric qualification treats person detection and worker identity separately', async () => {
  const mockDetections = {
    inferenceMs: 35,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.92, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T11:00:00.000Z', snapshotRef: 'test.jpg' },
    null,
    mockDetections
  );

  const eventList = detectionService.listWorkerEvents();
  assert.equal(eventList.length, 1);
  const event = eventList[0];

  // Person detected is NOT automatically marked as an employee
  assert.equal(event.reviewStatus, 'pending_review');
  assert.equal(event.payrollImpact, 'none');
  assert.equal(event.cameraLabel, 'Camera 05');
  assert.equal(event.detectionConfidence, 0.92);
  assert.equal(event.qualificationCriteria.withinShiftHours, true);
  assert.equal(event.qualificationCriteria.inWorkshopBay, true);
  assert.equal(event.qualificationCriteria.candidateRole, 'candidate_worker');
});

test('7. Manager review workflow allows approval or dismissal without automated payroll', async () => {
  const mockDetections = {
    inferenceMs: 35,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.85, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T11:00:00.000Z', snapshotRef: 'test.jpg' },
    null,
    mockDetections
  );

    const eventsRes = await fetch(`${baseUrl}/api/workers/events`, {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    });
    assert.equal(eventsRes.status, 200);
    const eventsData = await eventsRes.json();
    assert.equal(eventsData.count, 1);
    const eventId = eventsData.events[0].eventId;

    // Manager approves worker event with notes
    const verifyRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
      method: 'PATCH',
      headers: {
        'x-admin-api-key': ADMIN_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'approve_worker',
        notes: 'Confirmed technician John servicing bicycle rack'
      })
    });

    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.event.reviewStatus, 'verified_worker');
    assert.equal(verifyData.event.managerResolution, 'approve_worker');
    assert.equal(verifyData.event.reviewerNotes, 'Confirmed technician John servicing bicycle rack');
    assert.equal(verifyData.event.payrollImpact, 'none'); // Still no automated payroll deduction
});

test('8. Manager review rejects invalid review actions', async () => {
  const badActionRes = await fetch(`${baseUrl}/api/workers/events/non-existent-id/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'invalid_action' })
  });
  assert.equal(badActionRes.status, 400);
});
