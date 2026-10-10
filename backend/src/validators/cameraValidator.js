const ALLOWED_UPDATE_FIELDS = [
  'isEnabled',
  'cameraLabel',
  'host',
  'connectionType',
  'ports',
  'streamType',
  'verifiedChannelId'
];

const ALLOWED_CONNECTION_TYPES = ['dvr_nvr', 'rtsp', 'ip'];
const ALLOWED_STREAM_TYPES = ['standard', 'channel_zero', 'sub_stream', 'main_stream'];

const isValidPort = (port) => {
  if (typeof port !== 'number' || !Number.isInteger(port)) return false;
  return port >= 1 && port <= 65535;
};

const validateCameraUpdate = (data) => {
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      isValid: false,
      errors: ['Request body must be a JSON object']
    };
  }

  const keys = Object.keys(data);
  if (keys.length === 0) {
    return {
      isValid: false,
      errors: ['At least one field must be provided for update']
    };
  }

  // Check for unauthorized / unpermitted fields
  const unpermittedKeys = keys.filter((key) => !ALLOWED_UPDATE_FIELDS.includes(key));
  if (unpermittedKeys.length > 0) {
    errors.push(`Unpermitted or protected fields cannot be updated: ${unpermittedKeys.join(', ')}`);
  }

  if (data.isEnabled !== undefined && typeof data.isEnabled !== 'boolean') {
    errors.push('Field "isEnabled" must be a boolean');
  }

  if (data.cameraLabel !== undefined) {
    if (typeof data.cameraLabel !== 'string' || data.cameraLabel.trim().length === 0) {
      errors.push('Field "cameraLabel" must be a non-empty string');
    }
  }

  if (data.host !== undefined && data.host !== null) {
    if (typeof data.host !== 'string' || data.host.trim().length === 0) {
      errors.push('Field "host" must be a non-empty string or null');
    }
  }

  if (data.connectionType !== undefined) {
    if (!ALLOWED_CONNECTION_TYPES.includes(data.connectionType)) {
      errors.push(`Field "connectionType" must be one of: ${ALLOWED_CONNECTION_TYPES.join(', ')}`);
    }
  }

  if (data.streamType !== undefined) {
    if (!ALLOWED_STREAM_TYPES.includes(data.streamType)) {
      errors.push(`Field "streamType" must be one of: ${ALLOWED_STREAM_TYPES.join(', ')}`);
    }
  }

  if (data.verifiedChannelId !== undefined && data.verifiedChannelId !== null) {
    if (typeof data.verifiedChannelId !== 'number' || data.verifiedChannelId < 0) {
      errors.push('Field "verifiedChannelId" must be a non-negative number or null');
    }
  }

  if (data.ports !== undefined) {
    if (typeof data.ports !== 'object' || data.ports === null || Array.isArray(data.ports)) {
      errors.push('Field "ports" must be an object');
    } else {
      const allowedPortKeys = ['rtspPort', 'serverPort', 'httpPort'];
      const portKeys = Object.keys(data.ports);

      const invalidPortKeys = portKeys.filter((k) => !allowedPortKeys.includes(k));
      if (invalidPortKeys.length > 0) {
        errors.push(`Invalid port settings: ${invalidPortKeys.join(', ')}`);
      }

      if (data.ports.rtspPort !== undefined && !isValidPort(data.ports.rtspPort)) {
        errors.push('Field "ports.rtspPort" must be a valid port number between 1 and 65535');
      }

      if (data.ports.serverPort !== undefined && !isValidPort(data.ports.serverPort)) {
        errors.push('Field "ports.serverPort" must be a valid port number between 1 and 65535');
      }

      if (data.ports.httpPort !== undefined && !isValidPort(data.ports.httpPort)) {
        errors.push('Field "ports.httpPort" must be a valid port number between 1 and 65535');
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

module.exports = {
  validateCameraUpdate
};
