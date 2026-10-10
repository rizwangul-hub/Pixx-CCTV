const express = require('express');
const {
  getAllCameras,
  getCameraById,
  getCameraStatus,
  updateCamera,
  testCameraConnection,
  captureSnapshot,
  listShopSnapshots,
  getShopSnapshot,
  deleteShopSnapshot,
  discoverShopChannels
} = require('../controllers/cameraController');
const { requireAdminAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', getAllCameras);
router.get('/:shopId', getCameraById);
router.get('/:shopId/status', getCameraStatus);
router.patch('/:shopId', updateCamera);
router.post('/:shopId/test-connection', requireAdminAuth, testCameraConnection);
router.get('/:shopId/channels/discover', requireAdminAuth, discoverShopChannels);

// Snapshot Endpoints (Protected by Admin Auth)
router.post('/:shopId/snapshot', requireAdminAuth, captureSnapshot);
router.get('/:shopId/snapshots', requireAdminAuth, listShopSnapshots);
router.get('/:shopId/snapshots/:eventId', requireAdminAuth, getShopSnapshot);
router.delete('/:shopId/snapshots/:eventId', requireAdminAuth, deleteShopSnapshot);

module.exports = router;
