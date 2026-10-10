const express = require('express');
const {
  detectStationWorkers,
  listWorkerEvents,
  verifyWorkerEvent,
  evaluateStationAccuracy,
  getPilotMetrics,
  getShiftReconciliation,
  recordShiftCorrection,
  getStationRoiOverlay,
  getWorkerEventHistory,
  getWorkerEventSnapshot,
  getSchedulerStatus,
  triggerSchedulerCycle,
  controlScheduler
} = require('../controllers/detectionController');
const {
  listWorkers,
  createWorker,
  getWorker,
  updateWorker,
  deleteWorker,
  getWorkerAttendance,
  listAttendanceRecords,
  renderReviewInterface,
  getAttendanceShareSummary
} = require('../controllers/workerController');
const { requireAdminAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Station-only detection prototype
router.post(['/cameras/:shopId/detect-workers', '/cameras/:shopId/detect-worker'], requireAdminAuth, detectStationWorkers);
router.all(['/cameras/:shopId/detect-workers', '/cameras/:shopId/detect-worker'], (req, res, next) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed',
      details: 'The detect-workers endpoint requires HTTP POST. Send a POST request with the x-admin-api-key header.'
    });
  }
  next();
});
router.get('/cameras/:shopId/evaluate-accuracy', requireAdminAuth, evaluateStationAccuracy);
router.get('/cameras/:shopId/pilot-metrics', requireAdminAuth, getPilotMetrics);
router.get('/cameras/:shopId/reconciliation-report', requireAdminAuth, getShiftReconciliation);
router.post('/cameras/:shopId/reconciliation/corrections', requireAdminAuth, recordShiftCorrection);
router.get('/cameras/:shopId/roi-overlay', requireAdminAuth, getStationRoiOverlay);
router.get('/cameras/:shopId/scheduler-status', requireAdminAuth, getSchedulerStatus);
router.post('/cameras/:shopId/scheduler/trigger', requireAdminAuth, triggerSchedulerCycle);
router.post('/cameras/:shopId/scheduler/control', requireAdminAuth, controlScheduler);

// Manager review workflow endpoints
router.get('/workers/events', requireAdminAuth, listWorkerEvents);
router.get('/workers/events/:eventId/history', requireAdminAuth, getWorkerEventHistory);
router.get('/workers/events/:eventId/snapshot', requireAdminAuth, getWorkerEventSnapshot);
router.patch('/workers/events/:eventId/verify', requireAdminAuth, verifyWorkerEvent);

// Worker management & attendance endpoints
router.get('/workers/attendance/share-summary', requireAdminAuth, getAttendanceShareSummary);
router.get('/workers/attendance', requireAdminAuth, listAttendanceRecords);
router.get('/workers/review-interface', renderReviewInterface);
router.get('/workers', requireAdminAuth, listWorkers);
router.post('/workers', requireAdminAuth, createWorker);
router.get('/workers/:workerId', requireAdminAuth, getWorker);
router.patch('/workers/:workerId', requireAdminAuth, updateWorker);
router.delete('/workers/:workerId', requireAdminAuth, deleteWorker);
router.get('/workers/:workerId/attendance', requireAdminAuth, getWorkerAttendance);

module.exports = router;
