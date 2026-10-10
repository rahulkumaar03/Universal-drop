const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const config = require('./config');
const { getNetworkInterfaces, getPrimaryLocalIp } = require('./network');
const sessionManager = require('./session');
const transferEngine = require('./transfer');
const { sanitizeFilename } = require('./security');
const { listReceivedFiles } = require('./storage');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('WebSocket Server error:', err.message);
  }
});

let selectedNetworkIp = null;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Store connected WebSocket clients
const clients = {
  pc: new Set(),
  mobile: new Set()
};

// Queue of recent outgoing file offers for mobile
const recentFileOffers = [];

function broadcastToPc(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const ws of clients.pc) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastToMobile(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const ws of clients.mobile) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastAll(type, data) {
  broadcastToPc(type, data);
  broadcastToMobile(type, data);
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type') || 'unknown'; // 'pc' or 'mobile'
  const sessionId = url.searchParams.get('session');
  const token = url.searchParams.get('token');

  if (clientType === 'pc') {
    clients.pc.add(ws);
    // Send initial status
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        session: sessionManager.getCurrentSession(),
        deviceName: config.DEVICE_NAME,
        activeIp: getPrimaryLocalIp(selectedNetworkIp)
      }
    }));
  } else if (clientType === 'mobile') {
    clients.mobile.add(ws);
    // Deliver recent messages so phone can see prior chat
    const recentMsgs = sessionManager.getMessages();
    for (const msgItem of recentMsgs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'text:received', data: msgItem }));
      }
    }
    // Deliver any recent file offers so phone gets screenshots even after reconnect
    for (const offer of recentFileOffers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'file:offered', data: offer }));
      }
    }
  }

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      handleWsMessage(ws, clientType, msg);
    } catch (e) {
      console.error('WS parse error:', e.message);
    }
  });

  ws.on('close', () => {
    if (clientType === 'pc') clients.pc.delete(ws);
    if (clientType === 'mobile') {
      clients.mobile.delete(ws);
      if (sessionManager.currentSession && sessionManager.currentSession.status === 'connected') {
        broadcastToPc('peer:disconnected', { message: 'Phone disconnected' });
      }
    }
  });
});

function handleWsMessage(ws, clientType, msg) {
  switch (msg.type) {
    case 'text:send': {
      const { text, sender } = msg.data;
      if (!text || typeof text !== 'string') return;
      const textItem = {
        id: 'txt_' + Date.now(),
        text: text.slice(0, 50000), // Max 50KB text
        sender: sender || (clientType === 'pc' ? 'PC' : 'Mobile'),
        timestamp: Date.now()
      };
      sessionManager.addMessage(textItem);
      broadcastAll('text:received', textItem);
      break;
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    default:
      break;
  }
}

// Auth Middleware for protected transfer APIs
function requireSessionAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;

  // If request originates locally from PC dashboard, allow it
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (isLocal && req.headers['x-client-role'] === 'pc') {
    return next();
  }

  if (!sessionId || !token || !sessionManager.validateAuth(sessionId, token)) {
    return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
  }

  next();
}

// Helper: build mobile URL
function buildMobileUrl() {
  const ip = getPrimaryLocalIp(selectedNetworkIp);
  const session = sessionManager.getCurrentSession();
  return `http://${ip}:${config.PORT}/mobile/index.html?session=${session.sessionId}&token=${session.pairingToken}&pin=${session.pairingPin}`;
}

// REST Routes

// Smart root redirect
app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  if (isMobile) {
    return res.redirect('/mobile/index.html');
  }
  return res.redirect('/pc/index.html');
});

// Network adapters
app.get('/api/network/interfaces', (req, res) => {
  const interfaces = getNetworkInterfaces();
  const primary = getPrimaryLocalIp(selectedNetworkIp);
  res.json({
    interfaces,
    activeIp: primary,
    port: config.PORT,
    deviceName: config.DEVICE_NAME
  });
});

app.post('/api/network/select-ip', (req, res) => {
  const { ip } = req.body;
  selectedNetworkIp = ip;
  res.json({ success: true, activeIp: getPrimaryLocalIp(selectedNetworkIp) });
});

// Session status & QR Code
app.get('/api/session/current', async (req, res) => {
  const session = sessionManager.getCurrentSession();
  const mobileUrl = buildMobileUrl();
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      margin: 1,
      width: 280,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('QR generation error:', err);
  }

  res.json({
    session: {
      sessionId: session.sessionId,
      pairingPin: session.pairingPin,
      status: session.status,
      clientDevice: session.clientDevice,
      expiresAt: session.expiresAt
    },
    deviceName: config.DEVICE_NAME,
    activeIp: getPrimaryLocalIp(selectedNetworkIp),
    port: config.PORT,
    mobileUrl,
    qrCode: qrDataUrl
  });
});

app.post('/api/session/new', async (req, res) => {
  sessionManager.initNewSession();
  broadcastAll('session:reset', { session: sessionManager.getCurrentSession() });
  res.json({ success: true, session: sessionManager.getCurrentSession() });
});

// Mobile requests pairing approval
app.post('/api/pair/request', (req, res) => {
  const { sessionId, pairingToken, pairingPin, deviceInfo } = req.body;
  const current = sessionManager.getCurrentSession();

  let tokenMatch = pairingToken && pairingToken === current.pairingToken;
  let pinMatch = pairingPin && pairingPin.toUpperCase() === current.pairingPin.toUpperCase();

  if (!tokenMatch && !pinMatch) {
    return res.status(403).json({ success: false, error: 'Invalid pairing token or PIN' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const clientData = {
    name: deviceInfo?.name || 'Phone Device',
    type: deviceInfo?.type || 'Mobile Browser',
    userAgent: req.headers['user-agent'] || 'Unknown',
    ip: clientIp
  };

  const result = sessionManager.requestPairing(sessionId || current.sessionId, current.pairingToken, clientData);
  if (!result.success) {
    return res.status(400).json(result);
  }

  // Notify PC UI of incoming pair request
  broadcastToPc('pair:requested', {
    sessionId: current.sessionId,
    client: clientData
  });

  res.json({ success: true, status: 'pending_approval' });
});

// PC approves pairing
app.post('/api/pair/approve', (req, res) => {
  const { sessionId } = req.body;
  const result = sessionManager.approvePairing(sessionId);
  if (!result.success) {
    return res.status(400).json(result);
  }

  // Notify Mobile client with the established authToken
  broadcastToMobile('pair:approved', {
    sessionId,
    authToken: result.authToken,
    deviceName: config.DEVICE_NAME
  });

  // Notify PC that connection is active
  broadcastToPc('pair:connected', {
    sessionId,
    clientDevice: result.clientDevice
  });

  res.json({ success: true, authToken: result.authToken });
});

// PC rejects pairing
app.post('/api/pair/reject', (req, res) => {
  const { sessionId } = req.body;
  const result = sessionManager.rejectPairing(sessionId);

  broadcastToMobile('pair:rejected', {
    sessionId,
    reason: 'Connection rejected by host PC'
  });

  broadcastToPc('pair:rejected', { sessionId });
  res.json({ success: true });
});

// Disconnect
app.post('/api/pair/disconnect', (req, res) => {
  sessionManager.disconnect();
  broadcastAll('pair:disconnected', { message: 'Session disconnected' });
  res.json({ success: true });
});

// Transfer API

// 1. Negotiate transfer start
app.post('/api/transfer/start', requireSessionAuth, (req, res) => {
  const { transferId, fileName, fileSize, mimeType, chunkSize, totalChunks, expectedSha256 } = req.body;
  try {
    const transfer = transferEngine.startIncomingTransfer({
      transferId,
      fileName,
      fileSize,
      mimeType,
      chunkSize,
      totalChunks,
      expectedSha256
    });

    broadcastAll('transfer:started', {
      transferId,
      fileName: transfer.fileName,
      fileSize: transfer.fileSize,
      direction: transfer.direction
    });

    res.json({ success: true, transferId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Binary Chunk Upload
app.post('/api/transfer/chunk', requireSessionAuth, express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  const transferId = req.headers['x-transfer-id'];
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);

  if (!transferId || isNaN(chunkIndex)) {
    return res.status(400).json({ error: 'Missing x-transfer-id or x-chunk-index header' });
  }

  const chunkBuffer = req.body;
  if (!chunkBuffer || chunkBuffer.length === 0) {
    return res.status(400).json({ error: 'Empty chunk body' });
  }

  try {
    const progress = await transferEngine.appendChunk(transferId, chunkIndex, chunkBuffer);

    // Broadcast progress update
    broadcastAll('transfer:progress', progress);

    res.json({ success: true, progress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Finalize Transfer & Integrity Check
app.post('/api/transfer/complete', requireSessionAuth, async (req, res) => {
  const { transferId, sha256: clientSha256 } = req.body;
  try {
    const result = await transferEngine.completeIncomingTransfer(transferId, clientSha256);

    broadcastAll('transfer:completed', {
      transferId,
      fileName: result.fileName,
      fileSize: result.fileSize,
      sha256: result.sha256
    });

    res.json(result);
  } catch (err) {
    broadcastAll('transfer:failed', {
      transferId,
      error: err.message
    });
    res.status(400).json({ error: err.message });
  }
});

// 4. Cancel Transfer
app.post('/api/transfer/cancel', requireSessionAuth, (req, res) => {
  const { transferId } = req.body;
  const ok = transferEngine.cancelTransfer(transferId);
  if (ok) {
    broadcastAll('transfer:cancelled', { transferId });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Transfer not found or already ended' });
  }
});

// 5. Send file from PC to Phone (PC initiates upload into outgoing queue)
app.post('/api/pc/send-file', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  const rawFileName = req.headers['x-file-name'] || 'file.bin';
  const fileName = decodeURIComponent(rawFileName);
  const mimeType = req.headers['x-mime-type'] || req.headers['content-type'] || 'application/octet-stream';
  const safeName = sanitizeFilename(fileName);
  const fileId = 'out_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const tempPath = path.join(config.TEMP_DIR, `outgoing_${fileId}_${safeName}`);

  // Guarantee valid Buffer write
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  fs.writeFileSync(tempPath, buffer);
  const meta = transferEngine.prepareOutgoingFile(fileId, tempPath, safeName, buffer.length, mimeType);

  const offerData = {
    fileId: meta.id,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    mimeType: meta.mimeType,
    sha256: meta.sha256,
    downloadUrl: `/api/files/download/${meta.id}`,
    timestamp: Date.now()
  };

  recentFileOffers.push(offerData);
  if (recentFileOffers.length > 25) recentFileOffers.shift();

  // Notify Phone client that a file is available to download
  broadcastToMobile('file:offered', offerData);

  sessionManager.recordHistory({
    id: meta.id,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    direction: 'outgoing',
    status: 'completed',
    sha256: meta.sha256
  });

  broadcastToPc('history:updated', { history: sessionManager.getHistory() });

  res.json({ success: true, file: meta, offer: offerData });
});

// Endpoint for mobile to fetch recent/pending file offers
app.get('/api/files/pending', (req, res) => {
  res.json({ files: recentFileOffers });
});

// Download endpoint for received files or outgoing files
app.get('/api/files/download/:idOrName', (req, res) => {
  const idOrName = req.params.idOrName;

  // Check if it's an outgoing prepared file
  const outgoing = transferEngine.getOutgoingFile(idOrName);
  if (outgoing && fs.existsSync(outgoing.filePath)) {
    const isImage = (outgoing.mimeType && outgoing.mimeType.startsWith('image/')) ||
                    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(outgoing.fileName);
    const dispositionType = (req.query.download === '1' || !isImage) ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(outgoing.fileName)}"`);
    res.setHeader('Content-Type', outgoing.mimeType || 'application/octet-stream');
    return fs.createReadStream(outgoing.filePath).pipe(res);
  }

  // Check received files directory
  const safeName = sanitizeFilename(idOrName);
  const receivedPath = path.join(config.RECEIVED_DIR, safeName);
  if (fs.existsSync(receivedPath)) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return fs.createReadStream(receivedPath).pipe(res);
  }

  res.status(404).send('File not found');
});

// Open received directory in Windows Explorer (Local PC only)
app.post('/api/files/open-folder', (req, res) => {
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { exec } = require('child_process');
  exec(`explorer.exe "${config.RECEIVED_DIR}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// List received files
app.get('/api/files/received', (req, res) => {
  res.json({ files: listReceivedFiles() });
});

// History endpoint
app.get('/api/history', (req, res) => {
  res.json({ history: sessionManager.getHistory() });
});

app.post('/api/history/clear', (req, res) => {
  sessionManager.clearHistory();
  broadcastToPc('history:updated', { history: [] });
  res.json({ success: true });
});

// Messages & Instant Chat endpoints
app.get('/api/messages', (req, res) => {
  res.json({ messages: sessionManager.getMessages() });
});

app.post('/api/messages/clear', (req, res) => {
  sessionManager.clearMessages();
  broadcastAll('messages:cleared', {});
  res.json({ success: true });
});

// Start listening
function startServer(port = config.PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      const activeIp = getPrimaryLocalIp();
      console.log(`\n======================================================`);
      console.log(`  UniversalDrop Desktop Agent running!`);
      console.log(`  PC Web Dashboard:   http://localhost:${port}/pc`);
      console.log(`  Mobile Connection:  http://${activeIp}:${port}/mobile`);
      console.log(`======================================================\n`);
      resolve({ server, port, activeIp });
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
        startServer(port + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  startServer
};
