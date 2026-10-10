const crypto = require('crypto');
const { ADMIN_API_KEY } = require('../config/env');

/**
 * Constant-time string comparison to prevent timing attacks.
 */
const timingSafeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Middleware ensuring only authenticated administrators can invoke
 * protected operations.
 */
const requireAdminAuth = (req, res, next) => {
  const apiKeyHeader = req.headers['x-admin-api-key'];
  const authHeader = req.headers['authorization'];

  let token = null;

  if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token || !timingSafeEqual(token, ADMIN_API_KEY)) {
    return res.status(401).json({
      error: 'Unauthorized',
      details: 'Valid administrator API key required'
    });
  }

  next();
};

module.exports = {
  requireAdminAuth
};
