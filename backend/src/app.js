const express = require('express');
const cors = require('cors');
const healthRoutes = require('./routes/healthRoutes');
const cameraRoutes = require('./routes/cameraRoutes');
const detectionRoutes = require('./routes/detectionRoutes');

const app = express();

// Security Settings & Headers
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Support JPEG uploads while preventing memory exhaustion DoS

// Routes
app.get('/', (req, res) => {
  res.redirect('/api/workers/review-interface');
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use('/api', healthRoutes);
app.use('/api', detectionRoutes);
app.use('/api/cameras', cameraRoutes);

// 404 Not Found Handler
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

// Central Error Handler (sanitizes stack traces & internal paths in production)
app.use((err, req, res, next) => {
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const status = err.status || 500;
  const message = (status === 500 && !isDev)
    ? 'An unexpected internal error occurred'
    : (err.message || 'Internal Server Error');

  res.status(status).json({
    error: message
  });
});

module.exports = app;
