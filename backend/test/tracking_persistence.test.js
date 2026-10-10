const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const detectionService = require('../src/services/detectionService');
const accuracyService = require('../src/services/accuracyEvaluationService');

test.beforeEach(() => {
  detectionService.resetDetectionService();
});

test('1. Station Bay Polygon correctly discriminates workshop bay from public roadway & sidewalk', () => {
  // Inside workshop bay
  assert.equal(detectionService.isInWorkshopBay([300, 250, 80, 160]), true);
  assert.equal(detectionService.isInWorkshopBay([480, 240, 80, 165]), true);
  assert.equal(detectionService.isInWorkshopBay([240, 380, 80, 160]), true);

  // Outside: Public sidewalk
  assert.equal(detectionService.isInWorkshopBay([40, 110, 45, 115]), false);
  assert.equal(detectionService.isInWorkshopBay([50, 80, 50, 110]), false);

  // Outside: Public roadway (previously failed under simple rectangular check)
  assert.equal(detectionService.isInWorkshopBay([220, 120, 40, 90]), false);
  assert.equal(detectionService.isInWorkshopBay([110, 200, 50, 120]), false);
});

test('2. Backend restart hydrates active presence sessions from disk without creating duplicate arrival events', async () => {
  const fakeSnapshot1 = {
    timestamp: '2026-10-09T10:00:00.000Z',
    snapshotRef: 'restart_test_1.jpg'
  };
  const mockDetections = {
    inferenceMs: 38,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [320, 220, 80, 160], confidence: 0.90, class: 'person' }]
  };

  // 1. Process Frame 1 before restart
  const res1 = await detectionService.processStationDetections(fakeSnapshot1, null, mockDetections);
  assert.equal(res1.events.length, 1);
  assert.equal(res1.events[0].type, 'new_candidate_detected');
  assert.equal(res1.events[0].isNewArrival, true);
  const originalSessionId = res1.events[0].sessionId;

  // 2. Simulate Backend Restart:
  // In a restart, memory state is wiped and reloaded from disk
  detectionService.loadSessionsFromDisk();

  // 3. Process Frame 2 (25 seconds later)
  const fakeSnapshot2 = {
    timestamp: '2026-10-09T10:00:25.000Z',
    snapshotRef: 'restart_test_2.jpg'
  };

  const res2 = await detectionService.processStationDetections(fakeSnapshot2, null, mockDetections);
  assert.equal(res2.events.length, 1);
  assert.equal(res2.events[0].type, 'session_update');
  assert.equal(res2.events[0].isNewArrival, false);
  assert.equal(res2.events[0].sessionId, originalSessionId);
  assert.equal(res2.events[0].sampleCount, 2);
  assert.equal(res2.events[0].dwellTimeSeconds, 25);
  assert.equal(res2.activeSessionsCount, 1);
});

test('3. Leaving and re-entering after prolonged gap (> 90s) cleanly creates a new separate session', async () => {
  const fakeSnapshot1 = {
    timestamp: '2026-10-09T10:00:00.000Z',
    snapshotRef: 'leave_reenter_1.jpg'
  };
  const mockDetections = {
    inferenceMs: 40,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 210, 80, 165], confidence: 0.88, class: 'person' }]
  };

  // Frame 1
  const res1 = await detectionService.processStationDetections(fakeSnapshot1, null, mockDetections);
  const session1Id = res1.events[0].sessionId;

  // Frame 2: 15 minutes later (900s >> 90s expiry)
  const fakeSnapshot2 = {
    timestamp: '2026-10-09T10:15:00.000Z',
    snapshotRef: 'leave_reenter_2.jpg'
  };

  const res2 = await detectionService.processStationDetections(fakeSnapshot2, null, mockDetections);
  assert.equal(res2.events.length, 1);
  assert.equal(res2.events[0].type, 'new_candidate_detected');
  assert.equal(res2.events[0].isNewArrival, true);
  assert.notEqual(res2.events[0].sessionId, session1Id);
  assert.equal(res2.activeSessionsCount, 1); // Old session was evicted
});

test('4. Temporary occlusion maintains active session across brief miss without duplicate alert', async () => {
  const mockDetections = {
    inferenceMs: 42,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [280, 200, 80, 170], confidence: 0.85, class: 'person' }]
  };
  const emptyDetections = {
    inferenceMs: 40,
    imageDimensions: { width: 704, height: 576 },
    personCount: 0,
    detections: []
  };

  // Frame 1: Person present at t=0s
  const res1 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T11:00:00.000Z', snapshotRef: 'occ_1.jpg' },
    null,
    mockDetections
  );
  const sessionId = res1.events[0].sessionId;

  // Frame 2: Person occluded behind bike at t=20s (0 detections)
  const res2 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T11:00:20.000Z', snapshotRef: 'occ_2.jpg' },
    null,
    emptyDetections
  );
  assert.equal(res2.events.length, 0);
  assert.equal(res2.activeSessionsCount, 1); // Session kept alive in grace window

  // Frame 3: Person reappears at t=45s (< 90s expiry)
  const res3 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T11:00:45.000Z', snapshotRef: 'occ_3.jpg' },
    null,
    mockDetections
  );
  assert.equal(res3.events.length, 1);
  assert.equal(res3.events[0].type, 'session_update');
  assert.equal(res3.events[0].sessionId, sessionId);
  assert.equal(res3.events[0].isNewArrival, false);
  assert.equal(res3.events[0].dwellTimeSeconds, 45);
});

test('5. Simultaneous people crossing paths maintain separate distinct sessions', async () => {
  // Frame 1: Person A at x=220, Person B at x=440
  const mockDetectionsF1 = {
    inferenceMs: 45,
    imageDimensions: { width: 704, height: 576 },
    personCount: 2,
    detections: [
      { box: [220, 230, 80, 160], confidence: 0.86, class: 'person' },
      { box: [440, 200, 80, 160], confidence: 0.83, class: 'person' }
    ]
  };

  const res1 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T13:00:00.000Z', snapshotRef: 'cross_1.jpg' },
    null,
    mockDetectionsF1
  );
  assert.equal(res1.events.length, 2);
  assert.equal(res1.activeSessionsCount, 2);
  const sessionA = res1.events[0].sessionId;
  const sessionB = res1.events[1].sessionId;
  assert.notEqual(sessionA, sessionB);

  // Frame 2: Both persons continue moving in their zones (+20s)
  const mockDetectionsF2 = {
    inferenceMs: 44,
    imageDimensions: { width: 704, height: 576 },
    personCount: 2,
    detections: [
      { box: [230, 232, 80, 160], confidence: 0.88, class: 'person' },
      { box: [430, 204, 80, 160], confidence: 0.84, class: 'person' }
    ]
  };

  const res2 = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T13:00:20.000Z', snapshotRef: 'cross_2.jpg' },
    null,
    mockDetectionsF2
  );
  assert.equal(res2.events.length, 2);
  assert.equal(res2.events[0].type, 'session_update');
  assert.equal(res2.events[1].type, 'session_update');
  assert.equal(res2.activeSessionsCount, 2);
});

test('6. Unseen test set benchmark accurately compares 0.40 baseline against 0.25 and 0.35', async () => {
  const result = await accuracyService.runUnseenThresholdComparison();

  assert.equal(result.datasetType, 'unseen_test_set');
  assert.equal(result.totalFrames, 26);
  assert.equal(result.totalLabeledPeople, 23);
  assert.equal(result.comparison.length, 3);

  const baseline = result.comparison.find((c) => c.threshold === 0.40);
  assert.ok(baseline);
  assert.equal(baseline.isBaseline, true);
  assert.equal(baseline.falsePositives, 0); // Zero hallucinated detections
  assert.equal(baseline.precision, 1.0);
  assert.equal(baseline.recall, 0.8261); // 19 / 23 captured (FN=4 for extreme occlusions < 0.40)
  assert.equal(baseline.f1Score, 0.9048);

  const t035 = result.comparison.find((c) => c.threshold === 0.35);
  assert.ok(t035);
  assert.equal(t035.falsePositives, 0);
  assert.equal(t035.precision, 1.0);
  assert.equal(t035.recall, 0.913); // 21 / 23 captured
  assert.equal(t035.f1Score, 0.9545);
  assert.ok(t035.recall > baseline.recall);

  const t025 = result.comparison.find((c) => c.threshold === 0.25);
  assert.ok(t025);
  assert.equal(t025.recall, 1.0); // 23 / 23 captured
  assert.equal(t025.f1Score, 1.0);
  assert.ok(t025.recall >= t035.recall);
});

test('7. Corrupted or malformed session file on disk recovers gracefully without crash', () => {
  const SESSIONS_DIR = path.join(__dirname, '../storage/sessions');
  const SESSIONS_FILE = path.join(SESSIONS_DIR, 'active_sessions.json');

  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // Write malformed non-JSON data simulating interrupted write or corruption
  fs.writeFileSync(SESSIONS_FILE, '{ "station": [ incomplete_broken_json...', 'utf8');

  // Must not throw an unhandled exception
  assert.doesNotThrow(() => {
    detectionService.loadSessionsFromDisk();
  });
});

test('8. Atomic file write ensures active_sessions.json is atomically updated with valid JSON', async () => {
  const SESSIONS_FILE = path.join(__dirname, '../storage/sessions', 'active_sessions.json');

  const mockDetections = {
    inferenceMs: 38,
    imageDimensions: { width: 704, height: 576 },
    personCount: 1,
    detections: [{ box: [300, 200, 80, 160], confidence: 0.88, class: 'person' }]
  };

  await detectionService.processStationDetections(
    { timestamp: '2026-10-09T14:00:00.000Z', snapshotRef: 'atomic_test.jpg' },
    null,
    mockDetections
  );

  assert.equal(fs.existsSync(SESSIONS_FILE), true);
  const content = fs.readFileSync(SESSIONS_FILE, 'utf8');
  const parsed = JSON.parse(content);
  assert.ok(parsed.station);
  assert.equal(Array.isArray(parsed.station), true);
  assert.equal(parsed.station.length, 1);
});

test('9. Multiple people entering and leaving simultaneously track cleanly', async () => {
  // Two workers enter together in Frame 1
  const mockEnter = {
    inferenceMs: 42,
    imageDimensions: { width: 704, height: 576 },
    personCount: 2,
    detections: [
      { box: [280, 260, 80, 160], confidence: 0.85, class: 'person' },
      { box: [350, 260, 80, 160], confidence: 0.83, class: 'person' }
    ]
  };

  const resEnter = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T15:00:00.000Z', snapshotRef: 'multi_1.jpg' },
    null,
    mockEnter
  );

  assert.equal(resEnter.events.length, 2);
  assert.equal(resEnter.activeSessionsCount, 2);
  const [sessA, sessB] = resEnter.events.map((e) => e.sessionId);
  assert.notEqual(sessA, sessB);

  // Both workers update in Frame 2 (30 seconds later)
  const mockUpdate = {
    inferenceMs: 40,
    imageDimensions: { width: 704, height: 576 },
    personCount: 2,
    detections: [
      { box: [282, 262, 80, 158], confidence: 0.87, class: 'person' },
      { box: [352, 258, 80, 160], confidence: 0.84, class: 'person' }
    ]
  };

  const resUpdate = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T15:00:30.000Z', snapshotRef: 'multi_2.jpg' },
    null,
    mockUpdate
  );

  assert.equal(resUpdate.events.length, 2);
  assert.equal(resUpdate.events[0].type, 'session_update');
  assert.equal(resUpdate.events[1].type, 'session_update');
  assert.equal(resUpdate.activeSessionsCount, 2);

  // Both workers leave simultaneously (gap > 90s, t = 15:05:00)
  const mockDepart = {
    inferenceMs: 40,
    imageDimensions: { width: 704, height: 576 },
    personCount: 0,
    detections: []
  };

  const resDepart = await detectionService.processStationDetections(
    { timestamp: '2026-10-09T15:05:00.000Z', snapshotRef: 'multi_empty.jpg' },
    null,
    mockDepart
  );

  assert.equal(resDepart.events.length, 0);
  assert.equal(resDepart.activeSessionsCount, 0); // Both expired cleanly
});

test('10. Verified Polygon ROI geometric boundaries against Camera 05 4CIF native resolution', () => {
  const polygon = detectionService.STATION_BAY_POLYGON;

  // Verify all polygon vertices are within 704x576 coordinate frame
  for (const [x, y] of polygon) {
    assert.ok(x >= 0 && x <= 704, `Vertex X out of bounds: ${x}`);
    assert.ok(y >= 0 && y <= 576, `Vertex Y out of bounds: ${y}`);
  }

  // Inside workshop bay target locations
  const rackA = [320, 210, 85, 175]; // center: 362, 297
  const rackB = [480, 240, 80, 165]; // center: 520, 322
  const centerBay = [300, 250, 80, 160]; // center: 340, 330
  const rearBay = [530, 210, 70, 135]; // center: 565, 277

  assert.equal(detectionService.isInWorkshopBay(rackA), true);
  assert.equal(detectionService.isInWorkshopBay(rackB), true);
  assert.equal(detectionService.isInWorkshopBay(centerBay), true);
  assert.equal(detectionService.isInWorkshopBay(rearBay), true);

  // Outside: Public sidewalk, roadway, and sky
  const publicSidewalk = [40, 110, 45, 115]; // center: 62, 167
  const roadway = [110, 200, 50, 120]; // center: 135, 260
  const streetCorner = [60, 40, 35, 75]; // center: 77, 77
  const skyUpper = [500, 50, 60, 60]; // center: 530, 80

  assert.equal(detectionService.isInWorkshopBay(publicSidewalk), false);
  assert.equal(detectionService.isInWorkshopBay(roadway), false);
  assert.equal(detectionService.isInWorkshopBay(streetCorner), false);
  assert.equal(detectionService.isInWorkshopBay(skyUpper), false);
});
