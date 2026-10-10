const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../src/app');
const { ADMIN_API_KEY } = require('../src/config/env');
const detectionService = require('../src/services/detectionService');
const workerService = require('../src/services/workerService');

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

test('1. GET /api/workers returns Station workers for dropdown and requires admin auth', async () => {
  // Unauthorized request rejected
  const unauthRes = await fetch(`${baseUrl}/api/workers`);
  assert.equal(unauthRes.status, 401);

  // Authorized request returns Station workers
  const res = await fetch(`${baseUrl}/api/workers?shopId=station`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.shopId, 'station');
  assert.ok(data.count >= 3);

  // Active-only query filter returns only active staff
  const activeRes = await fetch(`${baseUrl}/api/workers?shopId=station&activeOnly=true`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(activeRes.status, 200);
  const activeData = await activeRes.json();
  assert.ok(activeData.count > 0);
  assert.ok(activeData.workers.every((w) => w.active === true));
});

test('2. POST /api/workers creates worker for Station and rejects other shops', async () => {
  // Rejecting other shops (e.g. Camden)
  const rejectRes = await fetch(`${baseUrl}/api/workers`, {
    method: 'POST',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Bob Camden',
      role: 'Mechanic',
      shopId: 'camden'
    })
  });
  assert.equal(rejectRes.status, 400);

  // Successfully creating a new Station worker
  const createRes = await fetch(`${baseUrl}/api/workers`, {
    method: 'POST',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Marcus Vance',
      role: 'Wheel Specialist',
      shopId: 'station'
    })
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.worker.name, 'Marcus Vance');
  assert.equal(createData.worker.role, 'Wheel Specialist');
  assert.equal(createData.worker.shopId, 'station');
  assert.equal(createData.worker.active, true);

  // Clean up created worker from roster
  workerService.deactivateWorker(createData.worker.workerId);
});

test('3. AI detection creates candidate events with assignedWorkerId: null (no automated identity guessing)', async () => {
  const mockDetections = {
    inferenceMs: 38,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [320, 240, 80, 160], confidence: 0.88, class: 'person' }]
  };

  const processResult = await detectionService.processStationDetections(
    { timestamp: '2026-10-10T10:15:00.000Z', snapshotRef: 'snap_test_candidate.jpg' },
    null,
    mockDetections
  );

  assert.equal(processResult.events[0].type, 'new_candidate_detected');
  const eventId = processResult.events[0].eventId;

  const eventsRes = await fetch(`${baseUrl}/api/workers/events?status=pending_review`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(eventsRes.status, 200);
  const eventsData = await eventsRes.json();
  const event = eventsData.events.find((e) => e.eventId === eventId);

  // Strictly unassigned and pending review
  assert.ok(event);
  assert.equal(event.reviewStatus, 'pending_review');
  assert.equal(event.assignedWorkerId, null);
  assert.equal(event.assignedWorkerName, null);
  assert.equal(event.payrollImpact, 'none');
  assert.equal(event.snapshotRef, 'snap_test_candidate.jpg');
});

test('4. Manager review assigns worker, maintains audit trail, and links attendance record', async () => {
  const activeWorkers = workerService.listWorkers({ shopId: 'station', activeOnly: true });
  assert.ok(activeWorkers.length > 0, 'Must have at least one active worker');
  const targetWorker = activeWorkers[0];

  const mockDetections = {
    inferenceMs: 35,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.82, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-10T11:00:00.000Z', snapshotRef: 'snap_test_review.jpg' },
    null,
    mockDetections
  );

  const events = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  const eventId = events[0].eventId;

  // Manager assigns targetWorker
  const reviewRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: targetWorker.workerId,
      notes: `Manager visually identified ${targetWorker.name} at repair stand`
    })
  });

  assert.equal(reviewRes.status, 200);
  const reviewData = await reviewRes.json();
  assert.equal(reviewData.event.reviewStatus, 'verified_worker');
  assert.equal(reviewData.event.assignedWorkerId, targetWorker.workerId);
  assert.equal(reviewData.event.assignedWorkerName, targetWorker.name);
  assert.equal(reviewData.event.payrollImpact, 'none');

  // Audit history contains the assignment
  const lastAudit = reviewData.event.auditHistory[reviewData.event.auditHistory.length - 1];
  assert.equal(lastAudit.action, 'approve_worker');
  assert.equal(lastAudit.assignedWorkerId, targetWorker.workerId);
  assert.equal(lastAudit.assignedWorkerName, targetWorker.name);
  assert.equal(lastAudit.performedBy, 'admin');

  // Attendance record is linked
  const attRes = await fetch(`${baseUrl}/api/workers/${targetWorker.workerId}/attendance`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(attRes.status, 200);
  const attData = await attRes.json();
  assert.equal(attData.workerId, targetWorker.workerId);
  assert.equal(attData.totalConfirmedEvents, 1);
  assert.equal(attData.payrollImpact, 'none');
  assert.equal(attData.payrollDeductionsEnabled, false);
});

test('5. Manager review rejects non-existent or inactive worker IDs', async () => {
  const mockDetections = {
    inferenceMs: 30,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.80, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-10T11:30:00.000Z', snapshotRef: 'snap_test_invalid_worker.jpg' },
    null,
    mockDetections
  );

  const events = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  const eventId = events[0].eventId;

  // Unknown worker ID rejected
  const badRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: 'worker_unknown_999'
    })
  });
  assert.equal(badRes.status, 400);

  // Inactive worker (worker_st_01 is marked inactive) rejected
  const inactiveRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: 'worker_st_01'
    })
  });
  assert.equal(inactiveRes.status, 400);
});

test('6. Reassigning worker maintains audit history of corrections', async () => {
  const activeWorkers = workerService.listWorkers({ shopId: 'station', activeOnly: true });
  assert.ok(activeWorkers.length >= 2, 'Must have at least two active workers for reassignment test');
  const w1 = activeWorkers[0];
  const w2 = activeWorkers[1];

  const mockDetections = {
    inferenceMs: 30,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.80, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-10T12:00:00.000Z', snapshotRef: 'snap_test_reassign.jpg' },
    null,
    mockDetections
  );

  const events = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  const eventId = events[0].eventId;

  // Initial assignment to w1
  await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: w1.workerId,
      notes: 'Initial assignment'
    })
  });

  // Manager correction: reassign to w2
  const reassignRes = await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: w2.workerId,
      notes: `Correction: CCTV zoom confirms technician ${w2.name}`
    })
  });
  assert.equal(reassignRes.status, 200);
  const reassignData = await reassignRes.json();
  assert.equal(reassignData.event.assignedWorkerId, w2.workerId);
  assert.equal(reassignData.event.assignedWorkerName, w2.name);

  // Verify audit history contains previousWorkerId
  const history = reassignData.event.auditHistory;
  const correctionEntry = history[history.length - 1];
  assert.equal(correctionEntry.previousWorkerId, w1.workerId);
  assert.equal(correctionEntry.previousWorkerName, w1.name);
  assert.equal(correctionEntry.assignedWorkerId, w2.workerId);
  assert.equal(correctionEntry.assignedWorkerName, w2.name);
});

test('7. Attendance records clearly flag uncertain times for brief dwells or single snapshots', async () => {
  const activeWorkers = workerService.listWorkers({ shopId: 'station', activeOnly: true });
  assert.ok(activeWorkers.length > 0);
  const targetWorker = activeWorkers[0];

  const mockDetections = {
    inferenceMs: 30,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 250, 70, 150], confidence: 0.85, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-10T14:00:00.000Z', snapshotRef: 'snap_test_uncertain.jpg' },
    null,
    mockDetections
  );

  const events = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
  const eventId = events[0].eventId;

  await fetch(`${baseUrl}/api/workers/events/${eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: targetWorker.workerId,
      notes: 'Brief appearance in workshop bay'
    })
  });

  const attRes = await fetch(`${baseUrl}/api/workers/${targetWorker.workerId}/attendance`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  const attData = await attRes.json();
  const record = attData.attendanceRecords[0];

  assert.ok(record);
  // Single snapshot / dwell = 0s must be flagged as uncertain
  assert.equal(record.uncertainTimes, true);
  assert.ok(record.uncertaintyReasons.includes('single_snapshot_or_short_dwell'));
  assert.equal(record.payrollImpact, 'none');
  assert.equal(record.payrollDeductionsEnabled, false);
});

test('8. GET /api/workers/review-interface renders HTML review UI with worker dropdown', async () => {
  const res = await fetch(`${baseUrl}/api/workers/review-interface`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Station Cycles CCTV'));
  assert.ok(html.includes('Assign Worker'));
  assert.ok(html.includes('payrollImpact: none'));
  assert.ok(html.includes('Worker Management'));
  assert.ok(html.includes('Worker Attendance Records'));
});
