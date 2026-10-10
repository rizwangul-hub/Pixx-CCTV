const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKERS_DIR = path.join(__dirname, '../../storage/workers');
const WORKERS_FILE = path.join(WORKERS_DIR, 'station_workers.json');
const ATTENDANCE_FILE = path.join(WORKERS_DIR, 'attendance_records.json');

// Default initial roster for Station Cycles workshop
const DEFAULT_STATION_WORKERS = [
  {
    workerId: 'worker_st_01',
    name: 'Dave Miller',
    role: 'Senior Mechanic',
    shopId: 'station',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  },
  {
    workerId: 'worker_st_02',
    name: 'Sarah Jenkins',
    role: 'Bicycle Technician',
    shopId: 'station',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  },
  {
    workerId: 'worker_st_03',
    name: 'Alex Rivera',
    role: 'Workshop Apprentice',
    shopId: 'station',
    active: true,
    createdAt: '2026-10-01T08:00:00.000Z'
  }
];

let workers = [];
let attendanceRecords = [];

const ensureStorageDir = () => {
  if (!fs.existsSync(WORKERS_DIR)) {
    fs.mkdirSync(WORKERS_DIR, { recursive: true });
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
  // Initialize defaults
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
 * List workers for Station Cycles.
 * Strictly limited to Station shop.
 */
const listWorkers = ({ shopId = 'station', activeOnly = false } = {}) => {
  if (shopId && shopId.toLowerCase() !== 'station') {
    throw new Error('Worker management is currently restricted to Station Cycles only');
  }

  let list = workers.filter((w) => w.shopId.toLowerCase() === 'station');
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
 * Create a new worker profile for Station Cycles.
 */
const createWorker = ({ name, role, shopId = 'station' }) => {
  if (!shopId || shopId.toLowerCase() !== 'station') {
    throw new Error('Worker management is currently restricted to Station Cycles only');
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Worker name is required');
  }
  if (!role || typeof role !== 'string' || !role.trim()) {
    throw new Error('Worker role is required');
  }

  const workerId = `worker_st_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  const newWorker = {
    workerId,
    name: name.trim(),
    role: role.trim(),
    shopId: 'station',
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
 * Links a manager-confirmed worker event to the worker's attendance record.
 * Evaluates uncertain entry/exit flags and guarantees zero automated payroll impact.
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

  // Determine uncertainty flags:
  // - single snapshot detection (cannot guarantee exact clock-in or sustained shift work)
  // - dwell duration < 60 seconds
  // - activity outside standard shift hours
  // - explicit manager override
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

  // Check if an attendance record for this event already exists
  let record = attendanceRecords.find((r) => r.eventId === workerEvent.eventId);

  if (record) {
    // Reassignment or update
    record.workerId = worker.workerId;
    record.workerName = worker.name;
    record.uncertainTimes = uncertainTimes;
    record.uncertaintyReasons = reasons;
    record.updatedAt = nowIso;
    record.updatedBy = managerId;
    record.reviewerNotes = workerEvent.reviewerNotes || null;
  } else {
    // Create new attendance record
    const attendanceId = `att_${worker.workerId}_${workerEvent.eventId}`;
    record = {
      attendanceId,
      workerId: worker.workerId,
      workerName: worker.name,
      shopId: 'station',
      cameraLabel: 'Camera 05',
      eventId: workerEvent.eventId,
      sessionId: workerEvent.sessionId || null,
      date: eventDate,
      timestamp: eventTime,
      firstSeenTime: options.firstSeenTime || eventTime,
      lastSeenTime: options.lastSeenTime || eventTime,
      dwellTimeSeconds: dwellSec,
      sampleCount,
      detectionConfidence: workerEvent.detectionConfidence || null,
      uncertainTimes,
      uncertaintyReasons: reasons,
      reviewStatus: 'confirmed_presence',
      payrollImpact: 'none', // Strictly guaranteed: payroll deductions disabled
      payrollDeductionsEnabled: false,
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

  return {
    workerId: worker.workerId,
    workerName: worker.name,
    role: worker.role,
    shopId: 'station',
    cameraLabel: 'Camera 05',
    totalConfirmedEvents: list.length,
    uncertainTimesEventsCount: uncertainCount,
    totalDwellMinutes: Math.round(totalDwellSec / 60),
    payrollImpact: 'none',
    payrollDeductionsEnabled: false,
    payrollNotice: 'Automated payroll deductions and salary adjustments are disabled. Attendance records require manual review.',
    attendanceRecords: list
  };
};

/**
 * List all attendance records for Station Cycles.
 */
const listAttendanceRecords = ({ shopId = 'station', date = null, workerId = null } = {}) => {
  if (shopId && shopId.toLowerCase() !== 'station') {
    throw new Error('Attendance records are currently restricted to Station Cycles only');
  }

  let list = [...attendanceRecords];
  if (date) {
    list = list.filter((r) => r.date === date);
  }
  if (workerId) {
    list = list.filter((r) => r.workerId === workerId);
  }

  return {
    shopId: 'station',
    cameraLabel: 'Camera 05',
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
  if (shopId && shopId.toLowerCase() !== 'station') {
    throw new Error('Attendance summary is currently restricted to Station Cycles only');
  }

  const targetDate = date || new Date().toISOString().split('T')[0];
  const list = attendanceRecords.filter((r) => r.date === targetDate);

  let pendingCount = 0;
  try {
    const detectionService = require('./detectionService');
    const pendingEvents = detectionService.listWorkerEvents({ reviewStatus: 'pending_review' });
    pendingCount = pendingEvents ? pendingEvents.length : 0;
  } catch (_) {}

  const textLines = [
    `📋 STATION CYCLES — MORNING WORKER ARRIVAL REPORT`,
    `📅 Date: ${targetDate}`,
    `🏢 Camera: Station Cycles Camera 05 (Workshop Bay Channel 501)`,
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
  resetWorkerService,
  DEFAULT_STATION_WORKERS
};
