const fs = require('fs');
const path = require('path');
const snapshotService = require('../services/snapshotService');
const detectionService = require('../services/detectionService');
const { SNAPSHOT_STORAGE_DIR } = require('../config/env');

/**
 * Runs the prototype worker detection on Station Camera 05.
 * Strictly limited to Station only.
 */
const detectStationWorkers = async (req, res, next) => {
  try {
    const { shopId } = req.params;

    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'The worker detection prototype is currently active for Station only'
      });
    }

    // 1. Obtain snapshot from existing snapshotService (never duplicate CCTV code)
    let snapshotEvent = null;
    let imageBuffer = null;

    if (req.body?.eventId) {
      // Use existing snapshot event
      snapshotEvent = snapshotService.getSnapshotEvent(req.body.eventId);
      if (!snapshotEvent) {
        return res.status(404).json({ error: 'Specified snapshot event not found' });
      }
      const filePath = snapshotService.getSnapshotFilePath(req.body.eventId);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Snapshot image file missing on disk' });
      }
      imageBuffer = fs.readFileSync(filePath);
    } else {
      // Capture live snapshot using verified snapshot service
      const snapResult = await snapshotService.captureSnapshot('station');
      if (snapResult.error === 'SHOP_NOT_FOUND') {
        return res.status(404).json({ error: 'Shop not found' });
      }
      if (snapResult.status !== 'success') {
        return res.status(200).json({
          status: snapResult.status,
          details: snapResult.details,
          message: 'Could not capture snapshot for detection'
        });
      }
      snapshotEvent = snapResult.event;
      const filePath = path.join(SNAPSHOT_STORAGE_DIR, snapshotEvent.snapshotRef);
      imageBuffer = fs.readFileSync(filePath);
    }

    // 2. Run prototype detection and candidate qualification
    const result = await detectionService.processStationDetections(snapshotEvent, imageBuffer);

    res.status(200).json({
      message: 'Worker detection processed successfully',
      snapshotRef: snapshotEvent.snapshotRef,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Lists candidate worker events for manager review.
 */
const listWorkerEvents = (req, res, next) => {
  try {
    const filters = {
      shopId: 'station',
      reviewStatus: req.query.status
    };
    const events = detectionService.listWorkerEvents(filters);
    res.status(200).json({
      count: events.length,
      events
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Manager verification endpoint to approve or dismiss candidate events.
 * Never executes automated payroll deduction.
 */
const verifyWorkerEvent = (req, res, next) => {
  try {
    const { eventId } = req.params;
    const { action, notes, workerId } = req.body || {};

    if (!action) {
      return res.status(400).json({
        error: 'Missing required field: action',
        allowedActions: ['approve_worker', 'dismiss_customer', 'dismiss_passerby', 'flag_inquiry']
      });
    }

    const updated = detectionService.verifyWorkerEvent(eventId, action, notes, 'admin', workerId);
    if (!updated) {
      return res.status(404).json({ error: 'Worker event not found' });
    }

    res.status(200).json({
      message: 'Worker event reviewed successfully',
      event: updated
    });
  } catch (error) {
    if (
      error.message?.includes('Invalid review action') ||
      error.message?.includes('not found in Station') ||
      error.message?.includes('marked inactive')
    ) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
};

/**
 * Runs controlled accuracy evaluation and threshold sweep for Station Camera 05.
 * Strictly isolated to Station only.
 */
const evaluateStationAccuracy = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Accuracy evaluation is currently isolated to Station only'
      });
    }

    const accuracyEvaluationService = require('../services/accuracyEvaluationService');
    const report = await accuracyEvaluationService.runStationAccuracyEvaluation();
    res.status(200).json({
      message: 'Station Camera 05 accuracy evaluation completed',
      report
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Returns supervised pilot metrics and shift summaries for Station Camera 05.
 */
const getPilotMetrics = (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Supervised pilot metrics are currently active for Station only'
      });
    }

    const metrics = detectionService.getPilotMetrics('station');
    res.status(200).json(metrics);
  } catch (error) {
    next(error);
  }
};

/**
 * Generates and returns a private ROI overlay JPEG with workshop polygon and bounding boxes.
 */
const getStationRoiOverlay = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'ROI overlay generation is currently active for Station only'
      });
    }

    let imageBuffer = null;
    let detections = [];

    if (req.query?.eventId) {
      const filePath = snapshotService.getSnapshotFilePath(req.query.eventId);
      if (filePath && fs.existsSync(filePath)) {
        imageBuffer = fs.readFileSync(filePath);
      }
    }

    // Fallback to real Station snapshot if available
    if (!imageBuffer) {
      const realSnapshotPath = path.join(SNAPSHOT_STORAGE_DIR, 'snap_station_1791559172253_acdd72bd.jpg');
      if (fs.existsSync(realSnapshotPath)) {
        imageBuffer = fs.readFileSync(realSnapshotPath);
      }
    }

    if (!imageBuffer) {
      return res.status(404).json({ error: 'No snapshot available to render ROI overlay' });
    }

    // Run person detection on the image buffer
    const detRes = await detectionService.detectPersons(imageBuffer, 0.40);
    detections = detRes.detections;

    // Render ROI overlay JPEG
    const overlayJpeg = detectionService.generateRoiOverlay(imageBuffer, detections);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline; filename="station_camera_05_roi_overlay.jpg"');
    res.send(overlayJpeg);
  } catch (error) {
    next(error);
  }
};

/**
 * Returns the immutable manager audit history for a candidate event.
 */
const getWorkerEventHistory = (req, res, next) => {
  try {
    const { eventId } = req.params;
    const history = detectionService.getWorkerEventHistory(eventId);
    if (!history) {
      return res.status(404).json({ error: 'Worker event not found' });
    }
    res.status(200).json(history);
  } catch (error) {
    next(error);
  }
};

/**
 * Serves authenticated binary JPEG for a candidate event snapshot.
 */
const getWorkerEventSnapshot = (req, res, next) => {
  try {
    const { eventId } = req.params;
    const events = detectionService.listWorkerEvents();
    const event = events.find((e) => e.eventId === eventId);
    if (!event || !event.snapshotRef) {
      return res.status(404).json({ error: 'Snapshot reference not found for event' });
    }

    const baseName = path.basename(event.snapshotRef);
    const snapId = baseName.replace(/\.jpg$/i, '');
    const filePath = snapshotService.getSnapshotFilePath(snapId);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Snapshot image file missing on disk' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/**
 * Returns shift reconciliation report comparing detections and manager decisions.
 */
const getShiftReconciliation = (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Shift reconciliation reporting is currently active for Station only'
      });
    }

    const report = detectionService.generateShiftReconciliationReport('station', req.query.date || null);
    res.status(200).json(report);
  } catch (error) {
    next(error);
  }
};

/**
 * Records a manual correction discovered during physical manager shift floor walk.
 */
const recordShiftCorrection = (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Shift corrections are currently active for Station only'
      });
    }

    const { shiftDate, shiftKey, correctionType, notes } = req.body;
    if (!shiftDate || !shiftKey || !correctionType || !notes) {
      return res.status(400).json({
        error: 'Missing required fields: shiftDate, shiftKey, correctionType, notes'
      });
    }

    const correction = detectionService.recordManualAuditCorrection(
      'station',
      shiftDate,
      shiftKey,
      correctionType,
      notes
    );

    res.status(201).json({
      message: 'Manual audit correction recorded successfully',
      correction
    });
  } catch (error) {
    next(error);
  }
};

const arrivalSchedulerService = require('../services/arrivalSchedulerService');

/**
 * Returns the status, health, and civil time of the automated morning arrival scheduler.
 */
const getSchedulerStatus = (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Arrival scheduler is restricted to Station Cycles Camera 05 only'
      });
    }

    const status = arrivalSchedulerService.getSchedulerStatus();
    res.status(200).json(status);
  } catch (error) {
    next(error);
  }
};

/**
 * Forces execution of a single detection cycle (e.g. for testing or verification).
 */
const triggerSchedulerCycle = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Arrival scheduler is restricted to Station Cycles Camera 05 only'
      });
    }

    const result = await arrivalSchedulerService.runDetectionCycle({
      forceRun: req.body?.forceRun !== false
    });

    res.status(200).json({
      message: 'Scheduler detection cycle executed',
      result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Starts or stops the background arrival scheduler.
 */
const controlScheduler = (req, res, next) => {
  try {
    const { shopId } = req.params;
    if (shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Arrival scheduler is restricted to Station Cycles Camera 05 only'
      });
    }

    const { action } = req.body || {};
    if (action === 'start') {
      const result = arrivalSchedulerService.startArrivalScheduler(req.body);
      return res.status(200).json(result);
    } else if (action === 'stop') {
      const result = arrivalSchedulerService.stopArrivalScheduler();
      return res.status(200).json(result);
    } else {
      return res.status(400).json({
        error: 'Invalid action',
        details: "Action must be 'start' or 'stop'"
      });
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};
