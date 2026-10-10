const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const WORKERS_DIR = isServerless
  ? path.join(os.tmpdir(), 'pixx-cctv', 'workers')
  : path.join(__dirname, '../../storage/workers');
const WORKERS_FILE = path.join(WORKERS_DIR, 'station_workers.json');
const ATTENDANCE_FILE = path.join(WORKERS_DIR, 'attendance_records.json');

const AUTHORIZED_SHOPS = ['station', 'camden', 'chelsea', 'edgeware', 'southwark', 'leabridge'];

const isAuthorizedShop = (shopId) => {
  if (!shopId || typeof shopId !== 'string') return false;
  return AUTHORIZED_SHOPS.includes(shopId.toLowerCase());
};

// Default initial roster for Station Cycles workshop
const DEFAULT_STATION_WORKERS = [
  {
    workerId: 'worker_st_01',
    name: 'Dave Miller',
    role: 'Senior Mechanic',
    shopId: 'station',
    shiftStart: '08:30',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  },
  {
    workerId: 'worker_st_02',
    name: 'Sarah Jenkins',
    role: 'Bicycle Technician',
    shopId: 'station',
    shiftStart: '08:30',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  },
  {
    workerId: 'worker_st_03',
    name: 'Alex Rivera',
    role: 'Workshop Apprentice',
    shopId: 'station',
    shiftStart: '08:30',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  }
];

let workers = [];
let attendanceRecords = [];

const ensureStorageDir = () => {
  try {
    if (!fs.existsSync(WORKERS_DIR)) {
      fs.mkdirSync(WORKERS_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn(`[WARN] Could not create workers directory (${WORKERS_DIR}): ${err.message}`);
  }
};

/**
 * Loads workers from disk or initializes defaults.
 */
const loadWorkersFromDisk = () => {
  try {
    ensureStorageDir();
    if (fs.existsSync(WORKERS_FILE)) {
      const raw = fs.readFileSync(WORKERS_FILE, 'utf8');
      if (raw && raw.trim()) {
        workers = JSON.parse(raw);
        return;
      }
    }
  } catch (err) {
    console.warn(`[WARN] Failed to load workers from disk: ${err.message}`);
  }
  // Initialize defaults for Station
  workers = JSON.parse(JSON.stringify(DEFAULT_STATION_WORKERS));
  saveWorkersToDisk();
};

/**
 * Saves workers to disk reliably.
 */
const saveWorkersToDisk = () => {
  try {
    ensureStorageDir();
    fs.writeFileSync(WORKERS_FILE, JSON.stringify(workers, null, 2), 'utf8');
  } catch (err) {
    console.error(`[ERROR] Failed to save workers: ${err.message}`);
  }
};

/**
 * Loads attendance records from disk.
 */
const loadAttendanceFromDisk = () => {
  try {
    ensureStorageDir();
    if (fs.existsSync(ATTENDANCE_FILE)) {
      const raw = fs.readFileSync(ATTENDANCE_FILE, 'utf8');
      if (raw && raw.trim()) {
        attendanceRecords = JSON.parse(raw);
        return;
      }
    }
  } catch (err) {
    console.warn(`[WARN] Failed to load attendance records: ${err.message}`);
  }
  attendanceRecords = [];
};

/**
 * Saves attendance records to disk reliably.
 */
const saveAttendanceToDisk = () => {
  try {
    ensureStorageDir();
    fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(attendanceRecords, null, 2), 'utf8');
  } catch (err) {
    console.error(`[ERROR] Failed to save attendance: ${err.message}`);
  }
};

// Initial hydration
loadWorkersFromDisk();
loadAttendanceFromDisk();

/**
 * List workers for any authorized shop.
 */
const listWorkers = ({ shopId = 'station', activeOnly = false } = {}) => {
  const normShop = (shopId || 'station').toLowerCase();
  if (!isAuthorizedShop(normShop)) {
    throw new Error(`Shop '${shopId}' is not an authorized shop`);
  }

  let list = workers.filter((w) => w.shopId.toLowerCase() === normShop);
  if (activeOnly) {
    list = list.filter((w) => w.active === true);
  }
  return list;
};

/**
 * Get single worker by ID.
 */
const getWorkerById = (workerId) => {
  if (!workerId) return null;
  return workers.find((w) => w.workerId === workerId) || null;
};

/**
 * Create a new worker profile for an authorized shop.
 */
const createWorker = ({ name, role, shopId = 'station', shiftStart = '08:30' }) => {
  const normShop = (shopId || 'station').toLowerCase();
  if (!isAuthorizedShop(normShop)) {
    throw new Error(`Shop '${shopId}' is not an authorized shop`);
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Worker name is required');
  }
  if (!role || typeof role !== 'string' || !role.trim()) {
    throw new Error('Worker role is required');
  }

  const prefix = normShop.slice(0, 2);
  const workerId = `worker_${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  const newWorker = {
    workerId,
    name: name.trim(),
    role: role.trim(),
    shopId: normShop,
    shiftStart: shiftStart && typeof shiftStart === 'string' ? shiftStart.trim() : '08:30',
    active: true,
    createdAt: new Date().toISOString()
  };

  workers.push(newWorker);
  saveWorkersToDisk();
  return newWorker;
};

/**
 * Update an existing worker.
 */
const updateWorker = (workerId, updates = {}) => {
  const worker = getWorkerById(workerId);
  if (!worker) return null;

  if (updates.name && typeof updates.name === 'string' && updates.name.trim()) {
    worker.name = updates.name.trim();
  }
  if (updates.role && typeof updates.role === 'string' && updates.role.trim()) {
    worker.role = updates.role.trim();
  }
  if (updates.shiftStart && typeof updates.shiftStart === 'string') {
    worker.shiftStart = updates.shiftStart.trim();
  }
  if (typeof updates.active === 'boolean') {
    worker.active = updates.active;
  }
  worker.updatedAt = new Date().toISOString();

  saveWorkersToDisk();
  return worker;
};

/**
 * Deactivates or removes a worker.
 */
const deactivateWorker = (workerId) => {
  return updateWorker(workerId, { active: false });
};

/**
 * Computes late minutes against configured shift start in Europe/London civil time.
 */
const calculateLatenessLondon = (arrivalIso, shiftStartStr = '08:30') => {
  try {
    const arrivalDate = new Date(arrivalIso);
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(arrivalDate);
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const minPart = parts.find((p) => p.type === 'minute')?.value;
    if (!hourPart || !minPart) {
      return { lateMinutes: 0, arrivalUkFormatted: arrivalIso, scheduledStart: shiftStartStr || '08:30' };
    }

    const arrHour = parseInt(hourPart, 10);
    const arrMin = parseInt(minPart, 10);
    const arrivalMins = arrHour * 60 + arrMin;

    const [shHour, shMin] = (shiftStartStr || '08:30').split(':').map(Number);
    const shiftMins = (shHour || 0) * 60 + (shMin || 0);

    const lateMinutes = arrivalMins > shiftMins ? arrivalMins - shiftMins : 0;
    const arrivalUkFormatted = `${hourPart}:${minPart} UK Time`;

    return {
      lateMinutes,
      arrivalUkFormatted,
      scheduledStart: shiftStartStr || '08:30'
    };
  } catch (_) {
    return { lateMinutes: 0, arrivalUkFormatted: arrivalIso, scheduledStart: shiftStartStr || '08:30' };
  }
};

/**
 * Links a manager-confirmed worker event to the worker's attendance record.
 * Evaluates lateness, uncertainty flags, reliable departures, and guarantees zero automated payroll impact.
 */
const linkEventToWorkerAttendance = (workerEvent, worker, managerId = 'admin', options = {}) => {
  if (!worker || !worker.workerId) {
    throw new Error('Valid worker profile required for attendance record linking');
  }
  if (!workerEvent || !workerEvent.eventId) {
    throw new Error('Valid worker candidate event required for attendance linking');
  }

  const nowIso = new Date().toISOString();
  const eventTime = workerEvent.timestamp || nowIso;
  const eventDate = eventTime.slice(0, 10); // YYYY-MM-DD
  const shopId = (worker.shopId || workerEvent.shopId || 'station').toLowerCase();

  const reasons = [];
  let uncertainTimes = false;

  const dwellSec = options.dwellTimeSeconds !== undefined ? options.dwellTimeSeconds : 0;
  const sampleCount = options.sampleCount !== undefined ? options.sampleCount : 1;

  if (sampleCount <= 1 || dwellSec < 60) {
    uncertainTimes = true;
    reasons.push('single_snapshot_or_short_dwell');
  }

  if (workerEvent.qualificationCriteria?.withinShiftHours === false) {
    uncertainTimes = true;
    reasons.push('outside_standard_shift_hours');
  }

  if (typeof options.uncertainTimes === 'boolean') {
    uncertainTimes = options.uncertainTimes;
  }

  // Calculate lateness using worker's shift start in London timezone
  const shiftStart = worker.shiftStart || '08:30';
  const observedArrival = options.firstSeenTime || eventTime;
  const { lateMinutes, arrivalUkFormatted, scheduledStart } = calculateLatenessLondon(observedArrival, shiftStart);

  // Reliable departure handling:
  // "Record departure only when a real, sufficiently reliable departure event is available.
  // Do not invent departure times from missing detections."
  const departureTime = options.departureTime || (options.isDepartureVerified ? (options.lastSeenTime || null) : null);
  const departureStatus = departureTime ? 'confirmed_departure' : 'active_not_departed';
  const departureEvidence = departureTime ? (options.departureEvidence || options.lastSnapshotRef || null) : null;

  // Proposed deduction displayed separately, strictly requiring human approval:
  const proposedDeduction = {
    lateMinutes,
    formula: lateMinutes > 0 ? `${lateMinutes} min late vs ${scheduledStart} start` : 'On time / early',
    estimatedDeduction: lateMinutes > 0 ? `£${(lateMinutes * 0.25).toFixed(2)}` : '£0.00',
    approvalStatus: 'requires_authorized_human_approval',
    approvedBy: null,
    approvedAt: null
  };

  let record = attendanceRecords.find((r) => r.eventId === workerEvent.eventId);

  if (record) {
    // Reassignment or update with audit record
    record.workerId = worker.workerId;
    record.workerName = worker.name;
    record.shopId = shopId;
    record.scheduledStart = scheduledStart;
    record.observedArrival = observedArrival;
    record.arrivalUkFormatted = arrivalUkFormatted;
    record.lateMinutes = lateMinutes;
    record.departureTime = departureTime;
    record.departureStatus = departureStatus;
    record.departureEvidence = departureEvidence;
    record.arrivalEvidence = workerEvent.snapshotRef || record.arrivalEvidence || null;
    record.proposedDeduction = proposedDeduction;
    record.uncertainTimes = uncertainTimes;
    record.uncertaintyReasons = reasons;
    record.updatedAt = nowIso;
    record.updatedBy = managerId;
    record.reviewerNotes = workerEvent.reviewerNotes || null;
  } else {
    const attendanceId = `att_${worker.workerId}_${workerEvent.eventId}`;
    record = {
      attendanceId,
      workerId: worker.workerId,
      workerName: worker.name,
      shopId,
      cameraLabel: workerEvent.cameraLabel || (shopId === 'station' ? 'Camera 05' : 'CCTV Camera'),
      eventId: workerEvent.eventId,
      sessionId: workerEvent.sessionId || null,
      date: eventDate,
      timestamp: eventTime,
      scheduledStart,
      observedArrival,
      firstSeenTime: observedArrival,
      lastSeenTime: options.lastSeenTime || eventTime,
      arrivalUkFormatted,
      lateMinutes,
      departureTime,
      departureStatus,
      departureEvidence,
      arrivalEvidence: workerEvent.snapshotRef || null,
      dwellTimeSeconds: dwellSec,
      sampleCount,
      detectionConfidence: workerEvent.detectionConfidence || null,
      uncertainTimes,
      uncertaintyReasons: reasons,
      reviewStatus: 'confirmed_presence',
      proposedDeduction,
      payrollImpact: 'none', // Strictly guaranteed: payroll deductions disabled
      payrollDeductionsEnabled: false,
      payrollApprovalRequired: true,
      confirmedBy: managerId,
      confirmedAt: nowIso,
      reviewerNotes: workerEvent.reviewerNotes || null
    };
    attendanceRecords.unshift(record);
  }

  saveAttendanceToDisk();
  return record;
};

/**
 * Removes or revokes attendance record for an event if dismissed or cancelled.
 */
const unlinkEventFromAttendance = (eventId) => {
  const index = attendanceRecords.findIndex((r) => r.eventId === eventId);
  if (index !== -1) {
    attendanceRecords.splice(index, 1);
    saveAttendanceToDisk();
  }
};

/**
 * Gets attendance history for a specific worker.
 */
const getWorkerAttendance = (workerId, { date = null } = {}) => {
  const worker = getWorkerById(workerId);
  if (!worker) {
    return null;
  }

  let list = attendanceRecords.filter((r) => r.workerId === workerId);
  if (date) {
    list = list.filter((r) => r.date === date);
  }

  const uncertainCount = list.filter((r) => r.uncertainTimes === true).length;
  const totalDwellSec = list.reduce((acc, cur) => acc + (cur.dwellTimeSeconds || 0), 0);
  const totalLateMinutes = list.reduce((acc, cur) => acc + (cur.lateMinutes || 0), 0);

  return {
    workerId: worker.workerId,
    workerName: worker.name,
    role: worker.role,
    shopId: worker.shopId,
    shiftStart: worker.shiftStart || '08:30',
    cameraLabel: worker.shopId === 'station' ? 'Camera 05' : 'CCTV Camera',
    totalConfirmedEvents: list.length,
    uncertainTimesEventsCount: uncertainCount,
    totalDwellMinutes: Math.round(totalDwellSec / 60),
    totalLateMinutes,
    payrollImpact: 'none',
    payrollDeductionsEnabled: false,
    payrollNotice: 'Automated payroll deductions and salary adjustments are disabled. Attendance records require manual review.',
    attendanceRecords: list
  };
};

/**
 * List all attendance records for an authorized shop.
 */
const listAttendanceRecords = ({ shopId = 'station', date = null, workerId = null } = {}) => {
  const normShop = (shopId || 'station').toLowerCase();
  if (!isAuthorizedShop(normShop)) {
    throw new Error(`Shop '${shopId}' is not an authorized shop`);
  }

  let list = attendanceRecords.filter((r) => r.shopId.toLowerCase() === normShop);
  if (date) {
    list = list.filter((r) => r.date === date);
  }
  if (workerId) {
    list = list.filter((r) => r.workerId === workerId);
  }

  return {
    shopId: normShop,
    cameraLabel: normShop === 'station' ? 'Camera 05' : 'CCTV Camera',
    count: list.length,
    payrollImpact: 'none',
    payrollDeductionsEnabled: false,
    records: list
  };
};

/**
 * Resets worker service state (for unit test isolation).
 */
const resetWorkerService = () => {
  loadWorkersFromDisk();
  attendanceRecords = [];
  try {
    if (fs.existsSync(ATTENDANCE_FILE)) {
      fs.unlinkSync(ATTENDANCE_FILE);
    }
  } catch (_) {}
};

/**
 * Prepares a structured and formatted shareable attendance summary for group distribution.
 */
const generateShareableAttendanceSummary = ({ shopId = 'station', date = null } = {}) => {
  const normShop = (shopId || 'station').toLowerCase();
  if (!isAuthorizedShop(normShop)) {
    throw new Error(`Shop '${shopId}' is not an authorized shop`);
  }

  const targetDate = date || new Date().toISOString().split('T')[0];
  const list = attendanceRecords.filter((r) => r.shopId.toLowerCase() === normShop && r.date === targetDate);

  let pendingCount = 0;
  try {
    const detectionService = require('./detectionService');
    const pendingEvents = detectionService.listWorkerEvents({ shopId: normShop, reviewStatus: 'pending_review' });
    pendingCount = pendingEvents ? pendingEvents.length : 0;
  } catch (_) {}

  const shopName = normShop === 'station' ? 'STATION CYCLES' : normShop.toUpperCase();
  const cameraLabel = normShop === 'station' ? 'Station Cycles Camera 05 (Workshop Bay Channel 501)' : `${normShop.toUpperCase()} CCTV Camera`;

  const textLines = [
    `📋 ${shopName} — MORNING WORKER ARRIVAL REPORT`,
    `📅 Date: ${targetDate}`,
    `🏢 Camera: ${cameraLabel}`,
    `⏰ Generated: ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })} UK Time`,
    ``,
    `👥 CONFIRMED WORKER ARRIVALS (${list.length}):`
  ];

  if (list.length === 0) {
    textLines.push(`  (No worker arrivals confirmed yet for ${targetDate})`);
  } else {
    list.forEach((rec, idx) => {
      const arrTime = rec.firstSeenTime
        ? new Date(rec.firstSeenTime).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })
        : 'Recorded';
      const dwellMin = Math.round((rec.dwellTimeSeconds || 0) / 60);
      const dwellText = dwellMin > 0 ? `${dwellMin} min` : `${rec.dwellTimeSeconds || 0}s`;
      const flagText = rec.uncertainTimes ? ' [⚠️ Brief Presence]' : '';
      textLines.push(`${idx + 1}. ${rec.workerName} (${rec.workerId})`);
      textLines.push(`   • First Arrival: ${arrTime} UK Time`);
      textLines.push(`   • Dwell Duration: ${dwellText}${flagText}`);
      textLines.push(`   • Verified By: ${rec.confirmedBy}`);
      textLines.push(`   • Snapshot Event: ${rec.eventId}`);
    });
  }

  textLines.push(``);
  textLines.push(`⚠️ Pending Candidate Events: ${pendingCount}`);
  textLines.push(`🔒 Governance: payrollImpact: none (automated deductions disabled)`);

  const formattedText = textLines.join('\n');

  return {
    shopId: 'station',
    cameraLabel: 'Camera 05',
    date: targetDate,
    confirmedCount: list.length,
    pendingCount,
    formattedText,
    messagingIntegrationStatus: 'no_external_webhook_configured',
    workflowNotice: 'No third-party messaging webhooks (WhatsApp/Telegram/Slack) are configured. Use manual copy/download workflow.',
    records: list.map((r) => ({
      attendanceId: r.attendanceId,
      workerId: r.workerId,
      workerName: r.workerName,
      firstSeenUkTime: r.firstSeenTime
        ? new Date(r.firstSeenTime).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })
        : null,
      dwellMinutes: Math.round((r.dwellTimeSeconds || 0) / 60),
      uncertainTimes: r.uncertainTimes,
      snapshotEndpoint: `/api/workers/events/${r.eventId}/snapshot`
    }))
  };
};

module.exports = {
  listWorkers,
  getWorkerById,
  createWorker,
  updateWorker,
  deactivateWorker,
  linkEventToWorkerAttendance,
  unlinkEventFromAttendance,
  getWorkerAttendance,
  listAttendanceRecords,
  generateShareableAttendanceSummary,
  calculateLatenessLondon,
  resetWorkerService,
  DEFAULT_STATION_WORKERS
};
