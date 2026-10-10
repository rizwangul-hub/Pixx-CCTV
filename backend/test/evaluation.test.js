const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const app = require('../src/app');
const { ADMIN_API_KEY } = require('../src/config/env');
const accuracyService = require('../src/services/accuracyEvaluationService');
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

test('1. GET /api/cameras/:shopId/evaluate-accuracy requires administrator authentication', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/station/evaluate-accuracy`);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Unauthorized');
});

test('2. GET /api/cameras/:shopId/evaluate-accuracy rejects shops other than Station', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/evaluate-accuracy`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.details, /Station only/i);
});

test('3. London civil time accurately handles BST daylight saving and winter GMT transitions', () => {
  const scheduleRes = accuracyService.evaluateScheduleHandling();
  assert.equal(scheduleRes.allPassed, true);
  for (const tc of scheduleRes.testCases) {
    assert.equal(tc.passed, true, `Failed test case: ${tc.testCase}`);
  }

  // Explicit check: BST Summer (UTC+1)
  // 07:45 UTC on Wednesday July 15 is 08:45 BST in London -> Within shift (08:30 - 18:00)
  const summerWorkday = new Date('2026-07-15T07:45:00.000Z');
  assert.equal(detectionService.isWithinShiftHours(summerWorkday), true);

  // Sunday closed all day in London
  const summerSunday = new Date('2026-07-19T11:00:00.000Z');
  assert.equal(detectionService.isWithinShiftHours(summerSunday), false);
});

test('4. Metric calculation accurately evaluates TP, FP, FN, Precision, Recall, and F1', () => {
  // Perfect score
  const perfect = accuracyService.calculateMetrics(10, 0, 0);
  assert.equal(perfect.precision, 1.0);
  assert.equal(perfect.recall, 1.0);
  assert.equal(perfect.f1Score, 1.0);

  // With 2 false positives and 1 false negative
  // TP = 8, FP = 2, FN = 1
  // Precision = 8 / (8 + 2) = 0.8
  // Recall = 8 / (8 + 1) = 0.8889
  const withErrors = accuracyService.calculateMetrics(8, 2, 1);
  assert.equal(withErrors.precision, 0.8);
  assert.equal(withErrors.recall, 0.8889);
  assert.ok(withErrors.f1Score > 0.84 && withErrors.f1Score < 0.85);
});

test('5. Greedy IoU matching correctly assigns predictions to ground truth', () => {
  const groundTruth = [
    { id: 'ann_1', box: [100, 100, 50, 100] },
    { id: 'ann_2', box: [300, 300, 60, 120] }
  ];

  const predictions = [
    { box: [102, 98, 48, 102], confidence: 0.90 }, // matches ann_1
    { box: [305, 298, 58, 122], confidence: 0.85 }, // matches ann_2
    { box: [500, 100, 40, 80], confidence: 0.60 }   // false positive
  ];

  const match = accuracyService.matchDetections(predictions, groundTruth, 0.50);
  assert.equal(match.matched.length, 2);
  assert.equal(match.falsePositives.length, 1);
  assert.equal(match.falseNegatives.length, 0);
});

test('6. Station Camera 05 ROI accurately discriminates workshop bay from public pavement', () => {
  // Workshop bay point: [300, 250, 80, 160] (center: 340, 330)
  assert.equal(detectionService.isInWorkshopBay([300, 250, 80, 160]), true);

  // Public sidewalk point: [40, 60, 40, 80] (center: 60, 100)
  assert.equal(detectionService.isInWorkshopBay([40, 60, 40, 80]), false);
});

test('7. End-to-end GET /api/cameras/station/evaluate-accuracy executes and returns complete benchmark', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/station/evaluate-accuracy`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok(data.report);
  assert.equal(data.report.shopId, 'station');
  assert.equal(data.report.cameraLabel, 'Camera 05');

  // Performance metrics measured
  const perf = data.report.performanceMetrics;
  assert.equal(typeof perf.meanInferenceLatencyMs, 'number');
  assert.ok(perf.meanInferenceLatencyMs < 2000); // CPU latency verified (accommodates ONNX session cold load)
  assert.equal(perf.baselineConfidenceThreshold, 0.40);
  assert.equal(typeof perf.baselinePrecision, 'number');
  assert.equal(typeof perf.baselineRecall, 'number');
  assert.equal(typeof perf.baselineF1Score, 'number');

  // Threshold sweep
  assert.equal(Array.isArray(data.report.thresholdSweep), true);
  assert.equal(data.report.thresholdSweep.length, 6);
  const thresholds = data.report.thresholdSweep.map((t) => t.threshold);
  assert.deepEqual(thresholds, [0.25, 0.35, 0.40, 0.50, 0.65, 0.80]);

  // Validations
  assert.equal(data.report.scheduleAndDstValidation.allPassed, true);
  assert.equal(data.report.sequenceDeDuplicationValidation.sessionDeduplicationPassed, true);
  assert.equal(data.report.roiClassificationValidation.accuracy, 1.0);

  // Governance
  assert.equal(data.report.governanceChecks.facialRecognitionUsed, false);
  assert.equal(data.report.governanceChecks.automatedPayrollDeduction, false);
  assert.equal(data.report.governanceChecks.allWorkerCandidatesPendingReview, true);
  assert.equal(data.report.governanceChecks.isolatedToStationOnly, true);
});
