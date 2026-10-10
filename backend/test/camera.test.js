const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const app = require('../src/app');
const { resetShops, updateCamera } = require('../src/services/cameraService');
const { resetRateLimits } = require('../src/services/hikvisionService');
const { resetSnapshotService } = require('../src/services/snapshotService');
const { ADMIN_API_KEY } = require('../src/config/env');

let server;
let baseUrl;

// Mock Hikvision ISAPI server for protocol & authentication testing
let mockHikvisionServer;
let mockHikvisionPort;
let shouldAuthenticate = false;
let mockPictureMode = 'valid_jpeg'; // 'valid_jpeg' | 'invalid_image' | 'unauthorized'

// Minimal 1x1 valid JPEG binary buffer
const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9
]);

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Create mock Hikvision recorder HTTP ISAPI server
  mockHikvisionServer = http.createServer((req, res) => {
    // 1. Device Info Probe
    if (req.url === '/ISAPI/System/deviceInfo') {
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Hikvision"',
          'Content-Type': 'application/xml'
        });
        return res.end('<ResponseStatus><statusCode>401</statusCode></ResponseStatus>');
      }

      if (shouldAuthenticate && authHeader === `Basic ${Buffer.from('admin:valid_pass').toString('base64')}`) {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end('<DeviceInfo><model>DS-7208HUHI-K1</model></DeviceInfo>');
      }

      res.writeHead(401, { 'Content-Type': 'application/xml' });
      return res.end('<ResponseStatus><statusCode>401</statusCode><statusString>Unauthorized</statusString></ResponseStatus>');
    }

    // 2. Picture Snapshot Endpoint
    if (req.url === '/ISAPI/Streaming/channels/101/picture' || req.url === '/ISAPI/Streaming/channels/0/picture') {
      const authHeader = req.headers['authorization'];
      if (!authHeader || authHeader !== `Basic ${Buffer.from('admin:valid_pass').toString('base64')}`) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Hikvision"',
          'Content-Type': 'application/xml'
        });
        return res.end('<ResponseStatus><statusCode>401</statusCode></ResponseStatus>');
      }

      if (mockPictureMode === 'invalid_image') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>Error: Stream Offline</body></html>');
      }

      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': VALID_JPEG_BUFFER.length
      });
      return res.end(VALID_JPEG_BUFFER);
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockHikvisionServer.listen(0, resolve));
  mockHikvisionPort = mockHikvisionServer.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockHikvisionServer.close(resolve));
});

test.beforeEach(() => {
  resetShops();
  resetRateLimits();
  resetSnapshotService();
  mockPictureMode = 'valid_jpeg';
  delete process.env.SHOP_CAMDEN_HOST;
  delete process.env.SHOP_CAMDEN_USER;
  delete process.env.SHOP_CAMDEN_PASS;
  delete process.env.SHOP_EDGEWARE_HOST;
  delete process.env.SHOP_EDGEWARE_USER;
  delete process.env.SHOP_EDGEWARE_PASS;
});

test('1. Existing /api/health endpoint continues to function', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.ok(data.timestamp);
});

test('2. GET /api/cameras returns all six shops with correct camera labels and Hikvision brand', async () => {
  const res = await fetch(`${baseUrl}/api/cameras`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.count, 6);
  assert.equal(data.cameras.length, 6);

  const shopIds = data.cameras.map((c) => c.id);
  const expectedShops = ['camden', 'station', 'chelsea', 'edgeware', 'southwark', 'leabridge'];
  assert.deepEqual(shopIds, expectedShops);

  for (const cam of data.cameras) {
    assert.equal(cam.brand, 'Hikvision');
    assert.ok(cam.ports);
    assert.equal(typeof cam.ports.serverPort, 'number');
    assert.equal(typeof cam.ports.rtspPort, 'number');
    assert.notEqual(cam.ports.serverPort, cam.ports.rtspPort);
  }

  const camden = data.cameras.find((c) => c.id === 'camden');
  assert.equal(camden.cameraLabel, 'Camera 01');

  const edgeware = data.cameras.find((c) => c.id === 'edgeware');
  assert.equal(edgeware.cameraLabel, 'Channel Zero');
  assert.equal(edgeware.isChannelZero, true);
  assert.equal(edgeware.streamType, 'channel_zero');
});

test('3. Responses contain no credentials or sensitive password fields', async () => {
  const res = await fetch(`${baseUrl}/api/cameras`);
  const data = await res.json();

  for (const cam of data.cameras) {
    assert.equal(cam.password, undefined);
    assert.equal(cam.username, undefined);
    assert.equal(cam.user, undefined);
    assert.equal(cam.pass, undefined);
    assert.equal(cam.credentials, undefined);
  }

  const singleRes = await fetch(`${baseUrl}/api/cameras/camden`);
  const singleData = await singleRes.json();
  assert.equal(singleData.camera.password, undefined);
  assert.equal(singleData.camera.username, undefined);
  assert.equal(singleData.camera.credentials, undefined);
});

test('4. GET /api/cameras/:shopId returns 404 for invalid shop IDs', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/invalid-shop-id`);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error, 'Shop not found');
});

test('5. Unconfigured cameras are never falsely reported as connected', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/status`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.shopId, 'camden');
  assert.notEqual(data.status, 'connected');
  assert.notEqual(data.status, 'reachable');
  assert.ok(['not_configured', 'not_tested'].includes(data.status));
});

test('6. PATCH /api/cameras/:shopId updates permitted configuration fields', async () => {
  const updatePayload = {
    cameraLabel: 'Camera 01 - Main Gate',
    isEnabled: false,
    ports: {
      rtspPort: 5554,
      serverPort: 8001
    }
  };

  const patchRes = await fetch(`${baseUrl}/api/cameras/camden`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePayload)
  });

  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.camera.cameraLabel, 'Camera 01 - Main Gate');
  assert.equal(patchData.camera.isEnabled, false);
  assert.equal(patchData.camera.ports.rtspPort, 5554);
  assert.equal(patchData.camera.ports.serverPort, 8001);
  assert.equal(patchData.camera.ports.httpPort, 80);

  const getRes = await fetch(`${baseUrl}/api/cameras/camden`);
  const getData = await getRes.json();
  assert.equal(getData.camera.cameraLabel, 'Camera 01 - Main Gate');
  assert.equal(getData.camera.isEnabled, false);
});

test('7. PATCH /api/cameras/:shopId rejects invalid updates and forbidden fields', async () => {
  const badCredsRes = await fetch(`${baseUrl}/api/cameras/camden`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'hacked_password' })
  });
  assert.equal(badCredsRes.status, 400);
  const credsData = await badCredsRes.json();
  assert.equal(credsData.error, 'Validation failed');

  const badPortRes = await fetch(`${baseUrl}/api/cameras/camden`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ports: { rtspPort: 99999 } })
  });
  assert.equal(badPortRes.status, 400);

  const notFoundRes = await fetch(`${baseUrl}/api/cameras/unknown-shop`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameraLabel: 'Test' })
  });
  assert.equal(notFoundRes.status, 404);
});

test('8. POST /api/cameras/:shopId/test-connection requires administrator authentication', async () => {
  const noAuthRes = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST'
  });
  assert.equal(noAuthRes.status, 401);
  const noAuthData = await noAuthRes.json();
  assert.equal(noAuthData.error, 'Unauthorized');

  const badAuthRes = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': 'incorrect-secret-key' }
  });
  assert.equal(badAuthRes.status, 401);
});

test('9. POST /api/cameras/:shopId/test-connection returns 404 for unknown shop IDs', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/non-existent-shop/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error, 'Shop not found');
});

test('10. POST /api/cameras/:shopId/test-connection returns not_configured for missing host or credentials', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.shopId, 'camden');
  assert.equal(data.status, 'not_configured');
  assert.ok(data.details);
  assert.equal(data.password, undefined);
  assert.equal(data.username, undefined);
});

test('11. POST /api/cameras/:shopId/test-connection returns not_configured for invalid host syntax', async () => {
  updateCamera('camden', { host: 'admin:pass@invalid host.com' });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'secret123';

  const res = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'not_configured');
  assert.match(data.details, /valid host/i);
});

test('12. POST /api/cameras/:shopId/test-connection returns unreachable for closed or non-routable host', async () => {
  updateCamera('camden', {
    host: '127.0.0.1',
    ports: { httpPort: 54321, serverPort: 54322 }
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'secret123';

  const res = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'unreachable');
  assert.equal(data.password, undefined);
});

test('13. POST /api/cameras/:shopId/test-connection returns authentication_failed when recorder rejects credentials', async () => {
  shouldAuthenticate = false;
  updateCamera('camden', {
    host: '127.0.0.1',
    ports: { httpPort: mockHikvisionPort, serverPort: 8000 }
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'wrong_password';

  const res = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'authentication_failed');
  assert.match(data.details, /credentials were rejected/i);
  assert.equal(data.password, undefined);
});

test('14. POST /api/cameras/:shopId/test-connection returns reachable when recorder authentication succeeds', async () => {
  shouldAuthenticate = true;
  updateCamera('edgeware', {
    host: '127.0.0.1',
    ports: { httpPort: mockHikvisionPort, serverPort: 8000 }
  });
  process.env.SHOP_EDGEWARE_USER = 'admin';
  process.env.SHOP_EDGEWARE_PASS = 'valid_pass';

  const res = await fetch(`${baseUrl}/api/cameras/edgeware/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'reachable');
  assert.match(data.details, /Channel Zero/i);
  assert.equal(data.password, undefined);

  const statusRes = await fetch(`${baseUrl}/api/cameras/edgeware/status`);
  const statusData = await statusRes.json();
  assert.equal(statusData.status, 'reachable');
});

test('15. POST /api/cameras/:shopId/test-connection rate limits rapid repeated requests', async () => {
  const req1 = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(req1.status, 200);

  const req2 = await fetch(`${baseUrl}/api/cameras/camden/test-connection`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(req2.status, 429);
  const data2 = await req2.json();
  assert.equal(data2.error, 'Too Many Requests');
});

// ========================================================
// PHASE 5: Camden Snapshot Tests
// ========================================================

test('16. POST /api/cameras/camden/snapshot rejects unauthorized requests', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST'
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Unauthorized');
});

test('17. POST /api/cameras/:shopId/snapshot returns 404 for unknown shop ID', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/non-existent/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error, 'Shop not found');
});

test('18. POST /api/cameras/camden/snapshot returns not_configured when host or credentials missing', async () => {
  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.shopId, 'camden');
  assert.equal(data.status, 'not_configured');
  assert.equal(data.captureStatus, 'failed');
  assert.equal(data.password, undefined);
});

test('19. POST /api/cameras/camden/snapshot returns unsupported if channel ID is unverified', async () => {
  updateCamera('camden', {
    host: '127.0.0.1',
    verifiedChannelId: null // explicitly unverified
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'valid_pass';

  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'unsupported');
  assert.match(data.details, /channel id is unverified/i);
});

test('20. Mocked successful snapshot capture on Camden returns valid metadata & event', async () => {
  updateCamera('camden', {
    host: '127.0.0.1',
    verifiedChannelId: 101, // verified camera channel
    ports: { httpPort: mockHikvisionPort, serverPort: 8000 }
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'valid_pass';

  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.message, 'Snapshot captured successfully');
  assert.ok(data.event);
  assert.equal(data.event.shopId, 'camden');
  assert.equal(data.event.cameraLabel, 'Camera 01');
  assert.equal(data.event.captureStatus, 'success');
  assert.equal(data.event.mimeType, 'image/jpeg');
  assert.ok(data.event.fileSizeBytes > 0);
  assert.ok(data.event.eventId);
  assert.ok(data.event.snapshotRef);
  // Ensure internal absolute path and credentials are never exposed
  assert.equal(data.event._localPath, undefined);
  assert.equal(data.event.password, undefined);
  assert.equal(data.event.username, undefined);

  // Private image access test: Unauthorized client cannot download or view image
  const unauthViewRes = await fetch(`${baseUrl}/api/cameras/camden/snapshots/${data.event.eventId}`);
  assert.equal(unauthViewRes.status, 401);

  // Authorized client can view metadata
  const authMetaRes = await fetch(`${baseUrl}/api/cameras/camden/snapshots/${data.event.eventId}`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(authMetaRes.status, 200);
  const metaData = await authMetaRes.json();
  assert.equal(metaData.snapshot.eventId, data.event.eventId);

  // Authorized client can download private binary JPEG image
  const authImgRes = await fetch(`${baseUrl}/api/cameras/camden/snapshots/${data.event.eventId}?raw=true`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(authImgRes.status, 200);
  assert.equal(authImgRes.headers.get('content-type'), 'image/jpeg');
  const imgBuffer = Buffer.from(await authImgRes.arrayBuffer());
  assert.equal(imgBuffer.length, VALID_JPEG_BUFFER.length);
});

test('21. Invalid image response (HTML error page) is rejected and never saved as JPEG', async () => {
  mockPictureMode = 'invalid_image';
  updateCamera('camden', {
    host: '127.0.0.1',
    verifiedChannelId: 101,
    ports: { httpPort: mockHikvisionPort, serverPort: 8000 }
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'valid_pass';

  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'invalid_image');
  assert.equal(data.captureStatus, 'failed');
  assert.match(data.details, /non-jpeg/i);
});

test('22. Unavailable camera and timeouts return unreachable status', async () => {
  updateCamera('camden', {
    host: '127.0.0.1',
    verifiedChannelId: 101,
    ports: { httpPort: 54321, serverPort: 54322 } // closed port
  });
  process.env.SHOP_CAMDEN_USER = 'admin';
  process.env.SHOP_CAMDEN_PASS = 'valid_pass';

  const res = await fetch(`${baseUrl}/api/cameras/camden/snapshot`, {
    method: 'POST',
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'unreachable');
  assert.equal(data.captureStatus, 'failed');
});

test('23. GET /api/cameras/:shopId/channels/discover safely verifies channels without guessing', async () => {
  // Test Edgeware Channel Zero
  const edgewareRes = await fetch(`${baseUrl}/api/cameras/edgeware/channels/discover`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(edgewareRes.status, 200);
  const edgewareData = await edgewareRes.json();
  assert.equal(edgewareData.channelType, 'channel_zero');
  assert.equal(edgewareData.channelId, 0);

  // Test unconfigured shop reports manual verification required without guessing
  const camdenRes = await fetch(`${baseUrl}/api/cameras/camden/channels/discover`, {
    headers: { 'x-admin-api-key': ADMIN_API_KEY }
  });
  assert.equal(camdenRes.status, 200);
  const camdenData = await camdenRes.json();
  assert.equal(camdenData.verified, false);
});

test('24. 72-hour snapshot retention cleanup prunes expired image files while preserving audit limits', async () => {
  const snapshotService = require('../src/services/snapshotService');
  const { SNAPSHOT_STORAGE_DIR } = require('../src/config/env');

  // Create an old snapshot file and event (simulating 75 hours ago)
  const oldTimeSec = Math.floor((Date.now() - 75 * 3600 * 1000) / 1000);
  const oldEventId = `snap_station_${oldTimeSec * 1000}_testold`;
  const oldFilename = `${oldEventId}.jpg`;
  const oldFilePath = path.join(SNAPSHOT_STORAGE_DIR, oldFilename);
  fs.writeFileSync(oldFilePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  fs.utimesSync(oldFilePath, oldTimeSec, oldTimeSec);

  // Create a recent snapshot file (simulating 2 hours ago)
  const recentTimeSec = Math.floor((Date.now() - 2 * 3600 * 1000) / 1000);
  const recentEventId = `snap_station_${recentTimeSec * 1000}_testrec`;
  const recentFilename = `${recentEventId}.jpg`;
  const recentFilePath = path.join(SNAPSHOT_STORAGE_DIR, recentFilename);
  fs.writeFileSync(recentFilePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  fs.utimesSync(recentFilePath, recentTimeSec, recentTimeSec);

  // Populate events into snapshotService internal store
  snapshotService.getSnapshotEvent(oldEventId);
  snapshotService.getSnapshotEvent(recentEventId);

  // Run 72-hour cleanup
  const cleanupRes = snapshotService.cleanupOldSnapshots(72);
  assert.ok(cleanupRes.deletedCount >= 1);

  // Verify expired file was deleted from disk
  assert.equal(fs.existsSync(oldFilePath), false);

  // Verify recent file is preserved
  assert.equal(fs.existsSync(recentFilePath), true);

  // Cleanup test file
  if (fs.existsSync(recentFilePath)) {
    fs.unlinkSync(recentFilePath);
  }
});
