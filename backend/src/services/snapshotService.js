const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cameraService = require('./cameraService');
const { SNAPSHOT_STORAGE_DIR, SNAPSHOT_RETENTION_HOURS } = require('../config/env');

// Ensure private storage directory exists
try {
  if (!fs.existsSync(SNAPSHOT_STORAGE_DIR)) {
    fs.mkdirSync(SNAPSHOT_STORAGE_DIR, { recursive: true });
  }
} catch (err) {
  console.warn(`[WARN] Could not create snapshot storage dir (${SNAPSHOT_STORAGE_DIR}): ${err.message}`);
}

// In-memory snapshot event store
let snapshotEvents = [];

// Rate limit map: shopId -> lastRequestTimestamp
const snapshotRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 2000;
const SNAPSHOT_TIMEOUT_MS = 3000;

/**
 * Validates whether a buffer contains valid JPEG magic bytes (FF D8 FF).
 */
const isValidJpeg = (buffer) => {
  if (!buffer || buffer.length < 4) return false;
  return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
};

/**
 * Parses image width and height from JPEG frame headers if available.
 */
const getJpegDimensions = (buffer) => {
  if (!isValidJpeg(buffer)) return null;
  let offset = 2;
  while (offset < buffer.length - 8) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
    const length = buffer.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc9 && marker <= 0xcb)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
};

/**
 * Strips internal paths from event before returning to caller.
 */
const sanitizeEvent = (event) => {
  if (!event) return null;
  const { eventId, shopId, cameraLabel, timestamp, snapshotRef, captureStatus, fileSizeBytes, mimeType, dimensions } = event;
  return {
    eventId,
    shopId,
    cameraLabel,
    timestamp,
    snapshotRef,
    captureStatus,
    fileSizeBytes,
    mimeType,
    ...(dimensions ? { dimensions } : {})
  };
};

/**
 * Saves a valid JPEG snapshot buffer to private storage in shop-specific folder.
 * Verifies persistence on disk and returns the created event record.
 */
const saveSnapshot = (buffer, shopId = 'station', metadata = {}) => {
  const normalizedId = String(shopId || 'station').toLowerCase();
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const eventId = metadata.eventId || `snap_${normalizedId}_${Date.now()}_${randomSuffix}`;
  const filename = `${eventId}.jpg`;
  const shopDir = path.join(SNAPSHOT_STORAGE_DIR, normalizedId);
  try {
    if (!fs.existsSync(shopDir)) {
      fs.mkdirSync(shopDir, { recursive: true });
    }
  } catch (_) {}
  const filePath = path.join(shopDir, filename);

  fs.writeFileSync(filePath, buffer);

  // Verify written file exists on disk and is non-empty
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error('Snapshot file could not be verified on disk after writing');
  }

  const dimensions = getJpegDimensions(buffer);

  const eventRecord = {
    eventId,
    shopId: normalizedId,
    cameraLabel: metadata.cameraLabel || (normalizedId === 'station' ? 'Camera 05' : 'CCTV Camera'),
    timestamp: metadata.timestamp || new Date().toISOString(),
    snapshotRef: `${normalizedId}/${filename}`,
    captureStatus: 'success',
    fileSizeBytes: buffer.length,
    mimeType: 'image/jpeg',
    dimensions,
    _localPath: filePath
  };

  snapshotEvents.unshift(eventRecord);
  return eventRecord;
};

/**
 * Captures a single JPEG snapshot from a verified Hikvision ISAPI endpoint.
 */
const captureSnapshot = async (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = cameraService.getShopRaw(normalizedId);

  if (!shop) {
    return { error: 'SHOP_NOT_FOUND' };
  }

  // Rate Limiting
  const now = Date.now();
  const lastRequest = snapshotRateLimits.get(normalizedId);
  if (lastRequest && now - lastRequest < RATE_LIMIT_WINDOW_MS) {
    return {
      isRateLimited: true,
      error: 'RATE_LIMIT_EXCEEDED',
      details: 'Rate limit exceeded: please wait a moment before requesting another snapshot'
    };
  }
  snapshotRateLimits.set(normalizedId, now);

  // 1. Verify Configuration Completeness
  if (!shop.isEnabled) {
    return {
      status: 'not_configured',
      details: 'Camera recorder is currently disabled in configuration'
    };
  }

  if (!shop.host || shop.host.trim() === '') {
    return {
      status: 'not_configured',
      details: 'Host address is not configured for this shop'
    };
  }

  // Check credentials in environment variables
  const userKey = shop.credentialEnv?.userKey || `SHOP_${normalizedId.toUpperCase()}_USER`;
  const passKey = shop.credentialEnv?.passKey || `SHOP_${normalizedId.toUpperCase()}_PASS`;
  const username = process.env[userKey];
  const password = process.env[passKey];

  if (!username || !password || username.trim() === '' || password.trim() === '') {
    return {
      status: 'not_configured',
      details: 'Recorder credentials (username or password) missing in environment'
    };
  }

  // 2. Channel Verification Check
  // Rule: Do not assume channel ID from display label.
  // Channel Zero is separate composite channel.
  let channelPath;
  if (shop.isChannelZero) {
    channelPath = '0';
  } else if (shop.verifiedChannelId !== null && shop.verifiedChannelId !== undefined) {
    channelPath = String(shop.verifiedChannelId);
  } else {
    return {
      status: 'unsupported',
      details: 'Camera channel ID is unverified. Please verify recorder channel mapping and configure verifiedChannelId.'
    };
  }

  const httpPort = shop.ports?.httpPort || (shop.ports?.useHttps ? 443 : 80);
  const protocol = shop.ports?.useHttps ? 'https' : 'http';
  const url = `${protocol}://${shop.host}:${httpPort}/ISAPI/Streaming/channels/${channelPath}/picture`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);

  try {
    const basicAuthToken = Buffer.from(`${username}:${password}`).toString('base64');

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicAuthToken}`,
        Accept: 'image/jpeg, image/*'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 403) {
      return {
        status: 'authentication_failed',
        details: 'Recorder rejected credentials on ISAPI picture endpoint'
      };
    }

    if (res.status === 404) {
      return {
        status: 'unsupported',
        details: `Snapshot endpoint not supported or channel (${channelPath}) picture not found on recorder`
      };
    }

    if (!res.ok) {
      return {
        status: 'unreachable',
        details: `Recorder returned HTTP status ${res.status} when capturing picture`
      };
    }

    const contentType = res.headers.get('content-type') || '';
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate that received payload is genuine JPEG and not XML/HTML error text
    if (!isValidJpeg(buffer)) {
      return {
        status: 'invalid_image',
        details: `Received non-JPEG data (content-type: ${contentType}, length: ${buffer.length} bytes)`
      };
    }

    const eventRecord = saveSnapshot(buffer, normalizedId, { cameraLabel: shop.cameraLabel });

    return {
      status: 'success',
      event: sanitizeEvent(eventRecord)
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return {
        status: 'unreachable',
        details: `Connection timed out after ${SNAPSHOT_TIMEOUT_MS}ms while requesting camera picture`
      };
    }
    return {
      status: 'unreachable',
      details: `Network error while capturing snapshot: ${err.message}`
    };
  }
};

/**
 * List stored snapshot events for a shop.
 */
const listSnapshotsByShop = (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  return snapshotEvents
    .filter((e) => e.shopId === normalizedId)
    .map(sanitizeEvent);
};

// Safe alphanumeric event ID regex (e.g. snap_station_1791559172253_acdd72bd)
const SAFE_EVENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

/**
 * Validates that an event ID string contains only safe alphanumeric/underscore characters
 * and contains no path traversal sequences ('..' or slashes).
 */
const isSafeEventId = (eventId) => {
  if (typeof eventId !== 'string') return false;
  const clean = eventId.replace(/\.jpg$/i, '');
  return SAFE_EVENT_ID_REGEX.test(clean) && !eventId.includes('..') && !eventId.includes('/') && !eventId.includes('\\');
};

/**
 * Get single snapshot event metadata by eventId.
 */
const getSnapshotEvent = (eventId) => {
  if (!isSafeEventId(eventId)) return null;
  const cleanId = String(eventId).replace(/\.jpg$/i, '');

  let event = snapshotEvents.find((e) => e.eventId === cleanId);
  if (!event) {
    const filePath = getSnapshotFilePath(cleanId);
    if (filePath && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const parts = cleanId.split('_');
      const shopId = parts[1] || 'station';
      event = {
        eventId: cleanId,
        shopId,
        cameraLabel: 'Camera 05',
        timestamp: stat.mtime.toISOString(),
        snapshotRef: `${shopId}/${cleanId}.jpg`,
        captureStatus: 'success',
        fileSizeBytes: stat.size,
        mimeType: 'image/jpeg',
        _localPath: filePath
      };
      snapshotEvents.push(event);
    }
  }
  return event ? sanitizeEvent(event) : null;
};

/**
 * Get internal local file path for an authorized binary download.
 * Resolves against shop-specific subdirectories and root storage directories.
 */
const getSnapshotFilePath = (eventId) => {
  if (!isSafeEventId(eventId)) return null;
  const cleanId = String(eventId).replace(/\.jpg$/i, '');

  const event = snapshotEvents.find((e) => e.eventId === cleanId);
  if (event && event._localPath && fs.existsSync(event._localPath)) {
    return event._localPath;
  }

  const parts = cleanId.split('_');
  const shopId = parts[1] || 'station';
  const filename = `${cleanId}.jpg`;

  const candidatePaths = [
    path.join(SNAPSHOT_STORAGE_DIR, shopId, filename),
    path.join(SNAPSHOT_STORAGE_DIR, filename),
    path.join(__dirname, '../../storage/snapshots', shopId, filename),
    path.join(__dirname, '../../storage/snapshots', filename)
  ];

  for (const candPath of candidatePaths) {
    const resolvedPath = path.resolve(candPath);
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }

  // Scan subdirectories in SNAPSHOT_STORAGE_DIR
  try {
    if (fs.existsSync(SNAPSHOT_STORAGE_DIR)) {
      const entries = fs.readdirSync(SNAPSHOT_STORAGE_DIR);
      for (const entry of entries) {
        const subPath = path.join(SNAPSHOT_STORAGE_DIR, entry);
        if (fs.statSync(subPath).isDirectory()) {
          const checkFile = path.join(subPath, filename);
          if (fs.existsSync(checkFile)) {
            return checkFile;
          }
        }
      }
    }
  } catch (_) {}

  return null;
};

/**
 * Deletes a stored snapshot by eventId.
 */
const deleteSnapshot = (eventId) => {
  if (!isSafeEventId(eventId)) return null;
  const cleanId = String(eventId).replace(/\.jpg$/i, '');

  const index = snapshotEvents.findIndex((e) => e.eventId === cleanId);
  const filePath = getSnapshotFilePath(cleanId);

  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }

  if (index !== -1) {
    snapshotEvents.splice(index, 1);
  }
  return { success: true, eventId: cleanId };
};

/**
 * Deletes snapshots older than specified retention hours across all shop directories.
 */
const cleanupOldSnapshots = (retentionHours = SNAPSHOT_RETENTION_HOURS) => {
  const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000;
  let deletedFromEvents = 0;

  // 1. Prune tracked snapshot events
  snapshotEvents = snapshotEvents.filter((event) => {
    const eventTime = new Date(event.timestamp).getTime();
    if (eventTime < cutoffTime) {
      if (event._localPath && fs.existsSync(event._localPath)) {
        try {
          fs.unlinkSync(event._localPath);
        } catch (_) {}
      }
      deletedFromEvents += 1;
      return false;
    }
    return true;
  });

  // 2. Scan snapshot directories recursively for untracked or orphaned files older than cutoff
  let deletedOrphanFiles = 0;
  const scanAndPruneDir = (dirPath) => {
    let count = 0;
    if (!fs.existsSync(dirPath)) return count;
    try {
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            count += scanAndPruneDir(fullPath);
          } else if ((entry.endsWith('.jpg') || entry.endsWith('.jpeg')) && stat.mtimeMs < cutoffTime) {
            fs.unlinkSync(fullPath);
            count += 1;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return count;
  };

  deletedOrphanFiles += scanAndPruneDir(SNAPSHOT_STORAGE_DIR);
  const legacyDir = path.join(__dirname, '../../storage/snapshots');
  if (legacyDir !== SNAPSHOT_STORAGE_DIR && fs.existsSync(legacyDir)) {
    deletedOrphanFiles += scanAndPruneDir(legacyDir);
  }

  return { deletedCount: deletedFromEvents + deletedOrphanFiles };
};

/**
 * Resets snapshot store & rate limits (used for test isolation).
 */
const resetSnapshotService = () => {
  snapshotRateLimits.clear();
  for (const event of snapshotEvents) {
    if (event._localPath && fs.existsSync(event._localPath)) {
      try {
        fs.unlinkSync(event._localPath);
      } catch (_) {}
    }
  }
  snapshotEvents = [];
};

module.exports = {
  captureSnapshot,
  saveSnapshot,
  listSnapshotsByShop,
  getSnapshotEvent,
  getSnapshotFilePath,
  deleteSnapshot,
  cleanupOldSnapshots,
  resetSnapshotService,
  isValidJpeg
};
