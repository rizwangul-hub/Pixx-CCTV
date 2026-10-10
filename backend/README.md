# Pixx Bicycle CCTV - Backend

Backend API service for Pixx Bicycle CCTV monitoring and management system.

---

## 📁 Directory Structure

```text
backend/
├── src/
│   ├── config/
│   │   ├── env.js                   # Environment configuration & validation
│   │   └── shops.js                 # Initial six shops camera configuration
│   ├── controllers/
│   │   ├── cameraController.js      # Camera endpoint controllers (status, test, snapshots)
│   │   └── healthController.js      # Health check controller logic
│   ├── middleware/
│   │   └── authMiddleware.js        # Admin authorization middleware (X-Admin-Api-Key)
│   ├── routes/
│   │   ├── cameraRoutes.js          # Camera API routes (/api/cameras)
│   │   └── healthRoutes.js          # Health check API routes (/api/health)
│   ├── services/
│   │   ├── cameraService.js         # Camera data management & status checking
│   │   ├── hikvisionService.js      # Safe Hikvision ISAPI connection testing
│   │   └── snapshotService.js       # ISAPI snapshot capture, validation & private storage
│   ├── validators/
│   │   └── cameraValidator.js       # Request validation for camera updates
│   ├── app.js                       # Express app configuration & middleware
│   └── server.js                    # Server startup and listening entry point
├── test/
│   └── camera.test.js               # Automated tests for health, cameras, and snapshots
├── storage/
│   └── snapshots/                   # Private snapshot storage (excluded from Git)
├── .env.example                     # Environment template with shop placeholders
├── .gitignore                       # Excludes node_modules, .env, secrets, storage/
├── package.json                     # Project metadata, scripts, and dependencies
└── README.md                        # Documentation and setup instructions
```

---

## ⚙️ Environment Configuration

Copy `.env.example` to create your local `.env`:

```bash
cp .env.example .env
```

### General Configuration

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Port number for Express server | `5000` |
| `NODE_ENV` | Application environment (`development` / `production`) | `development` |
| `ADMIN_API_KEY` | Secret API key required for connection tests & snapshots | `pixx_admin_secret_key` |
| `SNAPSHOT_STORAGE_DIR` | Private local directory for JPEG snapshots | `storage/snapshots` |
| `SNAPSHOT_RETENTION_HOURS` | Retention window before automatic cleanup | `72` |

### Per-Shop Hikvision Recorder Credentials (Placeholders)

| Variable | Description |
| :--- | :--- |
| `SHOP_<SHOP_ID>_HOST` | Hostname or LAN IP of recorder (e.g. `192.168.1.100`) |
| `SHOP_<SHOP_ID>_USER` | Local administrative username on recorder |
| `SHOP_<SHOP_ID>_PASS` | Local password on recorder |

*Shop IDs: `CAMDEN`, `STATION`, `CHELSEA`, `EDGEWARE`, `SOUTHWARK`, `LEABRIDGE`.*

---

## 🚀 Running the Server & Tests

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Automated Tests
```bash
npm test
```

### 3. Development Mode (with hot-reload)
```bash
npm run dev
```

### 4. Production Mode
```bash
npm start
```

---

## 📡 API Endpoints

All admin endpoints require the `X-Admin-Api-Key: <ADMIN_API_KEY>` header or `Authorization: Bearer <ADMIN_API_KEY>`.

### 1. Health Check
- **`GET /api/health`**
- Returns server status (`ok`) and timestamp.

### 2. Camera Configuration
- **`GET /api/cameras`**
  - Returns safe list of all six configured shops and labels without exposing credentials.
- **`GET /api/cameras/:shopId`**
  - Returns safe configuration for a single shop (`camden`, `station`, `chelsea`, `edgeware`, `southwark`, `leabridge`). Returns `404` for invalid shop IDs.
- **`GET /api/cameras/:shopId/status`**
  - Returns connection readiness (`not_configured`, `not_tested`, `reachable`, `unreachable`, `authentication_failed`, `unsupported`). Unconfigured cameras are never reported as connected.
- **`PATCH /api/cameras/:shopId`**
  - Updates permitted fields (`isEnabled`, `cameraLabel`, `host`, `connectionType`, `ports`, `streamType`, `verifiedChannelId`). Rejects unpermitted fields and invalid port numbers with `400 Bad Request`.

#### Example: Configuring Verified ISAPI Port & Channel ID
```bash
curl -X PATCH http://localhost:5000/api/cameras/camden \
  -H "Content-Type: application/json" \
  -d '{
    "host": "192.168.1.100",
    "verifiedChannelId": 101,
    "ports": { "httpPort": 80, "serverPort": 8000 }
  }'
```

### 3. Secure Connection Testing
- **`POST /api/cameras/:shopId/test-connection`**
  - Probes explicitly configured port and verifies Hikvision ISAPI communication without streaming video or scanning ports.
  - Rate limited to 1 request per 2 seconds.

### 4. Snapshot Capture & Private Inspection
- **`POST /api/cameras/:shopId/snapshot`**
  - Captures a single JPEG snapshot via `/ISAPI/Streaming/channels/{channelId}/picture` without exposing credentials in URLs.
  - Validates JPEG magic bytes (`0xFF, 0xD8, 0xFF`). Error pages (HTML/XML) are rejected and never saved.
  - Stores image in private storage directory and creates an event record.
- **`GET /api/cameras/:shopId/snapshots`**
  - Lists snapshot event history for a shop.
- **`GET /api/cameras/:shopId/snapshots/:eventId`**
  - Returns event metadata, or downloads binary JPEG stream if `Accept: image/jpeg` or `?raw=true` query is provided.
- **`DELETE /api/cameras/:shopId/snapshots/:eventId`**
  - Deletes the stored JPEG file from disk and removes the event record.

---

## 🔒 Remote Shop Network Requirements & Limitations

1. **Physical Network Access**: The backend server must have direct network routing to the recorder's LAN or private VPN subnet (e.g. WireGuard/Site-to-Site VPN). Recorders on private `192.168.x.x` subnets cannot be reached across the public Internet without VPN or secure port forwarding.
2. **Channel Mapping**: Channel display labels (such as `Camera 01` or `Camera 15`) do not automatically equal Hikvision ISAPI channel IDs (typically `101`, `201`, etc. for digital IP channels or `1`, `2` for analog channels). The channel ID must be verified and configured in `verifiedChannelId` before capturing snapshots.
3. **Channel Zero**: Edgeware's Channel Zero represents a composite multi-camera stream (`/ISAPI/Streaming/channels/0/picture`) and must not be treated as a single individual camera.
