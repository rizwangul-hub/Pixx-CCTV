const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { ADMIN_API_KEY, SNAPSHOT_STORAGE_DIR } = require('../src/config/env');
const arrivalSchedulerService = require('../src/services/arrivalSchedulerService');
const detectionService = require('../src/services/detectionService');
const workerService = require('../src/services/workerService');
const snapshotService = require('../src/services/snapshotService');

let server;
let baseUrl;

// Sample valid minimal JPEG buffer
const VALID_JPEG = Buffer.from([
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

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  arrivalSchedulerService.stopArrivalScheduler();
  await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => {
  arrivalSchedulerService.resetSchedulerState();
  detectionService.resetDetectionService();
});

test('1. Arrival Scheduler Lifecycle: singleton start, stop, and status endpoint', async () => {
  // Unauthenticated request rejected
  const unauthRes = await fetch(`${baseUrl}/api/cameras/station/scheduler-status`);
  assert.equal(unauthRes.status, 401);

  // Shop scoping: rejects non-Station shops
  const nonStationRes = await fetch(`${baseUrl}/api/cameras/camden/scheduler-status`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(nonStationRes.status, 400);

  // Initial stopped state
  const statusRes = await fetch(`${baseUrl}/api/cameras/station/scheduler-status`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(statusRes.status, 200);
  const initialStatus = await statusRes.json();
  assert.equal(initialStatus.shopId, 'station');
  assert.equal(initialStatus.cameraLabel, 'Camera 05');
  assert.equal(initialStatus.running, false);
  assert.equal(initialStatus.pollIntervalMs, 20000); // 20s default (within 15-30s requirement)
  assert.equal(initialStatus.confidenceThreshold, 0.40);

  // Start scheduler
  const startResult = arrivalSchedulerService.startArrivalScheduler({ pollIntervalMs: 25000 });
  assert.equal(startResult.started, true);
  assert.equal(startResult.running, true);
  assert.equal(startResult.pollIntervalMs, 25000);

  // Idempotent singleton: second start attempt returns already running
  const secondStart = arrivalSchedulerService.startArrivalScheduler();
  assert.equal(secondStart.started, false);
  assert.equal(secondStart.alreadyRunning, true);

  // Verify status reflects active state
  const runningStatus = arrivalSchedulerService.getSchedulerStatus();
  assert.equal(runningStatus.running, true);
  assert.equal(runningStatus.pollIntervalMs, 25000);
  assert.ok(typeof runningStatus.londonCivilTime, 'string');

  // Stop scheduler
  const stopResult = arrivalSchedulerService.stopArrivalScheduler();
  assert.equal(stopResult.stopped, true);
  assert.equal(arrivalSchedulerService.getSchedulerStatus().running, false);
});

test('2. UK Daylight Saving (BST & GMT) morning opening hours validation', () => {
  // Test Case A: British Summer Time (BST, UTC+1), Monday 08:45 London time (in shift)
  const bstMorningInShift = new Date('2026-06-15T07:45:00.000Z'); // 07:45 UTC == 08:45 BST
  assert.equal(detectionService.isWithinShiftHours(bstMorningInShift), true);

  // Test Case B: British Summer Time (BST, UTC+1), Monday 07:45 London time (before opening)
  const bstBeforeOpening = new Date('2026-06-15T06:45:00.000Z'); // 06:45 UTC == 07:45 BST
  assert.equal(detectionService.isWithinShiftHours(bstBeforeOpening), false);

  // Test Case C: Greenwich Mean Time (GMT, UTC+0), Tuesday 08:35 London time (in shift)
  const gmtMorningInShift = new Date('2026-01-13T08:35:00.000Z'); // 08:35 UTC == 08:35 GMT
  assert.equal(detectionService.isWithinShiftHours(gmtMorningInShift), true);

  // Test Case D: Greenwich Mean Time (GMT, UTC+0), Tuesday 18:30 London time (after shift)
  const gmtAfterClosing = new Date('2026-01-13T18:30:00.000Z');
  assert.equal(detectionService.isWithinShiftHours(gmtAfterClosing), false);

  // Test Case E: Sunday closed (closed all day regardless of hour)
  const sundayNoon = new Date('2026-06-21T11:00:00.000Z'); // Sunday 12:00 BST
  assert.equal(detectionService.isWithinShiftHours(sundayNoon), false);
});

test('3. First Arrival: captures arrival photo, creates candidate event, and prevents duplicate captures', async () => {
  const morningDate = new Date('2026-10-12T08:45:00.000Z'); // Monday morning in shift
  const mockDetections = {
    inferenceMs: 32,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [350, 220, 80, 160], confidence: 0.88, class: 'person' }]
  };

  // Cycle 1: First arrival enters workshop bay
  const cycle1 = await arrivalSchedulerService.runDetectionCycle({
    mockBuffer: VALID_JPEG,
    mockDate: morningDate,
    precomputedDetections: mockDetections
  });

  assert.equal(cycle1.status, 'arrival_photo_captured');
  assert.equal(cycle1.newArrivalsCount, 1);
  assert.ok(cycle1.events.length > 0);
  assert.equal(cycle1.events[0].type, 'new_candidate_detected');

  const pendingEvents1 = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  assert.equal(pendingEvents1.length, 1);
  const candidate1 = pendingEvents1[0];
  assert.equal(candidate1.reviewStatus, 'pending_review');
  assert.equal(candidate1.assignedWorkerId, null);
  assert.equal(candidate1.cameraLabel, 'Camera 05');
  assert.equal(candidate1.payrollImpact, 'none');

  // Cycle 2 (20 seconds later): Same person still working in workshop bay (duplicate suppression)
  const subsequentDate = new Date(morningDate.getTime() + 20000);
  const cycle2 = await arrivalSchedulerService.runDetectionCycle({
    mockBuffer: VALID_JPEG,
    mockDate: subsequentDate,
    precomputedDetections: {
      inferenceMs: 28,
      imageDimensions: { width: 704, height: 576 },
      personCount: 1,
      // Small shift in box representing same continuous person
      detections: [{ box: [352, 222, 78, 158], confidence: 0.89, class: 'person' }]
    }
  });

  // Must NOT create duplicate arrival event or new candidate record
  assert.equal(cycle2.status, 'session_continued');
  const pendingEvents2 = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  assert.equal(pendingEvents2.length, 1, 'Duplicate arrival event must not be created');

  // Status counters verify single arrival recorded
  const status = arrivalSchedulerService.getSchedulerStatus();
  assert.equal(status.arrivalsDetectedCount, 1);
  assert.equal(status.totalCycles, 2);
  assert.equal(status.successfulCycles, 2);
});

test('4. Snapshot validation: rejects invalid JPEG bytes signature', async () => {
  const invalidBuffer = Buffer.from('<html><head><title>500 Internal Error</title></head></html>');

  const cycle = await arrivalSchedulerService.runDetectionCycle({
    mockBuffer: invalidBuffer,
    forceRun: true
  });

  assert.equal(cycle.status, 'invalid_jpeg_received');
  const status = arrivalSchedulerService.getSchedulerStatus();
  assert.equal(status.failedCycles, 1);
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.lastStatus, 'invalid_jpeg_received');
});

test('5. Camera failure recovery: handles unreachable DVR without crashing server', async () => {
  const originalCapture = snapshotService.captureSnapshot;
  snapshotService.captureSnapshot = async () => ({
    status: 'unreachable',
    details: 'Recorder connection timed out after 3000ms'
  });

  try {
    const cycle = await arrivalSchedulerService.runDetectionCycle({
      forceRun: true
    });

    assert.equal(cycle.status, 'camera_capture_failed');
    assert.equal(cycle.details, 'Recorder connection timed out after 3000ms');

    const status = arrivalSchedulerService.getSchedulerStatus();
    assert.equal(status.failedCycles, 1);
    assert.equal(status.consecutiveFailures, 1);
    assert.equal(status.lastStatus, 'camera_capture_failed');
    assert.ok(status.lastError.includes('timed out'));
  } finally {
    snapshotService.captureSnapshot = originalCapture;
  }
});

test('6. Persistence recovery: active presence sessions and candidate events survive restarts', async () => {
  const testDate = new Date('2026-10-12T09:00:00.000Z');
  const mockDetections = {
    inferenceMs: 25,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [320, 200, 85, 170], confidence: 0.85, class: 'person' }]
  };

  await arrivalSchedulerService.runDetectionCycle({
    mockBuffer: VALID_JPEG,
    mockDate: testDate,
    precomputedDetections: mockDetections
  });

  const eventBefore = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' })[0];
  assert.ok(eventBefore);

  // Simulate server restart by reloading sessions and worker events from disk
  detectionService.loadSessionsFromDisk();

  const eventsAfter = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  const eventFound = eventsAfter.find((e) => e.eventId === eventBefore.eventId);
  assert.ok(eventFound);
  assert.equal(eventFound.sessionId, eventBefore.sessionId);
  assert.equal(eventFound.reviewStatus, 'pending_review');
  assert.equal(eventFound.payrollImpact, 'none');
});

test('7. Group Sharing endpoint: returns formatted WhatsApp/Telegram text and notice', async () => {
  // 1. Setup confirmed attendance record
  const workers = workerService.listWorkers({ shopId: 'station', activeOnly: true });
  const targetWorker = workers[0];

  const mockDetections = {
    inferenceMs: 29,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [340, 210, 80, 160], confidence: 0.92, class: 'person' }]
  };

  const processResult = await detectionService.processStationDetections(
    { timestamp: '2026-10-12T08:35:00.000Z', snapshotRef: 'snap_station_share_test.jpg' },
    null,
    mockDetections
  );

  const eventId = processResult.events[0].eventId;

  // Verify and approve worker
  await detectionService.verifyWorkerEvent(eventId, 'approve_worker', 'Morning workshop shift', 'admin', targetWorker.workerId);

  // 2. Fetch share summary endpoint
  const shareRes = await fetch(`${baseUrl}/api/workers/attendance/share-summary?shopId=station&date=2026-10-12`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(shareRes.status, 200);
  const shareData = await shareRes.json();

  assert.equal(shareData.shopId, 'station');
  assert.equal(shareData.cameraLabel, 'Camera 05');
  assert.equal(shareData.confirmedCount, 1);
  assert.equal(shareData.messagingIntegrationStatus, 'no_external_webhook_configured');
  assert.ok(shareData.formattedText.includes('STATION CYCLES — MORNING WORKER ARRIVAL REPORT'));
  assert.ok(shareData.formattedText.includes(targetWorker.name));
  assert.ok(shareData.formattedText.includes('payrollImpact: none'));
  assert.ok(shareData.records[0].snapshotEndpoint.includes('/api/workers/events/'));
});
