const net = require('net');
const dns = require('dns').promises;
const cameraService = require('./cameraService');

// In-memory rate limiting map per shop: shopId -> lastTestTimestamp
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 2000; // 2 seconds cooldown
const CONNECTION_TIMEOUT_MS = 2500; // Short 2.5s socket/request timeout

/**
 * Validates host string syntax (no protocols, credentials, or path traversal).
 */
const isValidHost = (host) => {
  if (!host || typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.includes('@') || trimmed.includes('/') || trimmed.includes(' ')) {
    return false;
  }
  return true;
};

/**
 * Resolves a hostname to an IP address safely.
 */
const resolveDns = async (host) => {
  if (!isValidHost(host)) {
    return { status: 'not_configured', details: 'Invalid host syntax' };
  }

  // Check if already an IPv4 or IPv6
  if (net.isIP(host)) {
    return { status: 'resolved', ip: host, isDirectIp: true };
  }

  try {
    const lookup = await dns.lookup(host);
    return { status: 'resolved', ip: lookup.address, isDirectIp: false };
  } catch (err) {
    return { status: 'failed', details: `DNS resolution failed: ${err.code || err.message}` };
  }
};

/**
 * Tests raw TCP reachability on a specific host and port with a strict timeout.
 * Never scans ports; tests only the single configured port.
 */
const testTcpReachability = (host, port, timeoutMs = CONNECTION_TIMEOUT_MS) => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ reachable: true });
      }
    });

    socket.on('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ reachable: false, reason: 'timeout' });
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve({ reachable: false, reason: err.code || 'connection_refused' });
      }
    });

    try {
      socket.connect(port, host);
    } catch (err) {
      if (!settled) {
        settled = true;
        resolve({ reachable: false, reason: err.message });
      }
    }
  });
};

/**
 * Tests Hikvision ISAPI endpoint with authentication.
 * Never embeds credentials into the URL. Uses standard HTTP Authorization headers.
 */
const testIsapiEndpoint = async (host, port, useHttps, username, password) => {
  const protocol = useHttps ? 'https' : 'http';
  const url = `${protocol}://${host}:${port}/ISAPI/System/deviceInfo`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

  try {
    // 1. Initial probe (without auth) to verify ISAPI presence and challenge type
    const initialRes = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // If recorder asks for authentication (standard Hikvision behavior)
    if (initialRes.status === 401) {
      const authHeader = initialRes.headers.get('www-authenticate') || '';

      // Authenticated attempt using Basic credentials header
      const basicAuthToken = Buffer.from(`${username}:${password}`).toString('base64');
      const authController = new AbortController();
      const authTimeoutId = setTimeout(() => authController.abort(), CONNECTION_TIMEOUT_MS);

      const authRes = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${basicAuthToken}`
        },
        signal: authController.signal
      });

      clearTimeout(authTimeoutId);

      if (authRes.status === 200) {
        return {
          status: 'reachable',
          details: 'Hikvision ISAPI endpoint reached and authenticated',
          authStatus: 'authenticated'
        };
      }

      if (authRes.status === 401 || authRes.status === 403) {
        return {
          status: 'authentication_failed',
          details: 'Hikvision recorder responded on ISAPI port, but credentials were rejected',
          authStatus: 'rejected'
        };
      }

      return {
        status: 'unsupported',
        details: `Unexpected response status (${authRes.status}) from ISAPI endpoint`,
        authStatus: 'unknown'
      };
    }

    if (initialRes.status === 200) {
      return {
        status: 'reachable',
        details: 'Hikvision ISAPI endpoint reached without auth barrier',
        authStatus: 'unrestricted'
      };
    }

    return {
      status: 'unsupported',
      details: `ISAPI endpoint returned status ${initialRes.status}`,
      authStatus: 'none'
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { status: 'unreachable', reason: 'timeout', authStatus: 'unreachable' };
    }
    return { status: 'unreachable', reason: err.code || 'request_failed', authStatus: 'unreachable' };
  }
};

/**
 * Main connection test coordinator with step-by-step diagnostics.
 */
const testConnection = async (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = cameraService.getShopRaw(normalizedId);

  if (!shop) {
    return { error: 'SHOP_NOT_FOUND' };
  }

  // Rate Limiting check
  const now = Date.now();
  const lastTest = rateLimitMap.get(normalizedId);
  if (lastTest && now - lastTest < RATE_LIMIT_WINDOW_MS) {
    return {
      isRateLimited: true,
      error: 'RATE_LIMIT_EXCEEDED',
      details: 'Connection test rate limit exceeded; please wait a moment before re-testing'
    };
  }
  rateLimitMap.set(normalizedId, now);

  const timestamp = new Date().toISOString();

  // Diagnostics object reported per step
  const diagnostics = {
    dnsResolution: { status: 'not_configured', details: null },
    networkReachability: { status: 'skipped', details: null },
    isapiResponse: { status: 'skipped', details: null },
    authentication: { status: 'skipped', details: null }
  };

  // 1. Verify Configuration Completeness
  if (!shop.isEnabled) {
    const result = {
      status: 'not_configured',
      details: 'Camera is currently disabled in configuration',
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  if (!isValidHost(shop.host)) {
    const result = {
      status: 'not_configured',
      details: 'No valid host or IP address configured for this shop',
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  // DNS Resolution Step
  const dnsResult = await resolveDns(shop.host);
  diagnostics.dnsResolution = dnsResult;
  if (dnsResult.status === 'failed') {
    const result = {
      status: 'unreachable',
      details: `Hostname "${shop.host}" could not be resolved: ${dnsResult.details}`,
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  // Credentials lookup
  const userKey = shop.credentialEnv?.userKey || `SHOP_${normalizedId.toUpperCase()}_USER`;
  const passKey = shop.credentialEnv?.passKey || `SHOP_${normalizedId.toUpperCase()}_PASS`;
  const username = process.env[userKey];
  const password = process.env[passKey];

  if (!username || !password || username.trim() === '' || password.trim() === '') {
    const result = {
      status: 'not_configured',
      details: 'Recorder credentials (username or password) missing in environment',
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  // 2. Network Reachability Test
  const httpPort = shop.ports?.httpPort || (shop.ports?.useHttps ? 443 : 80);
  const serverPort = shop.ports?.serverPort || 8000;

  // Test the HTTP port first (needed for ISAPI communication)
  const targetHost = dnsResult.ip || shop.host;
  const httpTcpResult = await testTcpReachability(targetHost, httpPort);

  if (httpTcpResult.reachable) {
    const serverTcpResult = await testTcpReachability(targetHost, serverPort);
    diagnostics.networkReachability = {
      status: 'reachable',
      port: httpPort,
      httpPort: { port: httpPort, reachable: true },
      managementPort: { port: serverPort, reachable: serverTcpResult.reachable }
    };

    // Port is open: execute ISAPI protocol test
    const isapiResult = await testIsapiEndpoint(
      targetHost,
      httpPort,
      shop.ports?.useHttps || false,
      username,
      password
    );

    diagnostics.isapiResponse = { status: isapiResult.status === 'unreachable' ? 'unreachable' : 'detected' };
    diagnostics.authentication = { status: isapiResult.authStatus || isapiResult.status };

    let finalDetails = isapiResult.details;
    if (isapiResult.status === 'reachable' && shop.isChannelZero) {
      finalDetails += ' (Channel Zero configured; separate composite verification required)';
    }

    const result = {
      status: isapiResult.status,
      details: finalDetails,
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  // HTTP port was not reachable
  // Check management port (8000)
  const serverTcpResult = await testTcpReachability(targetHost, serverPort);

  if (serverTcpResult.reachable) {
    diagnostics.networkReachability = {
      status: 'partial',
      port: httpPort,
      httpPort: { port: httpPort, reachable: false, reason: httpTcpResult.reason },
      managementPort: { port: serverPort, reachable: true },
      details: `Management port (${serverPort}) open, but HTTP port (${httpPort}) closed`
    };
    const result = {
      status: 'unsupported',
      details: `Management port (${serverPort}) responded, but HTTP ISAPI port (${httpPort}) is closed or unreachable`,
      testedAt: timestamp,
      diagnostics
    };
    cameraService.updateTestResult(normalizedId, result);
    return result;
  }

  // Both ports unreachable
  diagnostics.networkReachability = {
    status: 'unreachable',
    port: httpPort,
    httpPort: { port: httpPort, reachable: false, reason: httpTcpResult.reason },
    managementPort: { port: serverPort, reachable: false, reason: serverTcpResult.reason }
  };
  const result = {
    status: 'unreachable',
    details: `Could not reach recorder at host ${shop.host}:${httpPort} (${httpTcpResult.reason})`,
    testedAt: timestamp,
    diagnostics
  };
  cameraService.updateTestResult(normalizedId, result);
  return result;
};

/**
 * Safely discovers or verifies camera channels on a reachable recorder without guessing.
 */
const discoverChannels = async (shopId) => {
  const normalizedId = String(shopId).toLowerCase();
  const shop = cameraService.getShopRaw(normalizedId);

  if (!shop) {
    return { error: 'SHOP_NOT_FOUND' };
  }

  // Special handling for Edgeware Channel Zero
  if (shop.isChannelZero) {
    return {
      shopId: normalizedId,
      channelType: 'channel_zero',
      verified: true,
      channelId: 0,
      details: 'Channel Zero composite channel (channel 0) configured. Hardware support will be verified on live connection.'
    };
  }

  if (!shop.host || !isValidHost(shop.host)) {
    return {
      shopId: normalizedId,
      verified: false,
      status: 'not_configured',
      details: 'Host is not configured. Manual verification required.'
    };
  }

  const userKey = shop.credentialEnv?.userKey || `SHOP_${normalizedId.toUpperCase()}_USER`;
  const passKey = shop.credentialEnv?.passKey || `SHOP_${normalizedId.toUpperCase()}_PASS`;
  const username = process.env[userKey];
  const password = process.env[passKey];

  if (!username || !password) {
    return {
      shopId: normalizedId,
      verified: false,
      status: 'not_configured',
      details: 'Credentials missing in environment. Manual verification required.'
    };
  }

  const httpPort = shop.ports?.httpPort || 80;
  const protocol = shop.ports?.useHttps ? 'https' : 'http';
  const url = `${protocol}://${shop.host}:${httpPort}/ISAPI/Streaming/channels`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

  try {
    const basicAuthToken = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${basicAuthToken}` },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 403) {
      return {
        shopId: normalizedId,
        verified: false,
        status: 'authentication_failed',
        details: 'Authentication rejected during channel discovery. Manual verification required.'
      };
    }

    if (res.ok) {
      const xml = await res.text();
      // Extract numeric channel IDs safely from XML <id> tags
      const matches = [...xml.matchAll(/<id>(\d+)<\/id>/g)].map((m) => parseInt(m[1], 10));
      const uniqueChannels = [...new Set(matches)];

      // Extract streaming channels with their input channel mappings
      const streamingChannels = [];
      const stMatches = [...xml.matchAll(/<StreamingChannel[\s\S]*?<\/StreamingChannel>/g)];
      for (const m of stMatches) {
        const stXml = m[0];
        const id = parseInt(stXml.match(/<id>(\d+)<\/id>/)?.[1], 10);
        const name = stXml.match(/<channelName>([^<]+)<\/channelName>/)?.[1];
        const vInput = parseInt(stXml.match(/<videoInputChannelID>(\d+)<\/videoInputChannelID>/)?.[1], 10);
        if (!isNaN(id)) {
          streamingChannels.push({ id, name: name || null, videoInputChannelId: !isNaN(vInput) ? vInput : null });
        }
      }

      // Query Video Input Channels to obtain configured camera names (e.g., Camera 01, Camera 05)
      let inputChannels = [];
      try {
        const inputUrl = `${protocol}://${shop.host}:${httpPort}/ISAPI/System/Video/inputs/channels`;
        const inController = new AbortController();
        const inTimeoutId = setTimeout(() => inController.abort(), CONNECTION_TIMEOUT_MS);
        const inputRes = await fetch(inputUrl, {
          method: 'GET',
          headers: { Authorization: `Basic ${basicAuthToken}` },
          signal: inController.signal
        });
        clearTimeout(inTimeoutId);
        if (inputRes.ok) {
          const inputXml = await inputRes.text();
          const inMatches = [...inputXml.matchAll(/<VideoInputChannel[\s\S]*?<\/VideoInputChannel>/g)];
          for (const m of inMatches) {
            const inXml = m[0];
            const inId = parseInt(inXml.match(/<id>(\d+)<\/id>/)?.[1], 10);
            const inName = inXml.match(/<name>([^<]+)<\/name>/)?.[1];
            const inResDesc = inXml.match(/<resDesc>([^<]+)<\/resDesc>/)?.[1];
            if (!isNaN(inId)) {
              inputChannels.push({ id: inId, name: inName || null, resolution: inResDesc || null });
            }
          }
        }
      } catch (err) {
        // Fallback gracefully if video inputs endpoint is not supported
      }

      return {
        shopId: normalizedId,
        verified: uniqueChannels.length > 0,
        availableChannels: uniqueChannels,
        inputChannels: inputChannels.length > 0 ? inputChannels : undefined,
        streamingChannels: streamingChannels.length > 0 ? streamingChannels : undefined,
        manualVerificationRequired: uniqueChannels.length > 1,
        details: uniqueChannels.length > 0
          ? `Discovered ${uniqueChannels.length} available channels: [${uniqueChannels.join(', ')}].`
          : 'Channel list endpoint responded but returned no recognizable channel IDs.'
      };
    }

    return {
      shopId: normalizedId,
      verified: false,
      manualVerificationRequired: true,
      details: `ISAPI channel discovery endpoint returned status ${res.status}. Manual channel verification required.`
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      shopId: normalizedId,
      verified: false,
      manualVerificationRequired: true,
      details: `Could not reach recorder for channel discovery (${err.message}). Manual verification required.`
    };
  }
};

/**
 * Resets rate limit map (useful for test isolation).
 */
const resetRateLimits = () => {
  rateLimitMap.clear();
};

module.exports = {
  testConnection,
  discoverChannels,
  resolveDns,
  resetRateLimits
};
