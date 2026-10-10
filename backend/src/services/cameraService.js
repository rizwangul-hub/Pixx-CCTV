const { defaultShops } = require('../config/shops');

// Maintain in-memory state initialized from default configuration
let shops = defaultShops.map((shop) => ({
  ...shop,
  ports: { ...shop.ports },
  channelMapping: shop.channelMapping ? { ...shop.channelMapping } : null,
  credentialEnv: shop.credentialEnv ? { ...shop.credentialEnv } : null,
  latestTestResult: shop.latestTestResult ? { ...shop.latestTestResult } : null
}));

/**
 * Strips any sensitive properties and returns a clean, safe copy.
 * Never exposes passwords, usernames, or internal env keys.
 */
const sanitizeCamera = (shop) => {
  if (!shop) return null;
  const {
    id,
    name,
    cameraLabel,
    brand,
    connectionType,
    host,
    ports,
    protocol,
    channelMapping,
    streamType,
    isChannelZero,
    verifiedChannelId,
    isEnabled,
    latestTestResult
  } = shop;

  return {
    id,
    name,
    cameraLabel,
    brand,
    connectionType,
    host,
    ports: { ...ports },
    protocol,
    channelMapping: channelMapping ? { ...channelMapping } : null,
    streamType,
    isChannelZero,
    verifiedChannelId,
    isEnabled,
    latestTestResult: latestTestResult ? { ...latestTestResult } : null
  };
};

/**
 * Checks environment variables for shop credentials without ever returning the secret strings.
 */
const getCredentialStatus = (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = shops.find((s) => s.id.toLowerCase() === normalizedId);

  const userKey = shop?.credentialEnv?.userKey || `SHOP_${normalizedId.toUpperCase()}_USER`;
  const passKey = shop?.credentialEnv?.passKey || `SHOP_${normalizedId.toUpperCase()}_PASS`;

  const user = process.env[userKey];
  const pass = process.env[passKey];

  return {
    hasUsername: Boolean(user && user.trim() !== ''),
    hasPassword: Boolean(pass && pass.trim() !== ''),
    isConfigured: Boolean(user && user.trim() !== '' && pass && pass.trim() !== '')
  };
};

/**
 * Get internal shop object (for service use only - never expose to controller/client).
 */
const getShopRaw = (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  return shops.find((s) => s.id.toLowerCase() === normalizedId) || null;
};

/**
 * Get all configured cameras (safe view).
 */
const getAllCameras = () => {
  return shops.map(sanitizeCamera);
};

/**
 * Get single camera by shop ID (safe view).
 */
const getCameraById = (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = shops.find((s) => s.id.toLowerCase() === normalizedId);
  return shop ? sanitizeCamera(shop) : null;
};

/**
 * Get camera connection status.
 * Returns 'not_configured', 'not_tested', or latest verified status.
 */
const getCameraStatus = (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = shops.find((s) => s.id.toLowerCase() === normalizedId);
  if (!shop) return null;

  if (!shop.isEnabled) {
    return {
      status: 'not_configured',
      details: 'Camera is currently disabled in configuration'
    };
  }

  // If a connection test was already executed, return the latest actual test status
  if (shop.latestTestResult && shop.latestTestResult.status) {
    return {
      status: shop.latestTestResult.status,
      details: shop.latestTestResult.details,
      testedAt: shop.latestTestResult.testedAt
    };
  }

  const credStatus = getCredentialStatus(normalizedId);
  const hasHost = Boolean(shop.host && shop.host.trim() !== '');

  if (!hasHost || !credStatus.isConfigured) {
    const missing = [];
    if (!hasHost) missing.push('host');
    if (!credStatus.hasUsername) missing.push('username');
    if (!credStatus.hasPassword) missing.push('password');

    return {
      status: 'not_configured',
      details: `Incomplete configuration: missing ${missing.join(', ')}`
    };
  }

  return {
    status: 'not_tested',
    details: 'Camera host and credentials configured, pending verification test'
  };
};

/**
 * Update the latest connection test result for a shop.
 */
const updateTestResult = (shopId, result) => {
  const normalizedId = String(shopId).toLowerCase();
  const index = shops.findIndex((s) => s.id.toLowerCase() === normalizedId);
  if (index === -1) return null;

  shops[index].latestTestResult = {
    status: result.status,
    details: result.details,
    testedAt: result.testedAt || new Date().toISOString()
  };

  return sanitizeCamera(shops[index]);
};

/**
 * Update permitted camera configuration fields.
 */
const updateCamera = (shopId, updateData) => {
  const normalizedId = String(shopId).toLowerCase();
  const index = shops.findIndex((s) => s.id.toLowerCase() === normalizedId);
  if (index === -1) return null;

  const current = shops[index];

  const updated = {
    ...current,
    ...updateData,
    ports: updateData.ports ? { ...current.ports, ...updateData.ports } : current.ports
  };

  if (updateData.streamType) {
    updated.isChannelZero = updateData.streamType === 'channel_zero';
  }

  shops[index] = updated;
  return sanitizeCamera(shops[index]);
};

/**
 * Reset shops state (helpful for test isolation).
 */
const resetShops = () => {
  shops = defaultShops.map((shop) => ({
    ...shop,
    ports: { ...shop.ports },
    channelMapping: shop.channelMapping ? { ...shop.channelMapping } : null,
    credentialEnv: shop.credentialEnv ? { ...shop.credentialEnv } : null,
    latestTestResult: null
  }));
};

module.exports = {
  getAllCameras,
  getCameraById,
  getCameraStatus,
  getShopRaw,
  updateCamera,
  updateTestResult,
  resetShops
};
