const config = require('./config');
const { generateSecureToken, generatePairingPin, safeCompare } = require('./security');

class SessionManager {
  constructor() {
    this.currentSession = null;
    this.history = [];
    this.initNewSession();
  }

  initNewSession() {
    const now = Date.now();
    this.currentSession = {
      sessionId: 'sess_' + generateSecureToken(16),
      pairingToken: generateSecureToken(32),
      pairingPin: generatePairingPin(),
      authToken: null,
      status: 'waiting_for_scan', // 'waiting_for_scan', 'pending_approval', 'connected', 'rejected', 'expired'
      clientDevice: null,
      createdAt: now,
      expiresAt: now + config.PAIRING_CODE_TIMEOUT_MS,
      lastActivityAt: now
    };
    return this.currentSession;
  }

  getCurrentSession() {
    if (!this.currentSession) {
      return this.initNewSession();
    }
    // Check if session has expired
    if (Date.now() > this.currentSession.expiresAt && this.currentSession.status !== 'connected') {
      this.currentSession.status = 'expired';
    }
    return this.currentSession;
  }

  requestPairing(sessionId, pairingToken, clientInfo = {}) {
    const session = this.currentSession;
    if (!session || session.sessionId !== sessionId) {
      return { success: false, reason: 'Invalid or obsolete session ID' };
    }

    if (Date.now() > session.expiresAt && session.status !== 'connected') {
      session.status = 'expired';
      return { success: false, reason: 'Pairing session has expired. Please refresh the QR code.' };
    }

    if (!safeCompare(session.pairingToken, pairingToken)) {
      return { success: false, reason: 'Invalid pairing token' };
    }

    session.status = 'pending_approval';
    session.clientDevice = {
      name: clientInfo.name || 'Mobile Browser',
      type: clientInfo.type || 'Phone',
      userAgent: clientInfo.userAgent || 'Unknown',
      ip: clientInfo.ip || 'Unknown',
      requestedAt: Date.now()
    };

    return { success: true, session };
  }

  approvePairing(sessionId) {
    const session = this.currentSession;
    if (!session || session.sessionId !== sessionId) {
      return { success: false, reason: 'Session not found' };
    }

    if (session.status !== 'pending_approval') {
      return { success: false, reason: `Cannot approve session in '${session.status}' state` };
    }

    session.status = 'connected';
    session.authToken = generateSecureToken(32);
    // Single-use token security: invalidate pairing token upon connection
    session.pairingToken = null;
    session.expiresAt = Date.now() + config.SESSION_TIMEOUT_MS;
    session.lastActivityAt = Date.now();

    return {
      success: true,
      authToken: session.authToken,
      clientDevice: session.clientDevice
    };
  }

  rejectPairing(sessionId) {
    const session = this.currentSession;
    if (!session || session.sessionId !== sessionId) {
      return { success: false, reason: 'Session not found' };
    }

    session.status = 'rejected';
    session.authToken = null;
    session.pairingToken = null;
    session.pairingPin = null;
    return { success: true };
  }

  disconnect() {
    if (this.currentSession) {
      this.currentSession.status = 'disconnected';
      this.currentSession.authToken = null;
    }
    return this.initNewSession();
  }

  validateAuth(sessionId, authToken) {
    const session = this.currentSession;
    if (!session || session.sessionId !== sessionId) return false;
    if (session.status !== 'connected') return false;
    if (!session.authToken || !safeCompare(session.authToken, authToken)) return false;

    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      return false;
    }

    // Touch session
    this.touch();
    return true;
  }

  touch() {
    if (this.currentSession && this.currentSession.status === 'connected') {
      this.currentSession.lastActivityAt = Date.now();
      this.currentSession.expiresAt = Date.now() + config.SESSION_TIMEOUT_MS;
    }
  }

  recordHistory(transferRecord) {
    this.history.unshift({
      id: transferRecord.id,
      fileName: transferRecord.fileName,
      fileSize: transferRecord.fileSize,
      direction: transferRecord.direction, // 'incoming' (Phone -> PC) or 'outgoing' (PC -> Phone)
      status: transferRecord.status, // 'completed', 'cancelled', 'failed'
      timestamp: Date.now(),
      sha256: transferRecord.sha256 || null,
      device: this.currentSession?.clientDevice?.name || 'Mobile'
    });

    if (this.history.length > config.MAX_RECENT_HISTORY) {
      this.history.pop();
    }
  }

  getHistory() {
    return this.history;
  }

  clearHistory() {
    this.history = [];
    return true;
  }

  addMessage(message) {
    if (!this.messages) this.messages = [];
    this.messages.push(message);
    if (this.messages.length > 100) this.messages.shift();
    return message;
  }

  getMessages() {
    return this.messages || [];
  }

  clearMessages() {
    this.messages = [];
    return true;
  }
}

module.exports = new SessionManager();
