const path = require('path');
const crypto = require('crypto');

// Windows reserved filenames
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Sanitizes a client-provided filename to prevent path traversal and arbitrary filesystem writes.
 * Ensures the result is a plain basename without directory separators or dangerous characters.
 */
function sanitizeFilename(originalName) {
  if (!originalName || typeof originalName !== 'string') {
    return `received_${Date.now()}.bin`;
  }

  // Take only the basename in case paths were provided
  let clean = path.basename(originalName);

  // Remove null bytes and control characters
  clean = clean.replace(/[\x00-\x1f\x80-\x9f]/g, '');

  // Remove directory traversal tokens
  clean = clean.replace(/\.\.+/g, '.');

  // Strip invalid characters for Windows & POSIX: < > : " / \ | ? *
  clean = clean.replace(/[<>:"/\\|?*]/g, '_');

  // Strip leading/trailing spaces and dots
  clean = clean.trim().replace(/^\.+/, '').replace(/\.+$/, '');

  // Check if reserved Windows name
  if (RESERVED_NAMES.test(clean) || clean.length === 0) {
    clean = `file_${clean}_${Date.now()}`;
  }

  // Enforce reasonable length limit (max 200 chars while preserving extension)
  if (clean.length > 200) {
    const ext = path.extname(clean);
    const base = path.basename(clean, ext);
    clean = base.slice(0, 200 - ext.length) + ext;
  }

  return clean || `received_${Date.now()}.bin`;
}

/**
 * Generates high-entropy cryptographic token
 */
function generateSecureToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Generates an easy-to-read 6-digit alphanumeric pairing PIN as a human backup
 */
function generatePairingPin() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Avoid confusing 0/O, 1/I
  let pin = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    pin += chars[bytes[i] % chars.length];
  }
  return pin;
}

/**
 * Computes SHA-256 hash of a buffer
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Safe timing-safe comparison to prevent timing attacks
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  sanitizeFilename,
  generateSecureToken,
  generatePairingPin,
  sha256,
  safeCompare
};
