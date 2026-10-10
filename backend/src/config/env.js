const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const parsedPort = parseInt(process.env.PORT, 10);
const PORT = !isNaN(parsedPort) && parsedPort > 0 ? parsedPort : 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'pixx_admin_secret_key';

const SNAPSHOT_STORAGE_DIR = process.env.SNAPSHOT_STORAGE_DIR
  ? path.resolve(process.env.SNAPSHOT_STORAGE_DIR)
  : path.join(__dirname, '../../storage/snapshots');

const parsedRetention = parseInt(process.env.SNAPSHOT_RETENTION_HOURS, 10);
const SNAPSHOT_RETENTION_HOURS = !isNaN(parsedRetention) && parsedRetention > 0 ? parsedRetention : 72;

module.exports = {
  PORT,
  NODE_ENV,
  ADMIN_API_KEY,
  SNAPSHOT_STORAGE_DIR,
  SNAPSHOT_RETENTION_HOURS
};
