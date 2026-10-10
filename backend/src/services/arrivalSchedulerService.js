const fs = require('fs');
const path = require('path');
const snapshotService = require('./snapshotService');
const detectionService = require('./detectionService');
const { SNAPSHOT_STORAGE_DIR } = require('../config/env');

// Singleton scheduler state
let schedulerTimer = null;
let isCycleExecuting = false;
let currentPollIntervalMs = 20000; // Default 20s (within required 15-30s window)

const stats = {
  shopId: 'station',
  cameraLabel: 'Camera 05',
  channel: '501 (ISAPI)',
  running: false,
  pollIntervalMs: currentPollIntervalMs,
  confidenceThreshold: 0.40,
  totalCycles: 0,
  successfulCycles: 0,
  failedCycles: 0,
  consecutiveFailures: 0,
  arrivalsDetectedCount: 0,
  lastCycleTimestamp: null,
  lastStatus: 'stopped',
  lastError: null
};

/**
 * Executes a single automated detection cycle on Station Cycles Camera 05.
 * Strictly limited to Station. Never calls other shops.
 */
const runDetectionCycle = async (options = {}) => {
  if (isCycleExecuting) {
    return { skipped: true, reason: 'cycle_already_in_progress' };
  }

  isCycleExecuting = true;
  stats.totalCycles += 1;
  const now = options.mockDate || new Date();
  stats.lastCycleTimestamp = now.toISOString();

  try {
    // 1. Shift check: Mon-Sat 08:30-18:00 Europe/London civil time (BST/GMT aware)
    const inShift = detectionService.isWithinShiftHours(now);
    if (!inShift && !options.forceRun) {
      stats.lastStatus = 'outside_shift_hours';
      return {
        status: 'outside_shift_hours',
        londonTime: detectionService.formatLondonTime(now),
        message: 'Station Cycles workshop bay closed. Scheduled auto-capture paused.'
      };
    }

    // 2. Capture authentic JPEG frame from Station DVR Camera 05 (Channel 501)
    let snapshotEvent = null;
    let imageBuffer = null;

    if (options.mockBuffer) {
      // Allow passing buffer directly for testing
      imageBuffer = options.mockBuffer;
      snapshotEvent = {
        eventId: `snap_mock_${Date.now()}`,
        shopId: 'station',
        cameraLabel: 'Camera 05',
        timestamp: now.toISOString(),
        snapshotRef: `snap_mock_${Date.now()}.jpg`
      };
    } else {
      const snapResult = await snapshotService.captureSnapshot('station');
      if (snapResult.status !== 'success' || !snapResult.event) {
        stats.failedCycles += 1;
        stats.consecutiveFailures += 1;
        stats.lastError = snapResult.details || snapResult.message || `Capture failed with status ${snapResult.status}`;
        stats.lastStatus = 'camera_capture_failed';
        console.warn(`[WARN][ArrivalScheduler] Station Camera 05 capture failed: ${stats.lastError}`);
        return {
          status: 'camera_capture_failed',
          details: stats.lastError
        };
      }

      snapshotEvent = snapResult.event;
      const filePath = path.join(SNAPSHOT_STORAGE_DIR, snapshotEvent.snapshotRef);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Captured snapshot file missing at ${filePath}`);
      }
      imageBuffer = fs.readFileSync(filePath);
    }

    // 3. Strict JPEG magic bytes validation
    if (!snapshotService.isValidJpeg(imageBuffer)) {
      stats.failedCycles += 1;
      stats.consecutiveFailures += 1;
      stats.lastError = 'Invalid JPEG byte signature received from DVR';
      stats.lastStatus = 'invalid_jpeg_received';
      return {
        status: 'invalid_jpeg_received',
        details: stats.lastError
      };
    }

    // Reset failure counter upon authentic frame capture
    stats.consecutiveFailures = 0;
    stats.lastError = null;
    stats.successfulCycles += 1;

    // 4. Run YOLOv8n person detection and spatial session tracking at threshold 0.40
    const detectionResult = await detectionService.processStationDetections(
      snapshotEvent,
      imageBuffer,
      options.precomputedDetections || null
    );

    const newCandidates = (detectionResult.events || []).filter(
      (e) => e.type === 'new_candidate_detected'
    );

    if (newCandidates.length > 0) {
      // New person entered workshop bay — permanent arrival photo created
      stats.arrivalsDetectedCount += newCandidates.length;
      stats.lastStatus = 'arrival_photo_captured';

      console.log(
        `[INFO][ArrivalScheduler] New arrival detected on Camera 05: ${newCandidates.length} candidate event(s) logged for manager review.`
      );

      return {
        status: 'arrival_photo_captured',
        newArrivalsCount: newCandidates.length,
        events: newCandidates,
        snapshotRef: snapshotEvent.snapshotRef,
        londonTime: detectionService.formatLondonTime(now)
      };
    }

    // 5. If no new arrival (either 0 persons detected, or person merged into existing session):
    // Do NOT keep redundant routine polling snapshots on disk.
    // If it was captured during this cycle and not needed for a new arrival event, remove routine frame.
    if (!options.mockBuffer && snapshotEvent?.snapshotRef && !options.keepRoutineFrames) {
      try {
        const filePath = path.join(SNAPSHOT_STORAGE_DIR, snapshotEvent.snapshotRef);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {}
    }

    const hasActiveSession = (detectionResult.events || []).some((e) => e.type === 'session_update');
    stats.lastStatus = hasActiveSession ? 'session_continued' : 'no_person_detected';

    return {
      status: stats.lastStatus,
      personsDetected: detectionResult.personsDetected || 0,
      activeSessionsCount: detectionResult.activeSessionsCount || 0,
      londonTime: detectionService.formatLondonTime(now)
    };
  } catch (err) {
    stats.failedCycles += 1;
    stats.consecutiveFailures += 1;
    stats.lastError = err.message;
    stats.lastStatus = 'cycle_error';
    console.error(`[ERROR][ArrivalScheduler] Cycle execution error: ${err.message}`);
    return {
      status: 'cycle_error',
      error: err.message
    };
  } finally {
    isCycleExecuting = false;
  }
};

/**
 * Starts the automatic morning arrival scheduler (Singleton).
 * Default interval: 20 seconds (15-30s window).
 */
const startArrivalScheduler = (options = {}) => {
  if (schedulerTimer) {
    return {
      started: false,
      alreadyRunning: true,
      message: 'Arrival scheduler is already running'
    };
  }

  const intervalMs = options.pollIntervalMs || currentPollIntervalMs;
  if (intervalMs < 10000 || intervalMs > 60000) {
    throw new Error('pollIntervalMs must be between 10000ms and 60000ms');
  }

  currentPollIntervalMs = intervalMs;
  stats.pollIntervalMs = currentPollIntervalMs;
  stats.running = true;
  stats.lastStatus = 'running';

  schedulerTimer = setInterval(async () => {
    try {
      await runDetectionCycle();
    } catch (err) {
      console.error(`[ERROR][ArrivalScheduler] Unexpected unhandled error: ${err.message}`);
    }
  }, currentPollIntervalMs);

  // Unref timer so it doesn't block Node process exit if needed
  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }

  console.log(
    `[INFO][ArrivalScheduler] Started Station Cycles Camera 05 Arrival Scheduler (every ${currentPollIntervalMs / 1000}s, Mon-Sat 08:30-18:00 London Time)`
  );

  return {
    started: true,
    running: true,
    pollIntervalMs: currentPollIntervalMs
  };
};

/**
 * Stops the automatic morning arrival scheduler.
 */
const stopArrivalScheduler = () => {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  stats.running = false;
  stats.lastStatus = 'stopped';
  return { stopped: true };
};

/**
 * Retrieves current scheduler health, metrics, and civil time status.
 */
const getSchedulerStatus = () => {
  const now = new Date();
  return {
    ...stats,
    withinShiftHours: detectionService.isWithinShiftHours(now),
    londonCivilTime: detectionService.formatLondonTime(now)
  };
};

/**
 * Resets scheduler state (primarily for isolated test suites).
 */
const resetSchedulerState = () => {
  stopArrivalScheduler();
  stats.totalCycles = 0;
  stats.successfulCycles = 0;
  stats.failedCycles = 0;
  stats.consecutiveFailures = 0;
  stats.arrivalsDetectedCount = 0;
  stats.lastCycleTimestamp = null;
  stats.lastStatus = 'stopped';
  stats.lastError = null;
  isCycleExecuting = false;
};

module.exports = {
  startArrivalScheduler,
  stopArrivalScheduler,
  runDetectionCycle,
  getSchedulerStatus,
  resetSchedulerState
};
