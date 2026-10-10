const path = require('path');
const os = require('os');

module.exports = {
  PORT: process.env.PORT || 5274,
  DEVICE_NAME: process.env.DEVICE_NAME || `${os.hostname()} (Windows)`,
  RECEIVED_DIR: path.join(__dirname, '..', 'received_files'),
  TEMP_DIR: path.join(os.tmpdir(), 'universaldrop-temp'),
  DEFAULT_CHUNK_SIZE: 64 * 1024, // 64 KB per chunk for high throughput & responsive progress
  MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024, // 5 GB limit for safety in MVP
  SESSION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes session inactivity
  PAIRING_CODE_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes to scan and pair
  MAX_CONCURRENT_TRANSFERS: 4,
  MAX_RECENT_HISTORY: 100,
  MAX_PAIRING_ATTEMPTS: 5,
  PAIRING_LOCKOUT_MS: 2 * 60 * 1000,
  TRANSFER_IDLE_TIMEOUT_MS: 60 * 1000,
  TEMP_FILE_MAX_AGE_MS: 60 * 60 * 1000,
  MAX_CHUNK_SIZE: 2 * 1024 * 1024,
  MAX_TEXT_LENGTH: 50000,
  MAX_JSON_BODY_SIZE: '100kb'
};
