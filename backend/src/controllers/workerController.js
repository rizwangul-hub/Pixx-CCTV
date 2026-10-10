const workerService = require('../services/workerService');

/**
 * Lists registered workers for Station Cycles.
 * Provides data for the manual worker selection dropdown in the review interface.
 */
const listWorkers = (req, res, next) => {
  try {
    const shopId = (req.query.shopId || 'station').toLowerCase();
    if (shopId !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Worker management is currently restricted to Station Cycles only'
      });
    }

    const activeOnly = req.query.activeOnly === 'true';
    const workers = workerService.listWorkers({ shopId, activeOnly });

    res.status(200).json({
      shopId: 'station',
      count: workers.length,
      workers
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Creates a new worker profile for Station Cycles workshop.
 */
const createWorker = (req, res, next) => {
  try {
    const { name, role, shopId = 'station' } = req.body || {};

    if (shopId && shopId.toLowerCase() !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Worker management is currently restricted to Station Cycles only'
      });
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: 'Worker name is required and must be non-empty string'
      });
    }

    if (!role || typeof role !== 'string' || !role.trim()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: 'Worker role is required and must be non-empty string'
      });
    }

    const worker = workerService.createWorker({ name, role, shopId: 'station' });

    res.status(201).json({
      message: 'Worker profile created successfully',
      worker
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieves a single worker profile.
 */
const getWorker = (req, res, next) => {
  try {
    const { workerId } = req.params;
    const worker = workerService.getWorkerById(workerId);
    if (!worker) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }
    res.status(200).json({ worker });
  } catch (error) {
    next(error);
  }
};

/**
 * Updates worker details (e.g. name, role, active status).
 */
const updateWorker = (req, res, next) => {
  try {
    const { workerId } = req.params;
    const updates = req.body || {};

    const updated = workerService.updateWorker(workerId, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    res.status(200).json({
      message: 'Worker profile updated successfully',
      worker: updated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Deactivates a worker.
 */
const deleteWorker = (req, res, next) => {
  try {
    const { workerId } = req.params;
    const deactivated = workerService.deactivateWorker(workerId);
    if (!deactivated) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    res.status(200).json({
      message: 'Worker deactivated successfully',
      worker: deactivated
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Retrieves attendance records for a specific worker.
 * Flagged uncertain entry/exit times and zero payroll deduction guaranteed.
 */
const getWorkerAttendance = (req, res, next) => {
  try {
    const { workerId } = req.params;
    const date = req.query.date || null;

    const result = workerService.getWorkerAttendance(workerId, { date });
    if (!result) {
      return res.status(404).json({ error: 'Worker profile not found' });
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Lists all attendance records for Station Cycles.
 */
const listAttendanceRecords = (req, res, next) => {
  try {
    const shopId = (req.query.shopId || 'station').toLowerCase();
    if (shopId !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Attendance records are currently restricted to Station Cycles only'
      });
    }

    const { date, workerId } = req.query;
    const result = workerService.listAttendanceRecords({ shopId, date, workerId });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Renders the interactive Station Cycles Manager Review Interface HTML.
 * Includes candidate review cards with worker dropdown, worker management table,
 * and attendance summary with uncertain time badges & disabled payroll notice.
 */
const renderReviewInterface = (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Station Cycles CCTV — Camera 05 Worker Detection & Review</title>
  <style>
    :root {
      --bg: #0b1120;
      --card-bg: #1e293b;
      --card-alt: #162032;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1280px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    h1 { font-size: 22px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .badge {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .badge-info { background: #1e3a8a; color: #93c5fd; }
    .badge-warning { background: #78350f; color: #fde68a; }
    .badge-success { background: #064e3b; color: #a7f3d0; }
    .badge-danger { background: #7f1d1d; color: #fecaca; }

    .banner-warning {
      background: #422006;
      border: 1px solid #b45309;
      color: #fef3c7;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 20px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .auth-bar {
      background: #1e293b;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      border: 1px solid var(--border);
    }

    .tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tab-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 960px) { .grid-2 { grid-template-columns: 1fr; } }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card h2 { font-size: 16px; margin-bottom: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }

    /* Snapshot Panel */
    .snapshot-frame {
      background: #000;
      border-radius: 6px;
      overflow: hidden;
      min-height: 260px;
      position: relative;
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .snapshot-frame img { width: 100%; height: auto; display: block; object-fit: contain; }
    .snapshot-meta-strip {
      background: #111827;
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 6px 6px;
      padding: 10px 14px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      color: var(--text-muted);
      flex-wrap: wrap;
      gap: 8px;
    }
    .panel-actions {
      display: flex;
      gap: 10px;
      margin-top: 14px;
      flex-wrap: wrap;
    }

    /* Detection Result Box */
    .detection-result-box {
      background: #111827;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-top: 14px;
      font-size: 13px;
    }

    /* Candidate Cards */
    .candidate-card {
      background: #111827;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
      transition: border-color 0.15s ease;
    }
    .candidate-card:hover { border-color: #475569; }
    .candidate-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #1f2937;
      font-size: 13px;
    }
    .candidate-body {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 16px;
      align-items: flex-start;
    }
    @media (max-width: 600px) { .candidate-body { grid-template-columns: 1fr; } }
    .candidate-thumb-wrap {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      min-height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .candidate-thumb-wrap img { width: 100%; height: auto; display: block; }
    .candidate-details { font-size: 13px; }
    .candidate-details p { margin-bottom: 6px; }

    .review-action-strip {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid #1f2937;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    select, input[type="text"], input[type="password"] {
      background: #0f172a;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
    }
    select:focus, input[type="text"]:focus, input[type="password"]:focus { outline: none; border-color: var(--primary); }

    .btn {
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: background 0.15s ease;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
    .btn-success { background: var(--success); color: white; }
    .btn-success:hover:not(:disabled) { background: #059669; }
    .btn-secondary { background: #374151; color: var(--text); }
    .btn-secondary:hover:not(:disabled) { background: #4b5563; }
    .btn-danger { background: var(--danger); color: white; }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-weight: 600; background: #111827; }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>
          Station Cycles CCTV &bull; Camera 05 Review & Assignment
          <span class="badge badge-info">Pilot Mode</span>
          <span class="badge badge-warning">Active Threshold 0.40</span>
        </h1>
        <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">
          Hikvision DS-7208HUHI-K1 (ISAPI Channel 501) &bull; Workshop Bay &bull; Manual Worker Assignment Only
        </p>
      </div>
      <div>
        <span class="badge badge-success">&#10003; 16 Workers Registered</span>
      </div>
    </header>

    <div class="banner-warning">
      <span style="font-size: 18px;">&#9888;</span>
      <div>
        <strong>Governance & Privacy Guardrail:</strong>
        No automated identity guessing. Detection qualifies candidates, but human manager must manually select technician name.
        Automated salary and payroll deductions are strictly disabled (<code style="background:#261303;padding:2px 4px;border-radius:3px;">payrollImpact: none</code>).
      </div>
    </div>

    <!-- Admin Authentication Bar -->
    <div class="auth-bar">
      <span>Administrator API Key:</span>
      <input type="password" id="api-key-input" placeholder="Enter x-admin-api-key" style="width: 280px;">
      <button class="btn btn-secondary" onclick="saveApiKey()">Save Key</button>
      <span id="auth-status" style="margin-left: auto; color: var(--text-muted);">Checking key...</span>
    </div>

    <!-- Navigation Tabs -->
    <div class="tabs">
      <button class="tab-btn active" onclick="showTab('detection', this)">Camera & Detection</button>
      <button class="tab-btn" onclick="showTab('review', this)">Candidate Events & Assign Worker (<span id="tab-pending-count">0</span>)</button>
      <button class="tab-btn" onclick="showTab('attendance', this)">Worker Attendance Records</button>
      <button class="tab-btn" onclick="showTab('workers', this)">Worker Management</button>
    </div>

    <!-- TAB 1: CAMERA SNAPSHOT & DETECTION PANEL -->
    <div id="tab-detection" class="tab-content">
      <div class="grid-2">
        <div>
          <div class="card">
            <h2>
              Camera 05 Workshop Bay Snapshot
              <span class="badge badge-info">Still Snapshot</span>
            </h2>
            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
              Static snapshot captured via ISAPI (Channel 501). Periodic capture, not a live streaming RTSP feed.
            </p>
            <div class="snapshot-frame">
              <img id="roi-image" alt="Camera 05 Workshop Bay Snapshot">
            </div>
            <div class="snapshot-meta-strip">
              <span id="snapshot-timestamp">Captured: Loading...</span>
              <span id="snapshot-resolution">Resolution: 704 &times; 576 (4CIF)</span>
              <span>Bay ROI: Calibrated Polygon</span>
            </div>
            <div class="panel-actions">
              <button id="btn-refresh-snapshot" class="btn btn-secondary" onclick="refreshCameraSnapshot()">
                <span>&#8635;</span> Refresh Snapshot
              </button>
              <button id="btn-detect-person" class="btn btn-primary" onclick="runPersonDetection()">
                <span>&#128065;</span> Detect Person (AI Inference)
              </button>
            </div>
            <div id="snapshot-status-msg" style="margin-top: 10px; font-size: 12px; color: var(--text-muted);"></div>
          </div>
        </div>

        <div>
          <div class="card">
            <h2>AI Detection Live Output</h2>
            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
              Evaluates YOLOv8n inference on Camera 05 snapshot and filters person detections inside the workshop bay.
            </p>
            <div id="detection-result-box" class="detection-result-box">
              <p style="color: var(--text-muted);">No detection run yet. Click <strong>"Detect Person"</strong> to trigger live snapshot inference.</p>
            </div>
            <div style="margin-top: 16px; font-size: 12px; color: var(--text-muted); line-height: 1.6;">
              <p><strong>Detection Pipeline Steps:</strong></p>
              <ol style="margin-left: 20px; margin-top: 6px;">
                <li>Captures authentic 4CIF still from Station recorder (Channel 501).</li>
                <li>Letterboxes image to 640&times;640 and runs YOLOv8n person detection (confidence &ge; 0.40).</li>
                <li>Applies point-in-polygon ROI test against the calibrated workshop bay.</li>
                <li>Spatial tracking merges consecutive detections into presence sessions.</li>
                <li>Creates pending candidate event for manager verification.</li>
              </ol>
            </div>
          </div>

          <div class="card" style="margin-top: 16px;">
            <h2>
              <span>Automatic Morning Arrival Scheduler</span>
              <span id="scheduler-badge" class="badge badge-info">Checking...</span>
            </h2>
            <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
              Automatically polls Camera 05 every 20 seconds during Station shift hours (Mon–Sat, 08:30–18:00 UK civil time). Captures an authentic arrival photo on new entry into the workshop bay without saving redundant polling photos.
            </p>
            <div id="scheduler-info-strip" style="background: #111827; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 13px; line-height: 1.6; margin-bottom: 12px;">
              Loading scheduler telemetry...
            </div>
            <div class="panel-actions">
              <button id="btn-trigger-cycle" class="btn btn-secondary" onclick="triggerSchedulerCycle()">
                <span>&#9654;</span> Test Auto-Cycle (Run Now)
              </button>
              <button id="btn-refresh-scheduler" class="btn btn-secondary" onclick="loadSchedulerStatus()">
                <span>&#8635;</span> Refresh Telemetry
              </button>
            </div>
            <div id="scheduler-status-msg" style="margin-top: 8px; font-size: 12px; color: var(--text-muted);"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: CANDIDATE EVENTS REVIEW -->
    <div id="tab-review" class="tab-content" style="display: none;">
      <div class="card">
        <h2>
          Pending Candidate Events & Assign Worker (<span id="pending-count">0</span>)
          <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="loadEvents()">Refresh Queue</button>
        </h2>
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px;">
          Review detected persons in the workshop bay. Visually verify the candidate, then Assign Worker using the dropdown. Unassigned events remain pending.
        </p>
        <div id="events-container">
          <p style="color: var(--text-muted); font-size: 13px;">Loading candidate events...</p>
        </div>
      </div>
    </div>

    <!-- TAB 3: ATTENDANCE RECORDS -->
    <div id="tab-attendance" class="tab-content" style="display: none;">
      <div class="card">
        <h2>
          <span>Station Cycles Workshop Attendance &bull; Manual Review Verified</span>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" style="padding: 4px 12px; font-size: 12px;" onclick="openShareSummaryModal()">
              <span>📋</span> Share Attendance Summary
            </button>
            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 12px;" onclick="loadAttendance()">Refresh Attendance</button>
          </div>
        </h2>
        <div style="margin-bottom: 16px; font-size: 12px; color: var(--text-muted); line-height: 1.6;">
          Attendance records linked to approved candidate events. Observed arrival and estimated departure times are recorded separately. Brief dwell durations (&lt; 60s) or single snapshots are flagged with uncertainty warnings. Automated payroll deductions are disabled (<code style="background:#111827;padding:2px 4px;border-radius:3px;">payrollImpact: none</code>).
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Attendance ID</th>
                <th>Worker Name</th>
                <th>Observed Snapshot Time</th>
                <th>Estimated Exit</th>
                <th>Dwell Time</th>
                <th>Uncertainty Status</th>
                <th>Review Status</th>
                <th>Payroll Impact</th>
                <th>Arrival Photo</th>
                <th>Confirmed By</th>
              </tr>
            </thead>
            <tbody id="attendance-table-body">
              <tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Loading attendance records...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 4: WORKSHOP ROSTER -->
    <div id="tab-workers" class="tab-content" style="display: none;">
      <div class="grid-2">
        <div>
          <div class="card">
            <h2>Worker Management & Workshop Roster</h2>
            <table>
              <thead>
                <tr>
                  <th>Worker ID</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="workers-table-body">
                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Loading roster...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="card">
            <h2>Add New Worker</h2>
            <form onsubmit="addWorkerSubmit(event)">
              <div style="margin-bottom: 12px;">
                <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-muted);">Worker Full Name</label>
                <input type="text" id="new-worker-name" placeholder="e.g. Marcus Vance" style="width: 100%;" required>
              </div>
              <div style="margin-bottom: 16px;">
                <label style="display: block; font-size: 12px; margin-bottom: 4px; color: var(--text-muted);">Workshop Role</label>
                <input type="text" id="new-worker-role" placeholder="e.g. Wheel Builder" style="width: 100%;" required>
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%;">Add Worker to Station Roster</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  <!-- SHARE ATTENDANCE SUMMARY MODAL -->
  <div id="share-modal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.75); z-index: 9999; align-items: center; justify-content: center;">
    <div style="background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; width: 90%; max-width: 680px; padding: 24px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="font-size: 16px;">📋 Shareable Attendance Summary (WhatsApp / Group)</h3>
        <button class="btn btn-secondary" style="padding: 4px 8px;" onclick="closeShareModal()">&times;</button>
      </div>
      <div style="background: #111827; border: 1px solid var(--border); border-radius: 4px; padding: 10px; font-size: 12px; color: #94a3b8; margin-bottom: 12px;">
        ℹ️ <strong>Workflow Notice:</strong> No third-party messaging webhook (WhatsApp Business / Telegram Bot) is configured in <code>.env</code>. Use the copy-to-clipboard action below to paste the formatted arrival summary directly into your team group.
      </div>
      <textarea id="share-text-area" rows="12" style="width: 100%; font-family: monospace; font-size: 12px; background: #0b1120; border: 1px solid var(--border); color: #f8fafc; padding: 12px; border-radius: 6px; resize: vertical;" readonly></textarea>
      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;">
        <button class="btn btn-secondary" onclick="closeShareModal()">Close</button>
        <button id="btn-copy-share" class="btn btn-primary" onclick="copyShareText()">Copy to Clipboard</button>
      </div>
    </div>
  </div>

  <script>
    let activeWorkers = [];
    let isDetecting = false;
    let isRefreshingSnapshot = false;

    function getApiKey() {
      const params = new URLSearchParams(window.location.search);
      const urlKey = params.get('key') || params.get('apiKey');
      if (urlKey) {
        sessionStorage.setItem('pixx_admin_key', urlKey);
        return urlKey;
      }
      return sessionStorage.getItem('pixx_admin_key') || '';
    }

    function saveApiKey() {
      const key = document.getElementById('api-key-input').value.trim();
      if (key) {
        sessionStorage.setItem('pixx_admin_key', key);
        document.getElementById('auth-status').textContent = 'Key Loaded';
        document.getElementById('auth-status').style.color = '#10b981';
        loadAll();
      }
    }

    function getHeaders() {
      const key = getApiKey();
      return {
        'x-admin-api-key': key,
        'Content-Type': 'application/json'
      };
    }

    function showTab(tab, btn) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      const target = document.getElementById('tab-' + tab);
      if (target) target.style.display = 'block';
      if (btn) btn.classList.add('active');

      if (tab === 'attendance') {
        loadAttendance();
      } else if (tab === 'workers') {
        loadWorkers();
      } else if (tab === 'review') {
        loadEvents();
      } else if (tab === 'detection') {
        loadRoiImage();
        loadSchedulerStatus();
      }
    }

    async function loadRoiImage() {
      const img = document.getElementById('roi-image');
      const timeElem = document.getElementById('snapshot-timestamp');
      if (!img) return;

      try {
        const res = await fetch('/api/cameras/station/roi-overlay', { headers: getHeaders() });
        if (res.status === 401) {
          img.alt = 'Authentication required. Enter Admin API Key above.';
          if (timeElem) timeElem.textContent = 'Auth required';
          return;
        }
        if (!res.ok) {
          img.alt = 'No snapshot available';
          if (timeElem) timeElem.textContent = 'No snapshot';
          return;
        }
        const blob = await res.blob();
        img.src = URL.createObjectURL(blob);
        img.alt = 'Station Camera 05 Workshop Bay Overlay';
        if (timeElem) {
          timeElem.textContent = 'Last Updated: ' + new Date().toLocaleTimeString() + ' (' + new Date().toLocaleDateString() + ')';
        }
      } catch (err) {
        img.alt = 'Could not load camera overlay: ' + err.message;
      }
    }

    async function refreshCameraSnapshot() {
      if (isRefreshingSnapshot) return;
      isRefreshingSnapshot = true;
      const btn = document.getElementById('btn-refresh-snapshot');
      const statusMsg = document.getElementById('snapshot-status-msg');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Capturing Snapshot...';
      }
      if (statusMsg) statusMsg.textContent = 'Requesting fresh frame from Camera 05...';

      try {
        const res = await fetch('/api/cameras/station/snapshot', {
          method: 'POST',
          headers: getHeaders()
        });

        if (res.status === 401) {
          if (statusMsg) statusMsg.textContent = 'Authentication required. Enter Admin API Key.';
          return;
        }

        const data = await res.json();
        if (res.ok && data.event) {
          if (statusMsg) statusMsg.textContent = 'Snapshot captured: ' + data.event.snapshotRef + ' (' + data.event.fileSizeBytes + ' bytes)';
        } else {
          if (statusMsg) statusMsg.textContent = data.details || data.message || 'Snapshot refreshed';
        }

        await loadRoiImage();
      } catch (err) {
        if (statusMsg) statusMsg.textContent = 'Snapshot error: ' + err.message;
      } finally {
        isRefreshingSnapshot = false;
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span>&#8635;</span> Refresh Snapshot';
        }
      }
    }

    async function runPersonDetection() {
      if (isDetecting) return;
      isDetecting = true;
      const btn = document.getElementById('btn-detect-person');
      const resultBox = document.getElementById('detection-result-box');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Running YOLOv8n Detection...';
      }
      if (resultBox) {
        resultBox.innerHTML = '<p style="color: var(--text-muted);"><span class="spinner"></span> Running CPU inference on latest snapshot...</p>';
      }

      try {
        const res = await fetch('/api/cameras/station/detect-workers', {
          method: 'POST',
          headers: getHeaders()
        });

        if (res.status === 401) {
          if (resultBox) {
            resultBox.innerHTML = '<p style="color: var(--danger);">&#9888; Authentication failed. Please enter a valid Admin API Key above.</p>';
          }
          return;
        }

        const data = await res.json();
        if (!res.ok) {
          if (resultBox) {
            resultBox.innerHTML = '<p style="color: var(--danger);">&#9888; Detection Error: ' + (data.error || 'Failed to run detection') + '</p>';
          }
          return;
        }

        // Render result clearly
        const detectedCount = data.personsDetected || 0;
        const latency = data.inferenceMs || 0;
        const detections = data.detections || [];
        const maxConf = detections.length > 0 ? Math.max(...detections.map(d => d.confidence)) : 0;
        const eventsCreated = data.events ? data.events.filter(e => e.type === 'new_candidate_detected').length : 0;

        let resultHtml = \`
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="font-size: 14px; color: \${detectedCount > 0 ? '#10b981' : '#94a3b8'};">
              \${detectedCount > 0 ? '&#10003; ' + detectedCount + ' Person(s) Detected' : '0 Persons Detected in Workshop Bay'}
            </strong>
            <span class="badge badge-info">\${latency} ms Inference</span>
          </div>
          <p style="margin-bottom: 4px; color: var(--text-muted);">
            <strong>Snapshot Reference:</strong> <code>\${data.snapshotRef || 'live'}</code> &bull; 
            <strong>Confidence:</strong> \${detectedCount > 0 ? (maxConf * 100).toFixed(1) + '%' : 'N/A'}
          </p>
        \`;

        if (detectedCount === 0) {
          resultHtml += '<p style="color: var(--text-muted); font-size: 12px; margin-top: 6px;">Area clear or worker outside calibrated workshop polygon. Zero candidates queued.</p>';
        } else {
          resultHtml += \`
            <p style="color: #a7f3d0; font-size: 12px; margin-top: 6px;">
              &#10003; \${eventsCreated} new candidate event(s) logged in <strong>"Candidate Events Review"</strong> tab awaiting manager approval.
            </p>
          \`;
        }

        if (resultBox) resultBox.innerHTML = resultHtml;

        // Auto refresh candidate list and ROI image
        await loadRoiImage();
        await loadEvents();
      } catch (err) {
        if (resultBox) {
          resultBox.innerHTML = '<p style="color: var(--danger);">&#9888; Network / Execution Error: ' + err.message + '</p>';
        }
      } finally {
        isDetecting = false;
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span>&#128065;</span> Detect Person (AI Inference)';
        }
      }
    }

    async function loadWorkers() {
      const tbody = document.getElementById('workers-table-body');
      try {
        const res = await fetch('/api/workers?shopId=station', { headers: getHeaders() });
        if (res.status === 401) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ef4444;">&#9888; Authentication required. Enter Administrator API Key above.</td></tr>';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        activeWorkers = data.workers || [];

        if (activeWorkers.length === 0) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No workers found</td></tr>';
          return;
        }

        if (tbody) tbody.innerHTML = activeWorkers.map(w => \`
          <tr>
            <td><code>\${w.workerId}</code></td>
            <td><strong>\${w.name}</strong></td>
            <td>\${w.role}</td>
            <td>
              <span class="badge \${w.active ? 'badge-success' : 'badge-danger'}">
                \${w.active ? 'Active' : 'Inactive'}
              </span>
            </td>
            <td>
              <button class="btn btn-secondary" style="padding: 3px 8px; font-size: 11px;" onclick="toggleWorkerActive('\${w.workerId}', \${!w.active})">
                \${w.active ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        \`).join('');
      } catch (err) {
        console.error('Failed to load workers:', err);
      }
    }

    async function loadEvents() {
      const container = document.getElementById('events-container');
      const pendingCount = document.getElementById('pending-count');
      const tabPendingCount = document.getElementById('tab-pending-count');
      try {
        const res = await fetch('/api/workers/events?status=pending_review', { headers: getHeaders() });
        if (res.status === 401) {
          if (container) container.innerHTML = '<p style="color: #ef4444;">&#9888; Authentication required. Enter Administrator API Key above.</p>';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        const events = data.events || [];
        if (pendingCount) pendingCount.textContent = events.length;
        if (tabPendingCount) tabPendingCount.textContent = events.length;

        if (events.length === 0) {
          if (container) {
            container.innerHTML = \`
              <div style="background: #111827; border: 1px dashed var(--border); border-radius: 6px; padding: 24px; text-align: center; color: var(--text-muted);">
                <p style="font-size: 14px; font-weight: 600; margin-bottom: 4px;">No Pending Candidate Events</p>
                <p style="font-size: 12px;">Candidate events appear automatically when motion or presence is detected in Station Camera 05 workshop bay. You can trigger live inference via the "Camera & Detection" tab.</p>
              </div>
            \`;
          }
          return;
        }

        // Fetch active workers for dropdown
        const activeRes = await fetch('/api/workers?shopId=station&activeOnly=true', { headers: getHeaders() });
        if (activeRes.ok) {
          const actData = await activeRes.json();
          activeWorkers = actData.workers || [];
        }

        const workerOptions = activeWorkers
          .filter(w => w.active)
          .map(w => \`<option value="\${w.workerId}">\${w.name} (\${w.role})</option>\`)
          .join('');

        if (container) {
          container.innerHTML = events.map(ev => {
            const confPercent = (ev.detectionConfidence * 100).toFixed(1);
            const boxStr = ev.box ? \`[x: \${ev.box[0]}, y: \${ev.box[1]}, w: \${ev.box[2]}, h: \${ev.box[3]}]\` : 'N/A';
            const eventDate = new Date(ev.timestamp);

            const ukTimeFormatted = new Intl.DateTimeFormat('en-GB', {
              timeZone: 'Europe/London',
              dateStyle: 'medium',
              timeStyle: 'medium'
            }).format(eventDate) + ' (UK Time)';

            return \`
              <div class="candidate-card" id="event-\${ev.eventId}">
                <div class="candidate-header">
                  <div>
                    <strong>Arrival Event:</strong> <code>\${ev.eventId}</code> &bull; 
                    <strong>Session:</strong> <code>\${ev.sessionId}</code>
                  </div>
                  <div>
                    <span class="badge badge-warning">Pending Review</span>
                    <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">
                      🕒 \${ukTimeFormatted}
                    </span>
                  </div>
                </div>
                <div class="candidate-body">
                  <div>
                    <div class="candidate-thumb-wrap">
                      <img id="thumb-\${ev.eventId}" alt="Arrival Snapshot" src="" onerror="this.alt='Snapshot thumbnail'">
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted); text-align: center; margin-top: 4px;">
                      Arrival Photo: <code>\${ev.snapshotRef || 'Camera 05'}</code>
                    </div>
                  </div>
                  <div class="candidate-details">
                    <p><strong>Candidate Role:</strong> \${ev.qualificationCriteria?.candidateRole || 'candidate_worker'}</p>
                    <p>
                      <strong>Detection Confidence:</strong> <span class="badge badge-info">\${confPercent}%</span> &bull; 
                      <strong>Bounding Box:</strong> <code>\${boxStr}</code>
                    </p>
                    <p>
                      <strong>Spatial Bay Match:</strong> \${ev.qualificationCriteria?.inWorkshopBay ? '<span style=\"color:#10b981;\">&#10003; Inside Workshop Bay</span>' : '<span style=\"color:#f59e0b;\">&#9888; Outside Bay</span>'} &bull; 
                      <strong>Shift Hours:</strong> \${ev.qualificationCriteria?.withinShiftHours ? '<span style=\"color:#10b981;\">&#10003; Standard Hours (08:30-18:00)</span>' : '<span style=\"color:#f59e0b;\">&#9888; Outside Shift Hours</span>'}
                    </p>
                    <div class="review-action-strip">
                      <label style="font-size: 12px; font-weight: 600; color: var(--text-muted);">Assign Worker:</label>
                      <select id="worker-select-\${ev.eventId}" style="min-width: 220px;">
                        <option value="">-- Select Worker from Roster --</option>
                        \${workerOptions}
                      </select>
                      <input type="text" id="notes-\${ev.eventId}" placeholder="Reviewer notes (optional)" style="flex: 1; min-width: 160px;">
                      <button class="btn btn-success" onclick="verifyEvent('\${ev.eventId}', 'approve_worker')">&#10003; Confirm & Approve</button>
                      <button class="btn btn-secondary" onclick="shareCandidateSnippet('\${ev.eventId}', '\${ukTimeFormatted}', '\${confPercent}', '\${ev.qualificationCriteria?.candidateRole || 'candidate_worker'}')">📋 Share Snippet</button>
                      <button class="btn btn-secondary" onclick="verifyEvent('\${ev.eventId}', 'dismiss_customer')">Dismiss Customer</button>
                      <button class="btn btn-secondary" onclick="verifyEvent('\${ev.eventId}', 'dismiss_passerby')">Dismiss Passerby</button>
                      <button class="btn btn-secondary" onclick="verifyEvent('\${ev.eventId}', 'flag_inquiry')">Flag Inquiry</button>
                    </div>
                  </div>
                </div>
              </div>
            \`;
          }).join('');

          // Load authenticated thumbnail blobs for each candidate card
          events.forEach(async (ev) => {
            const thumbImg = document.getElementById('thumb-' + ev.eventId);
            if (!thumbImg) return;
            try {
              const snapRes = await fetch(\`/api/workers/events/\${ev.eventId}/snapshot\`, { headers: getHeaders() });
              if (snapRes.ok) {
                const blob = await snapRes.blob();
                thumbImg.src = URL.createObjectURL(blob);
              } else {
                // Fallback to general ROI overlay
                thumbImg.src = '/api/cameras/station/roi-overlay';
              }
            } catch (_) {}
          });
        }
      } catch (err) {
        console.error('Failed to load events:', err);
      }
    }

    async function loadAttendance() {
      const tbody = document.getElementById('attendance-table-body');
      try {
        const res = await fetch('/api/workers/attendance?shopId=station', { headers: getHeaders() });
        if (res.status === 401) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: #ef4444; padding: 20px;">&#9888; Authentication required. Enter Administrator API Key above.</td></tr>';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        const records = data.records || [];

        if (records.length === 0) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">No attendance records found yet.<br><span style="font-size: 12px; color: #64748b;">Attendance records are created when candidate events in the "Candidate Events Review" tab are approved with an assigned worker.</span></td></tr>';
          return;
        }

        if (tbody) tbody.innerHTML = records.map(r => {
          const arrUkTime = r.firstSeenTime
            ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(r.firstSeenTime)) + ' BST/GMT (' + r.date + ')'
            : r.date;
          const exitUkTime = r.lastSeenTime
            ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(r.lastSeenTime))
            : 'Active';

          return `
            <tr>
              <td><code>${r.attendanceId}</code></td>
              <td><strong>${r.workerName}</strong> (<code>${r.workerId}</code>)</td>
              <td>${arrUkTime}</td>
              <td>${exitUkTime}</td>
              <td>${r.dwellTimeSeconds}s</td>
              <td>
                ${r.uncertainTimes
                  ? '<span class="badge badge-warning" title="' + (r.uncertaintyReasons || []).join(', ') + '">&#9888; Uncertain Boundary</span>'
                  : '<span class="badge badge-success">&#10003; Confirmed Sustained</span>'}
              </td>
              <td><span class="badge badge-success">${r.reviewStatus}</span></td>
              <td><span class="badge badge-info">none</span></td>
              <td>
                <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px;" onclick="downloadArrivalPhoto('${r.eventId}')">
                  📸 Download Photo
                </button>
              </td>
              <td>${r.confirmedBy}</td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        console.error('Failed to load attendance:', err);
      }
    }

    async function verifyEvent(eventId, action) {
      const workerSelect = document.getElementById('worker-select-' + eventId);
      const notesInput = document.getElementById('notes-' + eventId);
      const workerId = workerSelect ? workerSelect.value : null;
      const notes = notesInput ? notesInput.value.trim() : null;

      if (action === 'approve_worker' && !workerId) {
        alert('Please select a technician name from the dropdown before approving.');
        return;
      }

      try {
        const res = await fetch(\`/api/workers/events/\${eventId}/verify\`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ action, workerId, notes })
        });

        if (!res.ok) {
          const err = await res.json();
          alert('Error: ' + (err.error || 'Review submission failed'));
          return;
        }

        // Refresh both queues immediately
        await loadEvents();
        await loadAttendance();
      } catch (err) {
        alert('Request failed: ' + err.message);
      }
    }

    async function addWorkerSubmit(e) {
      e.preventDefault();
      const name = document.getElementById('new-worker-name').value.trim();
      const role = document.getElementById('new-worker-role').value.trim();

      try {
        const res = await fetch('/api/workers', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ name, role, shopId: 'station' })
        });

        if (!res.ok) {
          const err = await res.json();
          alert('Error: ' + (err.error || 'Failed to create worker'));
          return;
        }

        document.getElementById('new-worker-name').value = '';
        document.getElementById('new-worker-role').value = '';
        loadWorkers();
        loadEvents();
      } catch (err) {
        alert('Request failed: ' + err.message);
      }
    }

    async function toggleWorkerActive(workerId, active) {
      try {
        const res = await fetch(\`/api/workers/\${workerId}\`, {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ active })
        });
        if (res.ok) {
          loadWorkers();
          loadEvents();
        }
      } catch (err) {
        alert('Failed to update worker status: ' + err.message);
      }
    }

    async function loadSchedulerStatus() {
      const badge = document.getElementById('scheduler-badge');
      const strip = document.getElementById('scheduler-info-strip');
      if (!badge || !strip) return;

      try {
        const res = await fetch('/api/cameras/station/scheduler-status', { headers: getHeaders() });
        if (res.status === 401) {
          badge.textContent = 'Auth required';
          badge.className = 'badge badge-warning';
          strip.textContent = 'Enter Administrator API Key above to view scheduler status.';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();

        badge.textContent = data.running ? '● Running (20s)' : 'Paused';
        badge.className = data.running ? 'badge badge-success' : 'badge badge-warning';

        strip.innerHTML = `
          <div><strong>London Civil Time:</strong> ${data.londonCivilTime} (Shift: ${data.withinShiftHours ? '<span style="color:#10b981;">Open 08:30–18:00</span>' : '<span style="color:#f59e0b;">Closed</span>'})</div>
          <div><strong>Channel:</strong> ${data.channel} &bull; <strong>Confidence Threshold:</strong> ${data.confidenceThreshold}</div>
          <div><strong>Cycles Executed:</strong> ${data.totalCycles} &bull; <strong>Successful:</strong> ${data.successfulCycles} &bull; <strong>Failures:</strong> ${data.failedCycles} (${data.consecutiveFailures} consecutive)</div>
          <div><strong>New Arrivals Captured:</strong> <span style="color:#10b981;font-weight:600;">${data.arrivalsDetectedCount}</span> &bull; <strong>Last Status:</strong> <code>${data.lastStatus}</code></div>
          ${data.lastError ? '<div style="color:#ef4444;margin-top:4px;"><strong>Last Error:</strong> ' + data.lastError + '</div>' : ''}
        `;
      } catch (err) {
        if (strip) strip.textContent = 'Failed to load scheduler telemetry: ' + err.message;
      }
    }

    async function triggerSchedulerCycle() {
      const btn = document.getElementById('btn-trigger-cycle');
      const statusMsg = document.getElementById('scheduler-status-msg');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Running Cycle...';
      }
      if (statusMsg) statusMsg.textContent = 'Executing detection cycle on Camera 05...';

      try {
        const res = await fetch('/api/cameras/station/scheduler/trigger', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ forceRun: true })
        });
        const data = await res.json();
        if (statusMsg) {
          if (res.ok && data.result) {
            statusMsg.textContent = 'Cycle completed: ' + data.result.status + ' (' + (data.result.londonTime || '') + ')';
          } else {
            statusMsg.textContent = data.error || 'Cycle execution failed';
          }
        }
        await loadSchedulerStatus();
        await loadRoiImage();
        await loadEvents();
      } catch (err) {
        if (statusMsg) statusMsg.textContent = 'Error triggering cycle: ' + err.message;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span>&#9654;</span> Test Auto-Cycle (Run Now)';
        }
      }
    }

    async function openShareSummaryModal() {
      const modal = document.getElementById('share-modal');
      const textArea = document.getElementById('share-text-area');
      if (!modal || !textArea) return;

      modal.style.display = 'flex';
      textArea.value = 'Loading attendance summary for sharing...';

      try {
        const res = await fetch('/api/workers/attendance/share-summary?shopId=station', { headers: getHeaders() });
        if (res.status === 401) {
          textArea.value = 'Authentication required. Please enter a valid Administrator API Key above.';
          return;
        }
        if (!res.ok) {
          textArea.value = 'Failed to generate attendance summary from server.';
          return;
        }
        const data = await res.json();
        textArea.value = data.formattedText || 'No attendance records confirmed yet.';
      } catch (err) {
        textArea.value = 'Error fetching share summary: ' + err.message;
      }
    }

    function closeShareModal() {
      const modal = document.getElementById('share-modal');
      if (modal) modal.style.display = 'none';
    }

    function copyShareText() {
      const textArea = document.getElementById('share-text-area');
      const btn = document.getElementById('btn-copy-share');
      if (!textArea) return;

      textArea.select();
      navigator.clipboard.writeText(textArea.value).then(() => {
        if (btn) {
          const originalText = btn.textContent;
          btn.textContent = '✓ Copied to Clipboard!';
          setTimeout(() => { btn.textContent = originalText; }, 2000);
        }
      }).catch(() => {
        alert('Copied using selection fallback.');
      });
    }

    async function downloadArrivalPhoto(eventId) {
      try {
        const res = await fetch(`/api/workers/events/${eventId}/snapshot`, { headers: getHeaders() });
        if (!res.ok) {
          alert('Could not download snapshot: HTTP ' + res.status);
          return;
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${eventId}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch (err) {
        alert('Download error: ' + err.message);
      }
    }

    function shareCandidateSnippet(eventId, ukTimeStr, confPercent, role) {
      const snippet = `📸 Station Cycles Camera 05 — Arrival Candidate\nEvent: ${eventId}\nTime: ${ukTimeStr}\nRole: ${role}\nConfidence: ${confPercent}%\nStatus: Pending Manager Verification`;
      navigator.clipboard.writeText(snippet).then(() => {
        alert('Candidate arrival snippet copied to clipboard!\n\n' + snippet);
      }).catch(() => {
        alert('Snippet:\n\n' + snippet);
      });
    }

    function loadAll() {
      loadRoiImage();
      loadSchedulerStatus();
      loadWorkers().then(loadEvents);
      loadAttendance();
    }

    window.addEventListener('DOMContentLoaded', () => {
      const key = getApiKey();
      if (key) {
        const input = document.getElementById('api-key-input');
        if (input) input.value = key;
        const status = document.getElementById('auth-status');
        if (status) {
          status.textContent = 'Key Loaded';
          status.style.color = '#10b981';
        }
      } else {
        const status = document.getElementById('auth-status');
        if (status) {
          status.textContent = 'Key required — enter admin key';
          status.style.color = '#f59e0b';
        }
      }
      loadAll();
    });
  </script>
</body>
</html>`;

  res.send(html);
};

/**
 * Prepares shareable attendance summary for group distribution (manual share workflow).
 */
const getAttendanceShareSummary = (req, res, next) => {
  try {
    const shopId = (req.query.shopId || 'station').toLowerCase();
    if (shopId !== 'station') {
      return res.status(400).json({
        error: 'Unsupported shop',
        details: 'Attendance summary is currently restricted to Station Cycles only'
      });
    }

    const { date } = req.query;
    const summary = workerService.generateShareableAttendanceSummary({ shopId, date });
    res.status(200).json(summary);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listWorkers,
  createWorker,
  getWorker,
  updateWorker,
  deleteWorker,
  getWorkerAttendance,
  listAttendanceRecords,
  renderReviewInterface,
  getAttendanceShareSummary
};
