const fs = require('fs');
const cameraService = require('../services/cameraService');
const hikvisionService = require('../services/hikvisionService');
const snapshotService = require('../services/snapshotService');
const { validateCameraUpdate } = require('../validators/cameraValidator');

const getAllCameras = (req, res, next) => {
  try {
    const cameras = cameraService.getAllCameras();
    res.status(200).json({
      count: cameras.length,
      cameras
    });
  } catch (error) {
    next(error);
  }
};

const getCameraById = (req, res, next) => {
  try {
    const { shopId } = req.params;
    const camera = cameraService.getCameraById(shopId);

    if (!camera) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    res.status(200).json({
      camera
    });
  } catch (error) {
    next(error);
  }
};

const getCameraStatus = (req, res, next) => {
  try {
    const { shopId } = req.params;
    const statusResult = cameraService.getCameraStatus(shopId);

    if (!statusResult) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    const response = {
      shopId: shopId.toLowerCase(),
      status: statusResult.status,
      details: statusResult.details
    };

    if (statusResult.testedAt) {
      response.testedAt = statusResult.testedAt;
    }

    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

const updateCamera = (req, res, next) => {
  try {
    const { shopId } = req.params;

    const validation = validateCameraUpdate(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors
      });
    }

    const updated = cameraService.updateCamera(shopId, req.body);
    if (!updated) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    res.status(200).json({
      message: 'Camera configuration updated successfully',
      camera: updated
    });
  } catch (error) {
    next(error);
  }
};

const testCameraConnection = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const testResult = await hikvisionService.testConnection(shopId);

    if (testResult.error === 'SHOP_NOT_FOUND') {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    if (testResult.isRateLimited) {
      return res.status(429).json({
        error: 'Too Many Requests',
        details: testResult.details
      });
    }

    res.status(200).json({
      shopId: shopId.toLowerCase(),
      status: testResult.status,
      details: testResult.details,
      testedAt: testResult.testedAt,
      diagnostics: testResult.diagnostics
    });
  } catch (error) {
    next(error);
  }
};

const captureSnapshot = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const result = await snapshotService.captureSnapshot(shopId);

    if (result.error === 'SHOP_NOT_FOUND') {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    if (result.isRateLimited) {
      return res.status(429).json({
        error: 'Too Many Requests',
        details: result.details
      });
    }

    if (result.status === 'success') {
      return res.status(201).json({
        message: 'Snapshot captured successfully',
        event: result.event
      });
    }

    // Return safe failure metadata without exposing filesystem or credentials
    res.status(200).json({
      shopId: shopId.toLowerCase(),
      status: result.status,
      details: result.details,
      captureStatus: 'failed'
    });
  } catch (error) {
    next(error);
  }
};

const listShopSnapshots = (req, res, next) => {
  try {
    const { shopId } = req.params;
    const camera = cameraService.getCameraById(shopId);

    if (!camera) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    const snapshots = snapshotService.listSnapshotsByShop(shopId);
    res.status(200).json({
      shopId: shopId.toLowerCase(),
      count: snapshots.length,
      snapshots
    });
  } catch (error) {
    next(error);
  }
};

const getShopSnapshot = (req, res, next) => {
  try {
    const { shopId, eventId } = req.params;
    const camera = cameraService.getCameraById(shopId);

    if (!camera) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    // Check if client requests binary image content
    const wantsImage = req.headers.accept?.includes('image/jpeg') || req.query.raw === 'true';

    if (wantsImage) {
      const filePath = snapshotService.getSnapshotFilePath(eventId);
      if (!filePath) {
        return res.status(404).json({
          error: 'Snapshot file not found'
        });
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      return fs.createReadStream(filePath).pipe(res);
    }

    const event = snapshotService.getSnapshotEvent(eventId);
    if (!event || event.shopId !== shopId.toLowerCase()) {
      return res.status(404).json({
        error: 'Snapshot not found'
      });
    }

    res.status(200).json({
      snapshot: event
    });
  } catch (error) {
    next(error);
  }
};

const deleteShopSnapshot = (req, res, next) => {
  try {
    const { shopId, eventId } = req.params;
    const camera = cameraService.getCameraById(shopId);

    if (!camera) {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    const result = snapshotService.deleteSnapshot(eventId);
    if (!result) {
      return res.status(404).json({
        error: 'Snapshot not found'
      });
    }

    res.status(200).json({
      message: 'Snapshot deleted successfully',
      eventId
    });
  } catch (error) {
    next(error);
  }
};

const discoverShopChannels = async (req, res, next) => {
  try {
    const { shopId } = req.params;
    const result = await hikvisionService.discoverChannels(shopId);

    if (result.error === 'SHOP_NOT_FOUND') {
      return res.status(404).json({
        error: 'Shop not found'
      });
    }

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

module.exports = {
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
};
