const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const app = require('../src/app');
const snapshotService = require('../src/services/snapshotService');
const workerService = require('../src/services/workerService');
const detectionService = require('../src/services/detectionService');
const { SNAPSHOT_STORAGE_DIR } = require('../src/config/env');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'pixx-cctv-admin-secret-2026';

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('1. Snapshot storage: saves valid JPEG in shop-specific subfolder and verifies on disk', () => {
  const shopId = 'station';
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  
  const saved = snapshotService.saveSnapshot(fakeJpg, shopId, {
    channel: 501,
    cameraLabel: 'Station Bay Cam 05'
  });

  assert.ok(saved.eventId);
  assert.equal(saved.shopId, 'station');
  assert.ok(saved.snapshotRef.startsWith('station/'));

  const expectedFolder = path.join(SNAPSHOT_STORAGE_DIR, 'station');
  const expectedFile = path.join(expectedFolder, `${saved.eventId}.jpg`);

  assert.ok(fs.existsSync(expectedFile), `File should exist on disk at ${expectedFile}`);
  const stats = fs.statSync(expectedFile);
  assert.ok(stats.size > 0, 'Saved snapshot file size must be > 0 bytes');

  // Verify getSnapshotFilePath resolves shop subfolder
  const resolvedPath = snapshotService.getSnapshotFilePath(saved.eventId);
  assert.equal(resolvedPath, expectedFile);
});

test('2. Snapshot retrieval endpoint: requires admin auth and serves private image', async () => {
  const shopId = 'station';
  const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const saved = snapshotService.saveSnapshot(fakeJpg, shopId);

  // Unauthenticated request must be rejected (401)
  const unauthRes = await fetch(`${baseUrl}/api/workers/events/${saved.eventId}/snapshot`);
  assert.equal(unauthRes.status, 401);

  // Authenticated request returns 200 with image/jpeg
  const authRes = await fetch(`${baseUrl}/api/workers/events/${saved.eventId}/snapshot`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(authRes.status, 200);
  assert.equal(authRes.headers.get('content-type'), 'image/jpeg');
  assert.equal(authRes.headers.get('cache-control'), 'private, no-cache, no-store, must-revalidate');

  const buf = Buffer.from(await authRes.arrayBuffer());
  assert.ok(buf.length > 0);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
});

test('3. Multi-shop roster isolation: separate worker rosters across authorized shops', async () => {
  // Create worker in Camden
  const camdenRes = await fetch(`${baseUrl}/api/workers`, {
    method: 'POST',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Oliver Camden',
      role: 'Head Mechanic',
      shopId: 'camden',
      shiftStart: '08:30'
    })
  });
  assert.equal(camdenRes.status, 201);
  const camdenData = await camdenRes.json();
  assert.equal(camdenData.worker.shopId, 'camden');

  // Station roster must NOT include Oliver Camden
  const stationRosterRes = await fetch(`${baseUrl}/api/workers?shopId=station`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(stationRosterRes.status, 200);
  const stationRoster = await stationRosterRes.json();
  assert.ok(!stationRoster.workers.some(w => w.name === 'Oliver Camden'));

  // Camden roster MUST include Oliver Camden
  const camdenRosterRes = await fetch(`${baseUrl}/api/workers?shopId=camden`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(camdenRosterRes.status, 200);
  const camdenRoster = await camdenRosterRes.json();
  assert.ok(camdenRoster.workers.some(w => w.name === 'Oliver Camden'));
});

test('4. London civil lateness: accurately evaluates on-time vs late arrival against shift start (GMT and BST)', () => {
  // Winter GMT (January): UTC equals London civil time
  // 08:25 arrival vs 08:30 shiftStart -> 0 late minutes
  const gmtOnTime = workerService.calculateLatenessLondon('2026-01-12T08:25:00.000Z', '08:30');
  assert.equal(gmtOnTime.lateMinutes, 0);

  // 08:50 arrival vs 08:30 shiftStart -> 20 late minutes
  const gmtLate = workerService.calculateLatenessLondon('2026-01-12T08:50:00.000Z', '08:30');
  assert.equal(gmtLate.lateMinutes, 20);

  // Summer BST (July): UTC+1 in London
  // 07:25 UTC = 08:25 BST vs 08:30 shiftStart -> 0 late minutes
  const bstOnTime = workerService.calculateLatenessLondon('2026-07-12T07:25:00.000Z', '08:30');
  assert.equal(bstOnTime.lateMinutes, 0);

  // 07:50 UTC = 08:50 BST vs 08:30 shiftStart -> 20 late minutes
  const bstLate = workerService.calculateLatenessLondon('2026-07-12T07:50:00.000Z', '08:30');
  assert.equal(bstLate.lateMinutes, 20);
});

test('5. Reliable attendance workflow: never invents departure times from unobserved exits', () => {
  const stationWorker = workerService.createWorker({
    name: 'David Test Technician',
    role: 'Bike Mechanic',
    shopId: 'station',
    shiftStart: '08:30'
  });

  const fakeEvent = {
    eventId: `ev_test_${Date.now()}`,
    sessionId: `sess_test_${Date.now()}`,
    shopId: 'station',
    timestamp: '2026-01-12T08:45:00.000Z', // 08:45 GMT
    snapshotRef: 'station/snap_test.jpg',
    detectionConfidence: 0.88
  };

  // Link event WITHOUT departure confirmation
  const record = workerService.linkEventToWorkerAttendance(fakeEvent, stationWorker, 'admin', {
    dwellTimeSeconds: 120,
    sampleCount: 5,
    isDepartureVerified: false
  });

  assert.equal(record.departureTime, null, 'Departure time must NOT be invented when unobserved');
  assert.equal(record.departureStatus, 'active_not_departed');
  assert.equal(record.payrollImpact, 'none', 'Automated payroll deduction must remain strictly disabled');
  assert.equal(record.payrollDeductionsEnabled, false);
  assert.equal(record.proposedDeduction.approvalStatus, 'requires_authorized_human_approval');
  assert.equal(record.lateMinutes, 15); // 08:45 vs 08:30 = 15 min late
});

test('6. Audit history & assignment correction: updates worker assignment with full audit trail', async () => {
  // Create candidate event in detectionService
  const fakeCandidate = {
    eventId: `ev_audit_${Date.now()}`,
    sessionId: `sess_audit_${Date.now()}`,
    shopId: 'station',
    timestamp: new Date().toISOString(),
    snapshotRef: 'station/snap_audit.jpg',
    detectionConfidence: 0.85,
    reviewStatus: 'pending_review',
    assignedWorkerId: null,
    auditHistory: []
  };
  detectionService.getAllWorkerEvents().unshift(fakeCandidate);

  // Create two Station technicians
  const techA = workerService.createWorker({ name: 'Tech Alpha', role: 'Builder', shopId: 'station' });
  const techB = workerService.createWorker({ name: 'Tech Beta', role: 'Specialist', shopId: 'station' });

  // 1. Initial assignment to Tech Alpha
  const assignRes = await fetch(`${baseUrl}/api/workers/events/${fakeCandidate.eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: techA.workerId,
      notes: 'Initial assignment'
    })
  });
  assert.equal(assignRes.status, 200);

  // 2. Correction: Reassign to Tech Beta
  const correctRes = await fetch(`${baseUrl}/api/workers/events/${fakeCandidate.eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: techB.workerId,
      notes: 'Manager corrected technician assignment'
    })
  });
  assert.equal(correctRes.status, 200);
  const correctData = await correctRes.json();
  assert.equal(correctData.event.assignedWorkerId, techB.workerId);

  // Verify audit history contains previousWorkerId
  const history = correctData.event.auditHistory;
  assert.ok(history.length >= 2);
  const lastEntry = history[history.length - 1];
  assert.equal(lastEntry.previousWorkerId, techA.workerId);
  assert.equal(lastEntry.assignedWorkerId, techB.workerId);

  // 3. Customer dismissal: removes attendance and logs dismissal
  const dismissRes = await fetch(`${baseUrl}/api/workers/events/${fakeCandidate.eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'dismiss_customer',
      notes: 'Customer walked past workshop bay'
    })
  });
  assert.equal(dismissRes.status, 200);
  const dismissData = await dismissRes.json();
  assert.equal(dismissData.event.reviewStatus, 'dismissed');
  assert.equal(dismissData.event.assignedWorkerId, null);
});

test('7. Cross-shop guard: prevents assigning a Camden worker to a Station event', async () => {
  const fakeStationEvent = {
    eventId: `ev_cross_${Date.now()}`,
    sessionId: `sess_cross_${Date.now()}`,
    shopId: 'station',
    timestamp: new Date().toISOString(),
    snapshotRef: 'station/snap_cross.jpg',
    detectionConfidence: 0.85,
    reviewStatus: 'pending_review',
    assignedWorkerId: null,
    auditHistory: []
  };
  detectionService.getAllWorkerEvents().unshift(fakeStationEvent);

  const camdenWorker = workerService.createWorker({
    name: 'George Camden Tech',
    role: 'Mechanic',
    shopId: 'camden'
  });

  // Attempting to assign Camden worker to Station detection event must be rejected (400)
  const crossRes = await fetch(`${baseUrl}/api/workers/events/${fakeStationEvent.eventId}/verify`, {
    method: 'PATCH',
    headers: {
      'x-admin-api-key': ADMIN_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      action: 'approve_worker',
      workerId: camdenWorker.workerId
    })
  });
  assert.equal(crossRes.status, 400);
  const crossData = await crossRes.json();
  assert.ok(crossData.error.includes('belongs to \'camden\''));
});
