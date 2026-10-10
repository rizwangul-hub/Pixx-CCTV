/**
 * Configuration for the six bicycle shop CCTV camera recorders.
 * Sensitive credentials (passwords, usernames) are NOT hardcoded here.
 * They are resolved securely from environment variables.
 */

const dotenv = require('dotenv');
dotenv.config();

const parsePort = (val, defaultPort) => {
  if (!val) return defaultPort;
  const parsed = parseInt(val, 10);
  return !isNaN(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : defaultPort;
};

const parseChannelId = (val, defaultVal = null) => {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return !isNaN(parsed) && parsed >= 0 ? parsed : defaultVal;
};

const defaultShops = [
  {
    id: 'camden',
    name: 'Camden',
    cameraLabel: 'Camera 01',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_CAMDEN_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_CAMDEN_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_CAMDEN_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_CAMDEN_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_CAMDEN_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_CAMDEN_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Camera 01',
      dvrChannel: parseChannelId(process.env.SHOP_CAMDEN_CHANNEL_ID, null),
      verified: Boolean(process.env.SHOP_CAMDEN_CHANNEL_ID)
    },
    credentialEnv: {
      userKey: 'SHOP_CAMDEN_USER',
      passKey: 'SHOP_CAMDEN_PASS'
    },
    streamType: 'standard',
    isChannelZero: false,
    verifiedChannelId: parseChannelId(process.env.SHOP_CAMDEN_CHANNEL_ID, null),
    isEnabled: true,
    latestTestResult: null
  },
  {
    id: 'station',
    name: 'Station',
    cameraLabel: 'Camera 05',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_STATION_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_STATION_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_STATION_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_STATION_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_STATION_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_STATION_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Camera 05',
      dvrChannel: parseChannelId(process.env.SHOP_STATION_CHANNEL_ID, null),
      verified: Boolean(process.env.SHOP_STATION_CHANNEL_ID)
    },
    credentialEnv: {
      userKey: 'SHOP_STATION_USER',
      passKey: 'SHOP_STATION_PASS'
    },
    streamType: 'standard',
    isChannelZero: false,
    verifiedChannelId: parseChannelId(process.env.SHOP_STATION_CHANNEL_ID, null),
    isEnabled: true,
    latestTestResult: null
  },
  {
    id: 'chelsea',
    name: 'Chelsea',
    cameraLabel: 'Camera 15',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_CHELSEA_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_CHELSEA_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_CHELSEA_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_CHELSEA_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_CHELSEA_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_CHELSEA_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Camera 15',
      dvrChannel: parseChannelId(process.env.SHOP_CHELSEA_CHANNEL_ID, null),
      verified: Boolean(process.env.SHOP_CHELSEA_CHANNEL_ID)
    },
    credentialEnv: {
      userKey: 'SHOP_CHELSEA_USER',
      passKey: 'SHOP_CHELSEA_PASS'
    },
    streamType: 'standard',
    isChannelZero: false,
    verifiedChannelId: parseChannelId(process.env.SHOP_CHELSEA_CHANNEL_ID, null),
    isEnabled: true,
    latestTestResult: null
  },
  {
    id: 'edgeware',
    name: 'Edgeware',
    cameraLabel: 'Channel Zero',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_EDGEWARE_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_EDGEWARE_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_EDGEWARE_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_EDGEWARE_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_EDGEWARE_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_EDGEWARE_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Channel Zero',
      dvrChannel: 0,
      verified: false
    },
    credentialEnv: {
      userKey: 'SHOP_EDGEWARE_USER',
      passKey: 'SHOP_EDGEWARE_PASS'
    },
    streamType: 'channel_zero',
    isChannelZero: true,
    verifiedChannelId: null,
    isEnabled: true,
    latestTestResult: null
  },
  {
    id: 'southwark',
    name: 'Southwark',
    cameraLabel: 'Camera 07',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_SOUTHWARK_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_SOUTHWARK_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_SOUTHWARK_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_SOUTHWARK_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_SOUTHWARK_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_SOUTHWARK_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Camera 07',
      dvrChannel: parseChannelId(process.env.SHOP_SOUTHWARK_CHANNEL_ID, null),
      verified: Boolean(process.env.SHOP_SOUTHWARK_CHANNEL_ID)
    },
    credentialEnv: {
      userKey: 'SHOP_SOUTHWARK_USER',
      passKey: 'SHOP_SOUTHWARK_PASS'
    },
    streamType: 'standard',
    isChannelZero: false,
    verifiedChannelId: parseChannelId(process.env.SHOP_SOUTHWARK_CHANNEL_ID, null),
    isEnabled: true,
    latestTestResult: null
  },
  {
    id: 'leabridge',
    name: 'Leabridge',
    cameraLabel: 'Camera 08',
    brand: 'Hikvision',
    connectionType: 'dvr_nvr',
    host: process.env.SHOP_LEABRIDGE_HOST || null,
    ports: {
      rtspPort: parsePort(process.env.SHOP_LEABRIDGE_RTSP_PORT, 554),
      serverPort: parsePort(process.env.SHOP_LEABRIDGE_SERVER_PORT, 8000),
      httpPort: parsePort(process.env.SHOP_LEABRIDGE_HTTP_PORT, 80),
      httpsPort: parsePort(process.env.SHOP_LEABRIDGE_HTTPS_PORT, 443),
      useHttps: process.env.SHOP_LEABRIDGE_USE_HTTPS === 'true'
    },
    protocol: 'isapi',
    channelMapping: {
      label: 'Camera 08',
      dvrChannel: parseChannelId(process.env.SHOP_LEABRIDGE_CHANNEL_ID, null),
      verified: Boolean(process.env.SHOP_LEABRIDGE_CHANNEL_ID)
    },
    credentialEnv: {
      userKey: 'SHOP_LEABRIDGE_USER',
      passKey: 'SHOP_LEABRIDGE_PASS'
    },
    streamType: 'standard',
    isChannelZero: false,
    verifiedChannelId: parseChannelId(process.env.SHOP_LEABRIDGE_CHANNEL_ID, null),
    isEnabled: true,
    latestTestResult: null
  }
];

module.exports = {
  defaultShops
};
