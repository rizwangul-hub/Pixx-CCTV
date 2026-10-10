const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
let ort = null;
try {
  ort = require('onnxruntime-node');
} catch (err) {
  console.warn(`[WARN] onnxruntime-node could not be loaded: ${err.message}`);
}
const workerService = require('./workerService');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const MODEL_PATH = path.join(__dirname, '../../models/yolov8n.onnx');
let sessionPromise = null;

const SESSIONS_DIR = isServerless
  ? path.join(os.tmpdir(), 'pixx-cctv', 'sessions')
  : path.join(__dirname, '../../storage/sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'active_sessions.json');
const WORKER_EVENTS_FILE = path.join(SESSIONS_DIR, 'worker_events.json');

// Active presence sessions for spatial de-duplication
// Map: shopId -> Array of activeSession objects
const activeSessions = new Map();
const SESSION_EXPIRY_MS = 90 * 1000; // 90 seconds window for consecutive frames

// In-memory worker candidate review events
let workerEvents = [];
const EVENT_RETENTION_DAYS = 30;

// Shift-level manual corrections (e.g. human floor audits noticing missed detections)
let manualAuditCorrections = [];

/**
 * Ensures sessions storage directory exists.
 */
const ensureSessionsDir = () => {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn(`[WARN] Could not create sessions directory (${SESSIONS_DIR}): ${err.message}`);
  }
};

/**
 * Loads active presence sessions from disk if available.
 * Safely recovers if the session file is malformed or corrupted.
 */
const loadSessionsFromDisk = () => {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      if (!raw || raw.trim() === '') return;
      const data = JSON.parse(raw);
      for (const [shopId, sessions] of Object.entries(data)) {
        if (Array.isArray(sessions)) {
          activeSessions.set(shopId, sessions);
        }
      }
    }
  } catch (err) {
    // Graceful recovery from malformed/corrupted file
    // Preserve service continuity without crashing
    console.warn(`[WARN] Session state file corrupt or invalid, resetting: ${err.message}`);
  }
};

/**
 * Loads worker candidate events from disk if available.
 */
const loadWorkerEventsFromDisk = () => {
  try {
    if (fs.existsSync(WORKER_EVENTS_FILE)) {
      const raw = fs.readFileSync(WORKER_EVENTS_FILE, 'utf8');
      if (!raw || raw.trim() === '') return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        workerEvents = data;
      }
    }
  } catch (err) {
    console.warn(`[WARN] Worker events file corrupt or invalid, resetting: ${err.message}`);
  }
};

/**
 * Persists active presence sessions to disk using atomic write-and-rename.
 * Protects against interrupted writes or server crashes corrupting state.
 */
const saveSessionsToDisk = () => {
  try {
    ensureSessionsDir();
    const obj = {};
    for (const [shopId, sessions] of activeSessions.entries()) {
      obj[shopId] = sessions;
    }
    const tempFile = `${SESSIONS_FILE}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), 'utf8');
    try {
      fs.renameSync(tempFile, SESSIONS_FILE);
    } catch (renameErr) {
      // Windows-specific: if renameSync fails due to existing file lock, copy and clean up temp
      fs.copyFileSync(tempFile, SESSIONS_FILE);
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  } catch (err) {
    // Non-fatal logging
    console.error(`[ERROR] Failed to save sessions to disk: ${err.message}`);
  }
};

/**
 * Persists worker candidate events to disk reliably.
 */
const saveWorkerEventsToDisk = () => {
  try {
    ensureSessionsDir();
    fs.writeFileSync(WORKER_EVENTS_FILE, JSON.stringify(workerEvents, null, 2), 'utf8');
  } catch (err) {
    console.error(`[ERROR] Failed to save worker events to disk: ${err.message}`);
  }
};

// Hydrate existing sessions and candidate events on startup
loadSessionsFromDisk();
loadWorkerEventsFromDisk();

/**
 * Lazily loads and caches the ONNX YOLOv8n inference session.
 */
const getSession = async () => {
  if (!sessionPromise) {
    if (!ort) {
      throw new Error('ONNX runtime (onnxruntime-node) is not available in this environment');
    }
    if (!fs.existsSync(MODEL_PATH)) {
      throw new Error(`YOLOv8n ONNX model not found at ${MODEL_PATH}`);
    }
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu']
    });
  }
  return sessionPromise;
};

/**
 * Preprocesses a raw decoded image for YOLOv8n (640x640 letterbox).
 */
const preprocessImage = (raw, targetW = 640, targetH = 640) => {
  const { width: origW, height: origH, data } = raw;
  const floatData = new Float32Array(3 * targetW * targetH);
  const scale = Math.min(targetW / origW, targetH / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);
  const padX = Math.floor((targetW - newW) / 2);
  const padY = Math.floor((targetH - newH) / 2);

  // Fill with standard 114/255 grey padding
  floatData.fill(114 / 255);

  for (let y = 0; y < newH; y++) {
    const origY = Math.min(Math.floor(y / scale), origH - 1);
    for (let x = 0; x < newW; x++) {
      const origX = Math.min(Math.floor(x / scale), origW - 1);
      const origIdx = (origY * origW + origX) * 4;
      const targetX = padX + x;
      const targetY = padY + y;
      const pixelIdx = targetY * targetW + targetX;

      floatData[pixelIdx] = data[origIdx] / 255.0; // R
      floatData[targetW * targetH + pixelIdx] = data[origIdx + 1] / 255.0; // G
      floatData[2 * targetW * targetH + pixelIdx] = data[origIdx + 2] / 255.0; // B
    }
  }

  return {
    tensor: new ort.Tensor('float32', floatData, [1, 3, targetH, targetW]),
    scale,
    padX,
    padY,
    origW,
    origH
  };
};

/**
 * Calculates Intersection over Union (IoU) between two bounding boxes [x, y, w, h].
 */
const calculateIoU = (boxA, boxB) => {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;

  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);

  const intersectionW = Math.max(0, x2 - x1);
  const intersectionH = Math.max(0, y2 - y1);
  const intersectionArea = intersectionW * intersectionH;

  if (intersectionArea === 0) return 0;

  const areaA = aw * ah;
  const areaB = bw * bh;
  const unionArea = areaA + areaB - intersectionArea;

  return unionArea > 0 ? intersectionArea / unionArea : 0;
};

/**
 * Applies Non-Maximum Suppression (NMS) to eliminate duplicate bounding boxes.
 */
const applyNms = (boxes, iouThreshold = 0.45) => {
  // Sort descending by confidence
  boxes.sort((a, b) => b.confidence - a.confidence);
  const selected = [];

  for (const candidate of boxes) {
    let keep = true;
    for (const chosen of selected) {
      if (calculateIoU(candidate.box, chosen.box) >= iouThreshold) {
        keep = false;
        break;
      }
    }
    if (keep) {
      selected.push(candidate);
    }
  }

  return selected;
};

/**
 * Detects persons in a JPEG buffer using local YOLOv8n ONNX model.
 * Returns strictly detected person boxes and confidence scores.
 */
const detectPersons = async (imageBuffer, confidenceThreshold = 0.40) => {
  const raw = jpeg.decode(imageBuffer, { useTArray: true });
  const { tensor, scale, padX, padY, origW, origH } = preprocessImage(raw);

  const session = await getSession();
  const startTime = Date.now();
  const outputs = await session.run({ images: tensor });
  const inferenceMs = Date.now() - startTime;

  const output = outputs['output0'];
  const [batch, channels, numBoxes] = output.dims;
  const data = output.data;

  const rawCandidates = [];
  // Output format: [cx, cy, w, h, class0_prob (person), class1, ...]
  for (let i = 0; i < numBoxes; i++) {
    const personScore = data[4 * numBoxes + i];
    if (personScore >= confidenceThreshold) {
      const cx = data[0 * numBoxes + i];
      const cy = data[1 * numBoxes + i];
      const w = data[2 * numBoxes + i];
      const h = data[3 * numBoxes + i];

      const origBoxX = Math.max(0, Math.round((cx - w / 2 - padX) / scale));
      const origBoxY = Math.max(0, Math.round((cy - h / 2 - padY) / scale));
      const origBoxW = Math.min(origW - origBoxX, Math.round(w / scale));
      const origBoxH = Math.min(origH - origBoxY, Math.round(h / scale));

      rawCandidates.push({
        box: [origBoxX, origBoxY, origBoxW, origBoxH],
        confidence: Number(personScore.toFixed(4)),
        class: 'person'
      });
    }
  }

  const suppressedDetections = applyNms(rawCandidates, 0.45);

  return {
    inferenceMs,
    imageDimensions: { width: origW, height: origH },
    personCount: suppressedDetections.length,
    detections: suppressedDetections
  };
};

/**
 * Extracts London civil time components (handling GMT/BST automatically).
 */
const getLondonTimeParts = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }
  const isSunday = partMap.weekday === 'Sun';
  const hour = parseInt(partMap.hour, 10);
  const minute = parseInt(partMap.minute, 10);
  return { isSunday, hour, minute, decimalHours: hour + minute / 60 };
};

/**
 * Checks whether an event timestamp falls within approved workshop hours.
 * Station default shift hours: Mon-Sat 08:30 - 18:00 (London civil time).
 */
const isWithinShiftHours = (date = new Date()) => {
  const { isSunday, decimalHours } = getLondonTimeParts(date);
  if (isSunday) return false; // Closed on Sundays
  return decimalHours >= 8.5 && decimalHours <= 18.0;
};

/**
 * Formats a timestamp into official London civil time string (GMT/BST aware).
 */
const formatLondonTime = (date = new Date()) => {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date(date));
};

/**
 * Calibrated Station Camera 05 Workshop Bay Polygon (704x576 coordinate space).
 * Strictly encloses the bicycle parking tarmac and racks, excluding public road and pavement.
 */
const STATION_BAY_POLYGON = [
  [140, 576],  // Bottom-left edge of bicycle storage bay
  [200, 360],  // Mid-left boundary separating bike rack tarmac from roadway
  [380, 150],  // Upper bike rack boundary near building
  [704, 150],  // Upper-right wall boundary
  [704, 576]   // Bottom-right corner
];

/**
 * Point-in-polygon ray-casting algorithm.
 * Returns true if point [px, py] is inside polygon vertices.
 */
const isPointInPolygon = (point, polygon = STATION_BAY_POLYGON) => {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > py) !== (yj > py))
      && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

/**
 * Checks whether a bounding box [x, y, w, h] overlaps with Station Camera 05's
 * primary bicycle rack & workshop bay polygon (Zone A).
 */
const isInWorkshopBay = (box, polygon = STATION_BAY_POLYGON) => {
  const [x, y, w, h] = box;
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const footY = y + h * 0.85;

  return isPointInPolygon([centerX, centerY], polygon) || isPointInPolygon([centerX, footY], polygon);
};

/**
 * Process detections for Station, applying spatial tracking, de-duplication,
 * and rule-based candidate qualification without facial recognition.
 */
const processStationDetections = async (snapshotEvent, imageBuffer, precomputedDetections = null) => {
  const shopId = 'station';
  const timestamp = snapshotEvent?.timestamp || new Date().toISOString();
  const eventDate = new Date(timestamp);

  // 1. Run pure person detection (or use precomputed)
  const detectionResult = precomputedDetections || (await module.exports.detectPersons(imageBuffer));

  // Manage active sessions for Station
  const nowMs = eventDate.getTime();
  let currentShopSessions = activeSessions.get(shopId) || [];

  // Evict expired sessions
  currentShopSessions = currentShopSessions.filter((s) => nowMs - s.lastSeenMs < SESSION_EXPIRY_MS);

  const matchedEvents = [];

  for (const det of detectionResult.detections) {
    // Check spatial IoU overlap against existing active sessions
    let matchedSession = null;
    for (const session of currentShopSessions) {
      if (calculateIoU(det.box, session.lastBox) >= 0.30) {
        matchedSession = session;
        break;
      }
    }

    if (matchedSession) {
      // Merge into existing session — do not emit duplicate new arrival event
      matchedSession.lastSeenMs = nowMs;
      matchedSession.lastBox = det.box;
      matchedSession.sampleCount += 1;
      matchedSession.maxConfidence = Math.max(matchedSession.maxConfidence, det.confidence);
      matchedSession.dwellTimeSeconds = Math.round((nowMs - matchedSession.firstSeenMs) / 1000);

      matchedEvents.push({
        type: 'session_update',
        sessionId: matchedSession.sessionId,
        isNewArrival: false,
        sampleCount: matchedSession.sampleCount,
        dwellTimeSeconds: matchedSession.dwellTimeSeconds,
        box: det.box,
        confidence: det.confidence
      });
    } else {
      // New candidate presence session
      const sessionId = `sess_${shopId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const newSession = {
        sessionId,
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
        lastBox: det.box,
        sampleCount: 1,
        maxConfidence: det.confidence,
        dwellTimeSeconds: 0
      };
      currentShopSessions.push(newSession);

      // Evaluate non-biometric worker qualification rules
      const scheduleMatch = isWithinShiftHours(eventDate);
      const zoneMatch = isInWorkshopBay(det.box);

      // Candidate classification
      let candidateRole = 'unclassified_person';
      if (!scheduleMatch) {
        candidateRole = 'after_hours_activity';
      } else if (!zoneMatch) {
        candidateRole = 'passerby_or_pedestrian';
      } else {
        candidateRole = 'candidate_worker'; // Qualified for manager review
      }

      // Create manager-review candidate event
      const eventId = `wevt_${shopId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const candidateRecord = {
        eventId,
        shopId,
        cameraLabel: 'Camera 05',
        timestamp,
        sessionId,
        detectionConfidence: det.confidence,
        box: det.box,
        snapshotRef: snapshotEvent?.snapshotRef || null,
        qualificationCriteria: {
          withinShiftHours: scheduleMatch,
          inWorkshopBay: zoneMatch,
          candidateRole
        },
        reviewStatus: 'pending_review', // Strictly requires human manager review
        assignedWorkerId: null, // Strictly no automated identity guessing
        assignedWorkerName: null,
        reviewedBy: null,
        reviewedAt: null,
        managerResolution: null,
        reviewerNotes: null,
        payrollImpact: 'none', // Strict guarantee: no automated deduction
        auditHistory: [
          {
            action: 'candidate_logged',
            performedBy: 'system_detection',
            timestamp,
            details: {
              candidateRole,
              confidence: det.confidence,
              inWorkshopBay: zoneMatch,
              withinShiftHours: scheduleMatch
            }
          }
        ]
      };

      workerEvents.unshift(candidateRecord);

      matchedEvents.push({
        type: 'new_candidate_detected',
        sessionId,
        eventId,
        isNewArrival: true,
        candidateRole,
        reviewStatus: 'pending_review',
        box: det.box,
        confidence: det.confidence
      });
    }
  }

  activeSessions.set(shopId, currentShopSessions);
  saveSessionsToDisk();
  saveWorkerEventsToDisk();

  return {
    shopId,
    cameraLabel: 'Camera 05',
    timestamp,
    inferenceMs: detectionResult.inferenceMs,
    personsDetected: detectionResult.personCount,
    detections: detectionResult.detections,
    activeSessionsCount: currentShopSessions.length,
    events: matchedEvents
  };
};

/**
 * Manager review action for a candidate event with immutable audit history.
 */
const verifyWorkerEvent = (eventId, action, reviewerNotes = null, managerId = 'admin', workerId = null, options = {}) => {
  const validActions = ['approve_worker', 'dismiss_customer', 'dismiss_passerby', 'flag_inquiry'];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid review action: ${action}`);
  }

  const record = workerEvents.find((e) => e.eventId === eventId);
  if (!record) return null;

  const previousStatus = record.reviewStatus;
  const previousWorkerId = record.assignedWorkerId || null;
  const previousWorkerName = record.assignedWorkerName || null;
  const newStatus = action === 'approve_worker' ? 'verified_worker' : (action === 'flag_inquiry' ? 'flagged_inquiry' : 'dismissed');
  const now = new Date().toISOString();

  let assignedWorker = null;

  if (action === 'approve_worker') {
    if (workerId) {
      const worker = workerService.getWorkerById(workerId);
      if (!worker) {
        throw new Error(`Worker ID '${workerId}' not found in Station workshop roster`);
      }
      if (!worker.active) {
        throw new Error(`Worker '${worker.name}' (${workerId}) is marked inactive`);
      }
      assignedWorker = worker;
      record.assignedWorkerId = worker.workerId;
      record.assignedWorkerName = worker.name;

      // Extract session details if available for dwell time and uncertainty check
      const currentSessions = activeSessions.get(record.shopId?.toLowerCase() || 'station') || [];
      const session = currentSessions.find((s) => s.sessionId === record.sessionId);
      const dwellTimeSeconds = session ? session.dwellTimeSeconds : 0;
      const sampleCount = session ? session.sampleCount : 1;

      workerService.linkEventToWorkerAttendance(record, worker, managerId, {
        dwellTimeSeconds,
        sampleCount,
        firstSeenTime: session?.firstSeenMs ? new Date(session.firstSeenMs).toISOString() : record.timestamp,
        lastSeenTime: session?.lastSeenMs ? new Date(session.lastSeenMs).toISOString() : record.timestamp,
        ...options
      });
    } else {
      record.assignedWorkerId = null;
      record.assignedWorkerName = null;
    }
  } else {
    // If dismissed or flagged, unlink from attendance if previously linked
    if (record.assignedWorkerId) {
      workerService.unlinkEventFromAttendance(record.eventId);
    }
    record.assignedWorkerId = null;
    record.assignedWorkerName = null;
  }

  record.reviewStatus = newStatus;
  record.managerResolution = action;
  record.reviewedBy = managerId;
  record.reviewedAt = now;
  record.reviewerNotes = reviewerNotes || null;

  if (!Array.isArray(record.auditHistory)) {
    record.auditHistory = [];
  }

  const auditEntry = {
    action,
    performedBy: managerId,
    timestamp: now,
    previousStatus,
    newStatus,
    notes: reviewerNotes || null
  };

  if (assignedWorker) {
    auditEntry.assignedWorkerId = assignedWorker.workerId;
    auditEntry.assignedWorkerName = assignedWorker.name;
    if (previousWorkerId && previousWorkerId !== assignedWorker.workerId) {
      auditEntry.previousWorkerId = previousWorkerId;
      auditEntry.previousWorkerName = previousWorkerName;
    }
  }

  record.auditHistory.push(auditEntry);
  saveWorkerEventsToDisk();

  return record;
};

/**
 * Supervised pilot metrics aggregator across processed frames and manager actions.
 */
const getPilotMetrics = (shopId = 'station') => {
  const shopEvents = workerEvents.filter((e) => e.shopId.toLowerCase() === shopId.toLowerCase());

  const totalCandidates = shopEvents.length;
  const pendingReview = shopEvents.filter((e) => e.reviewStatus === 'pending_review').length;
  const verifiedWorkers = shopEvents.filter((e) => e.reviewStatus === 'verified_worker').length;
  const dismissedCustomers = shopEvents.filter((e) => e.managerResolution === 'dismiss_customer').length;
  const dismissedPasserby = shopEvents.filter((e) => e.managerResolution === 'dismiss_passerby').length;
  const flaggedInquiries = shopEvents.filter((e) => e.managerResolution === 'flag_inquiry').length;

  const currentSessions = activeSessions.get(shopId.toLowerCase()) || [];

  return {
    shopId,
    cameraLabel: 'Camera 05',
    supervisedPilotActive: true,
    activeThreshold: 0.40,
    metricsSummary: {
      totalCandidateEventsLogged: totalCandidates,
      pendingManagerReviewCount: pendingReview,
      managerVerifiedWorkers: verifiedWorkers,
      managerDismissedCustomers: dismissedCustomers,
      managerDismissedPassersby: dismissedPasserby,
      flaggedInquiries,
      activeLiveSessionsCount: currentSessions.length
    },
    governanceStatus: {
      automatedPayrollDeductionsEnabled: false,
      automatedAttendanceConfirmed: false,
      allEventsPendingOrConfirmedByManager: true,
      facialRecognitionActive: false
    }
  };
};

/**
 * Generates shift-level reconciliation report comparing AI detections against manager resolutions.
 * Shift periods (London civil time):
 * - Morning Shift: 08:30 - 13:00
 * - Afternoon Shift: 13:00 - 18:00
 * - After-Hours: Outside 08:30 - 18:00
 */
const generateShiftReconciliationReport = (shopId = 'station', targetDate = null) => {
  const shopEvents = workerEvents.filter((e) => e.shopId.toLowerCase() === shopId.toLowerCase());

  // Filter by date if specified (YYYY-MM-DD)
  const filteredEvents = targetDate
    ? shopEvents.filter((e) => e.timestamp.startsWith(targetDate))
    : shopEvents;

  const shifts = {
    morning_shift: { name: 'Morning Shift (08:30 - 13:00)', events: [] },
    afternoon_shift: { name: 'Afternoon Shift (13:00 - 18:00)', events: [] },
    after_hours: { name: 'After-Hours Activity', events: [] }
  };

  for (const ev of filteredEvents) {
    const { decimalHours } = getLondonTimeParts(new Date(ev.timestamp));
    if (decimalHours >= 8.5 && decimalHours < 13.0) {
      shifts.morning_shift.events.push(ev);
    } else if (decimalHours >= 13.0 && decimalHours <= 18.0) {
      shifts.afternoon_shift.events.push(ev);
    } else {
      shifts.after_hours.events.push(ev);
    }
  }

  const summarizeShift = (shiftList, shiftKey) => {
    const total = shiftList.length;
    const verified = shiftList.filter((e) => e.reviewStatus === 'verified_worker').length;
    const dismissedCust = shiftList.filter((e) => e.managerResolution === 'dismiss_customer').length;
    const dismissedPass = shiftList.filter((e) => e.managerResolution === 'dismiss_passerby').length;
    const flagged = shiftList.filter((e) => e.managerResolution === 'flag_inquiry').length;
    const pending = shiftList.filter((e) => e.reviewStatus === 'pending_review').length;

    const shiftCorrections = manualAuditCorrections.filter((c) => {
      const matchShop = c.shopId.toLowerCase() === shopId.toLowerCase();
      const matchShift = c.shiftKey === shiftKey;
      const matchDate = targetDate ? c.shiftDate === targetDate : true;
      return matchShop && matchShift && matchDate;
    });

    const missedCount = shiftCorrections.filter((c) => c.correctionType === 'missed_detection').length;
    const duplicateCount = shiftCorrections.filter((c) => c.correctionType === 'duplicate_anomaly').length;

    return {
      candidatesLogged: total,
      managerVerifiedWorkers: verified,
      dismissedCustomers: dismissedCust,
      dismissedPassersby: dismissedPass,
      flaggedInquiries: flagged,
      pendingReview: pending,
      manualCorrections: {
        totalReported: shiftCorrections.length,
        knownMissedDetections: missedCount,
        duplicateAnomalies: duplicateCount,
        corrections: shiftCorrections
      },
      reconciliationComplete: pending === 0 && total > 0
    };
  };

  const morningSummary = summarizeShift(shifts.morning_shift.events, 'morning');
  const afternoonSummary = summarizeShift(shifts.afternoon_shift.events, 'afternoon');
  const afterHoursSummary = summarizeShift(shifts.after_hours.events, 'after_hours');

  const totalMissed = manualAuditCorrections
    .filter((c) => (targetDate ? c.shiftDate === targetDate : true))
    .filter((c) => c.correctionType === 'missed_detection').length;

  return {
    shopId,
    cameraLabel: 'Camera 05',
    generatedAt: new Date().toISOString(),
    filterDate: targetDate || 'all_available_records',
    activeThreshold: 0.40,
    shifts: {
      morning: { ...shifts.morning_shift, summary: morningSummary },
      afternoon: { ...shifts.afternoon_shift, summary: afternoonSummary },
      afterHours: { ...shifts.after_hours, summary: afterHoursSummary }
    },
    totalReconciliationSummary: {
      totalCandidatesLogged: filteredEvents.length,
      totalVerifiedWorkers: filteredEvents.filter((e) => e.reviewStatus === 'verified_worker').length,
      totalDismissedCustomers: filteredEvents.filter((e) => e.managerResolution === 'dismiss_customer').length,
      totalDismissedPassersby: filteredEvents.filter((e) => e.managerResolution === 'dismiss_passerby').length,
      totalFlaggedInquiries: filteredEvents.filter((e) => e.managerResolution === 'flag_inquiry').length,
      totalPendingReview: filteredEvents.filter((e) => e.reviewStatus === 'pending_review').length,
      totalManualMissedDetectionsReported: totalMissed,
      automatedPayrollDeductionsEnabled: false,
      allAttendanceDecisionsManual: true
    }
  };
};

/**
 * Records a manual correction discovered during manager physical shift floor walk.
 */
const recordManualAuditCorrection = (shopId, shiftDate, shiftKey, correctionType, notes, managerId = 'admin') => {
  const correction = {
    correctionId: `corr_${shopId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    shopId: shopId.toLowerCase(),
    shiftDate,
    shiftKey, // 'morning' | 'afternoon' | 'after_hours'
    correctionType, // 'missed_detection' | 'duplicate_anomaly' | 'other'
    notes,
    recordedBy: managerId,
    recordedAt: new Date().toISOString()
  };
  manualAuditCorrections.push(correction);
  return correction;
};

/**
 * Draws polygon ROI overlay and bounding boxes onto a raw JPEG buffer.
 * Native coordinate system: 704 x 576.
 */
const generateRoiOverlay = (imageBuffer, detections = []) => {
  const decoded = jpeg.decode(imageBuffer, { useTArray: true });
  const { width, height, data } = decoded;

  // Helper to draw a pixel with bounds check
  const setPixel = (x, y, r, g, b) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    data[idx] = r;
    data[idx + 1] = g;
    data[idx + 2] = b;
  };

  // Helper to draw a line (Bresenham)
  const drawLine = (x0, y0, x1, y1, r, g, b, thickness = 2) => {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1;
    let sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let cx = x0;
    let cy = y0;

    while (true) {
      for (let tx = -thickness; tx <= thickness; tx++) {
        for (let ty = -thickness; ty <= thickness; ty++) {
          setPixel(cx + tx, cy + ty, r, g, b);
        }
      }

      if (cx === x1 && cy === y1) break;
      let e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
  };

  // 1. Draw workshop bay polygon in Cyan (0, 255, 255)
  const poly = STATION_BAY_POLYGON;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    drawLine(p1[0], p1[1], p2[0], p2[1], 0, 255, 255, 2);
  }

  // 2. Draw detection boxes: Green if in workshop bay, Red if outside
  for (const det of detections) {
    const [x, y, w, h] = det.box;
    const inBay = isInWorkshopBay(det.box);
    const r = inBay ? 0 : 255;
    const g = inBay ? 255 : 0;
    const b = 0;

    // Rectangle edges
    drawLine(x, y, x + w, y, r, g, b, 2);
    drawLine(x + w, y, x + w, y + h, r, g, b, 2);
    drawLine(x + w, y + h, x, y + h, r, g, b, 2);
    drawLine(x, y + h, x, y, r, g, b, 2);
  }

  // Re-encode JPEG
  const encoded = jpeg.encode({ data, width, height }, 85);
  return encoded.data;
};

/**
 * List candidate worker events with optional filters.
 */
const listWorkerEvents = (filters = {}) => {
  let list = [...workerEvents];
  if (filters.shopId) {
    list = list.filter((e) => e.shopId.toLowerCase() === filters.shopId.toLowerCase());
  }
  if (filters.reviewStatus) {
    list = list.filter((e) => e.reviewStatus === filters.reviewStatus);
  }
  return list;
};

/**
 * Reset service state (for unit test isolation).
 */
const resetDetectionService = () => {
  activeSessions.clear();
  workerEvents = [];
  manualAuditCorrections = [];
  if (workerService && typeof workerService.resetWorkerService === 'function') {
    workerService.resetWorkerService();
  }
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      fs.unlinkSync(SESSIONS_FILE);
    }
    if (fs.existsSync(WORKER_EVENTS_FILE)) {
      fs.unlinkSync(WORKER_EVENTS_FILE);
    }
  } catch (_) {}
};

/**
 * Retrieves the full audit history for a candidate event.
 */
const getWorkerEventHistory = (eventId) => {
  const record = workerEvents.find((e) => e.eventId === eventId);
  if (!record) return null;
  return {
    eventId: record.eventId,
    shopId: record.shopId,
    reviewStatus: record.reviewStatus,
    managerResolution: record.managerResolution,
    auditHistory: record.auditHistory || []
  };
};

module.exports = {
  detectPersons,
  processStationDetections,
  verifyWorkerEvent,
  listWorkerEvents,
  getWorkerEventHistory,
  getPilotMetrics,
  generateShiftReconciliationReport,
  recordManualAuditCorrection,
  generateRoiOverlay,
  resetDetectionService,
  calculateIoU,
  applyNms,
  isWithinShiftHours,
  formatLondonTime,
  isInWorkshopBay,
  getLondonTimeParts,
  isPointInPolygon,
  STATION_BAY_POLYGON,
  loadSessionsFromDisk,
  saveSessionsToDisk
};
