const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { ADMIN_API_KEY, SNAPSHOT_STORAGE_DIR } = require('../src/config/env');
const detectionService = require('../src/services/detectionService');
const workerService = require('../src/services/workerService');
const snapshotService = require('../src/services/snapshotService');

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

test('1. GET /api/workers/review-interface renders complete interactive UI panels', async () => {
  const res = await fetch(`${baseUrl}/api/workers/review-interface`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();

  // 1. Camera Snapshot Panel requirements
  assert.ok(html.includes('Station Cycles CCTV'), 'Should have station title');
  assert.ok(html.includes('Still Snapshot'), 'Must clearly specify still snapshot, not live video');
  assert.ok(html.includes('Refresh Snapshot'), 'Must have refresh snapshot button');
  assert.ok(html.includes('roi-image'), 'Must have snapshot image element');
  assert.ok(html.includes('snapshot-timestamp'), 'Must have snapshot timestamp element');
  assert.ok(html.includes('Channel 501'), 'Must reference ISAPI Channel 501');

  // 2. Detect Person Button requirements
  assert.ok(html.includes('btn-detect-person'), 'Must have detect person button element');
  assert.ok(html.includes('Detect Person'), 'Must have detect person button label');
  assert.ok(html.includes('/api/cameras/station/detect-workers'), 'Must call correct backend detection endpoint');
  assert.ok(html.includes('detection-result-box'), 'Must have detection result display container');

  // 3. Candidate Events Review requirements
  assert.ok(html.includes('Pending Candidate Events'), 'Must have candidate events section');
  assert.ok(html.includes('Assign Worker'), 'Must have assign worker element');
  assert.ok(html.includes('events-container'), 'Must have candidate events container');

  // 4. Attendance Records requirements
  assert.ok(html.includes('Worker Attendance Records'), 'Must have attendance records tab');
  assert.ok(html.includes('payrollImpact: none'), 'Must strictly declare payrollImpact: none');
  assert.ok(html.includes('attendance-table-body'), 'Must have attendance table body');

  // 5. Worker Management requirements
  assert.ok(html.includes('Worker Management'), 'Must have worker management tab');
  assert.ok(html.includes('workers-table-body'), 'Must have worker roster table body');
});

test('2. GET /api/workers/events/:eventId/snapshot requires auth and serves candidate image', async () => {
  // Create a real test snapshot file in SNAPSHOT_STORAGE_DIR
  const testSnapId = `snap_station_test_${Date.now()}`;
  const testFileName = `${testSnapId}.jpg`;
  const testFilePath = path.join(SNAPSHOT_STORAGE_DIR, testFileName);
  
  // Use a minimal valid 1x1 JPEG buffer or copy an existing image
  const sampleJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
    0x00, 0xbf, 0x00, 0xff, 0xd9
  ]);
  fs.writeFileSync(testFilePath, sampleJpeg);

  try {
    const mockDetections = {
      inferenceMs: 25,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      detections: [{ box: [350, 220, 90, 180], confidence: 0.85, class: 'person' }]
    };

    const processResult = await detectionService.processStationDetections(
      { timestamp: new Date().toISOString(), snapshotRef: testFileName },
      null,
      mockDetections
    );

    const eventId = processResult.events[0].eventId;

    // 1. Unauthenticated request rejected
    const unauthRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/snapshot`);
    assert.equal(unauthRes.status, 401);

    // 2. Non-existent event returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/workers/events/non_existent_event_id/snapshot`, {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    });
    assert.equal(notFoundRes.status, 404);

    // 3. Authorized request for existing event returns 200 image/jpeg
    const res = await fetch(`${baseUrl}/api/workers/events/${eventId}/snapshot`, {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/jpeg/);
    const imageBytes = await res.arrayBuffer();
    assert.equal(imageBytes.byteLength, sampleJpeg.length);
  } finally {
    if (fs.existsSync(testFilePath)) {
      try { fs.unlinkSync(testFilePath); } catch (_) {}
    }
  }
});

test('3. POST /api/cameras/station/detect-workers executes and guards against other shops', async () => {
  // 1. Unauthenticated request rejected
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/detect-workers`, {
    method: 'POST'
  });
  assert.equal(unauthRes.status, 401);

  // 2. Non-Station shop rejected (Camden)
  const camdenRes = await fetch(`${baseUrl}/api/cameras/camden/detect-workers`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(camdenRes.status, 400);

  // 3. Station execution succeeds: returns 200 with detection payload or clean camera status
  const res = await fetch(`${baseUrl}/api/cameras/station/detect-workers`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  if (data.status) {
    // In offline test environment, gracefully reports camera status without crashing
    assert.ok(['unreachable', 'not_configured', 'authentication_failed'].includes(data.status));
  } else {
    assert.equal(data.shopId, 'station');
    assert.equal(data.cameraLabel, 'Camera 05');
    assert.equal(typeof data.personsDetected, 'number');
    assert.equal(typeof data.inferenceMs, 'number');
    assert.ok(Array.isArray(data.events));
  }
});

test('4. End-to-end review UI workflow: detection -> pending review -> assignment -> attendance record', async () => {
  // Step 1: Process detection
  const mockDetections = {
    inferenceMs: 30,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [330, 210, 85, 170], confidence: 0.91, class: 'person' }]
  };

  const processResult = await detectionService.processStationDetections(
    { timestamp: '2026-10-10T14:00:00.000Z', snapshotRef: 'snap_station_ui_test.jpg' },
    null,
    mockDetections
  );
  const eventId = processResult.events[0].eventId;

  // Step 2: Fetch pending events
  const pendingRes = await fetch(`${baseUrl}/api/workers/events?status=pending_review`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(pendingRes.status, 200);
  const pendingData = await pendingRes.json();
  const targetEvent = pendingData.events.find((e) => e.eventId === eventId);
  assert.ok(targetEvent);
  assert.equal(targetEvent.reviewStatus, 'pending_review');
  assert.equal(targetEvent.assignedWorkerId, null);

  // Step 3: Get active worker from roster
  const workers = workerService.listWorkers({ shopId: 'station', activeOnly: true });
  assert.ok(workers.length > 0);
  const selectedWorker = workers[0];

  // Step 4: Manager submits manual assignment
  const verifyRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: selectedWorker.workerId,
      notes: 'Reviewed and confirmed worker in workshop bay from UI'
    })
  });
  assert.equal(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assert.equal(verifyData.event.reviewStatus, 'verified_worker');
  assert.equal(verifyData.event.assignedWorkerId, selectedWorker.workerId);

  // Step 5: Check that attendance record is updated and displayed
  const attRes = await fetch(`${baseUrl}/api/workers/attendance?shopId=station`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(attRes.status, 200);
  const attData = await attRes.json();
  const record = attData.records.find((r) => r.workerId === selectedWorker.workerId);
  assert.ok(record);
  assert.equal(record.reviewStatus, 'confirmed_presence');
  assert.equal(record.payrollImpact, 'none');
  assert.equal(record.payrollDeductionsEnabled, false);
});
