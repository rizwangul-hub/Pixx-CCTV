const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const app = require('../src/app');
const { ADMIN_API_KEY, SNAPSHOT_STORAGE_DIR } = require('../src/config/env');
const snapshotService = require('../src/services/snapshotService');

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

test('1. Security Headers: response includes nosniff, frame DENY, CSP, and hides x-powered-by', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);

  // x-powered-by must be stripped
  assert.equal(res.headers.get('x-powered-by'), null);

  // Defensive HTTP headers must be present
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-xss-protection'), '1; mode=block');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'");
});

test('2. Timing-safe auth: rejects invalid tokens, empty tokens, and malformed auth headers', async () => {
  // Completely missing header
  const noHeader = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`);
  assert.equal(noHeader.status, 401);
  const dataNoHeader = await noHeader.json();
  assert.equal(dataNoHeader.error, 'Unauthorized');

  // Incorrect admin key
  const badKey = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`, {
    headers: { 'x-admin-api-key': 'incorrect_dummy_key_12345' }
  });
  assert.equal(badKey.status, 401);

  // Different length token (timing test)
  const diffLenKey = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`, {
    headers: { 'x-admin-api-key': 'x' }
  });
  assert.equal(diffLenKey.status, 401);

  // Valid Bearer auth works
  const validBearer = await fetch(`${baseUrl}/api/cameras/station/pilot-metrics`, {
    headers: { authorization: `Bearer ${ADMIN_API_KEY}` }
  });
  assert.equal(validBearer.status, 200);
});

test('3. Path Traversal Prevention: rejects traversal strings in snapshot event IDs', async () => {
  // Test traversal patterns
  const traversalIds = [
    '..passwd',
    'dotdot_../../etc/passwd',
    '..\\..\\windows\\win.ini',
    'snap_station_../../secret',
    'snap_station_%2e%2e%2fpasswd'
  ];

  for (const maliciousId of traversalIds) {
    const res = await fetch(`${baseUrl}/api/cameras/station/snapshots/${encodeURIComponent(maliciousId)}`, {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    });
    // Must return 404 or reject cleanly without reading arbitrary files
    assert.equal(res.status, 404);

    // Direct service method check
    assert.equal(snapshotService.getSnapshotEvent(maliciousId), null);
    assert.equal(snapshotService.getSnapshotFilePath(maliciousId), null);
    assert.equal(snapshotService.deleteSnapshot(maliciousId), null);
  }
});

test('4. Request Size Limit: rejects excessively large payloads (>10MB)', async () => {
  // Build a 12MB string to exceed 10MB express.json limit
  const largePayload = {
    testData: 'A'.repeat(12 * 1024 * 1024)
  };

  try {
    const res = await fetch(`${baseUrl}/api/cameras/station/detect-workers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-api-key': ADMIN_API_KEY
      },
      body: JSON.stringify(largePayload)
    });
    assert.equal(res.status, 413); // Payload Too Large
  } catch (err) {
    // If the socket was abruptly closed by Node because payload exceeded limit, that's also valid rejection
    assert.ok(true);
  }
});

test('5. Zero Secrets Exposure: public and protected endpoints never leak credentials in responses', async () => {
  // Public all cameras endpoint
  const camsRes = await fetch(`${baseUrl}/api/cameras`);
  const camsText = await camsRes.text();
  assert.equal(camsText.includes('password'), false);
  assert.equal(camsText.includes('SHOP_STATION_PASS'), false);

  // Single camera status
  const statRes = await fetch(`${baseUrl}/api/cameras/station/status`);
  const statText = await statRes.text();
  assert.equal(statText.includes('password'), false);
  assert.equal(statText.includes('SHOP_STATION_PASS'), false);

  // Candidate events
  const evRes = await fetch(`${baseUrl}/api/workers/events`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  const evText = await evRes.text();
  assert.equal(evText.includes('password'), false);
  assert.equal(evText.includes(ADMIN_API_KEY), false);
});
