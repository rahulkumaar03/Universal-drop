// UniversalDrop Phone Browser Client Logic
const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk for high throughput & backpressure

const STORAGE_KEY_AUTH = 'universaldrop_mobile_auth';
const STORAGE_KEY_SESSION = 'universaldrop_mobile_session';
const STORAGE_KEY_HOST = 'universaldrop_mobile_host';

let sessionId = null;
let pairingToken = null;
let pairingPin = null;
let authToken = null;
let ws = null;
let reconnectTimer = null;
let activeTransferAbort = false;
let currentTransferId = null;
const receivedFileIds = new Set();
const receivedTextIds = new Set();

// DOM
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const pairingView = document.getElementById('pairingView');
const connectedView = document.getElementById('connectedView');
const handshakeTitle = document.getElementById('handshakeTitle');
const handshakeDesc = document.getElementById('handshakeDesc');
const pinFallbackForm = document.getElementById('pinFallbackForm');
const manualPinInput = document.getElementById('manualPinInput');
const btnSubmitPin = document.getElementById('btnSubmitPin');
const hostDeviceName = document.getElementById('hostDeviceName');
const btnMobileDisconnect = document.getElementById('btnMobileDisconnect');

// Send Actions
const mobilePhotoPicker = document.getElementById('mobilePhotoPicker');
const mobileFilePicker = document.getElementById('mobileFilePicker');
const mobileTextInput = document.getElementById('mobileTextInput');
const btnMobileSendText = document.getElementById('btnMobileSendText');

// Progress Card
const transferCard = document.getElementById('transferCard');
const transferFileName = document.getElementById('transferFileName');
const transferFileSize = document.getElementById('transferFileSize');
const transferBar = document.getElementById('transferBar');
const transferPercent = document.getElementById('transferPercent');
const transferSpeed = document.getElementById('transferSpeed');
const transferEta = document.getElementById('transferEta');
const btnMobileCancel = document.getElementById('btnMobileCancel');

// Received List
const mobileReceivedList = document.getElementById('mobileReceivedList');
const mobileToast = document.getElementById('mobileToast');

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  parseUrlParams();
  setupListeners();

  // Restore saved session if user reloaded or reconnects
  const savedToken = sessionStorage.getItem(STORAGE_KEY_AUTH);
  const savedSession = sessionStorage.getItem(STORAGE_KEY_SESSION);
  const savedHost = sessionStorage.getItem(STORAGE_KEY_HOST);

  if (savedToken && (!sessionId || sessionId === savedSession)) {
    authToken = savedToken;
    if (savedSession) sessionId = savedSession;
    if (savedHost) hostDeviceName.textContent = savedHost;
    pairingView.classList.add('hidden');
    connectedView.classList.remove('hidden');
    statusDot.className = 'status-indicator connected';
    statusText.textContent = 'Connected';
  }

  initWebSocket();

  if (!authToken) {
    if (sessionId && pairingToken) {
      requestPairingWithToken(sessionId, pairingToken);
    } else {
      handshakeTitle.textContent = 'Pair with PC';
      handshakeDesc.textContent = 'Scan the QR code on your PC screen, or enter the 6-digit PIN below.';
      pinFallbackForm.classList.remove('hidden');
      statusText.textContent = 'Ready';
    }
  } else {
    fetchPendingFiles();
  }
});

function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  sessionId = params.get('session');
  pairingToken = params.get('token');
  pairingPin = params.get('pin');
}

// WebSocket Connection with Auto-reconnect
function initWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${protocol}//${window.location.host}/ws?type=mobile`;
  if (sessionId && authToken) {
    wsUrl += `&session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(authToken)}`;
  }

  try {
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Mobile WS connected');
      if (authToken) {
        statusDot.className = 'status-indicator connected';
        statusText.textContent = 'Connected';
      }
      fetchPendingFiles();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.onclose = () => {
      if (authToken) {
        statusDot.className = 'status-indicator';
        statusText.textContent = 'Reconnecting...';
      } else {
        statusDot.className = 'status-indicator';
        statusText.textContent = 'Disconnected';
      }
      reconnectTimer = setTimeout(initWebSocket, 2000);
    };

    ws.onerror = () => {
      // Handled by onclose
    };
  } catch (e) {
    reconnectTimer = setTimeout(initWebSocket, 2000);
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'pair:approved':
      authToken = msg.data.authToken;
      const hostName = msg.data.deviceName || 'Windows PC';
      hostDeviceName.textContent = hostName;
      if (sessionId) sessionStorage.setItem(STORAGE_KEY_SESSION, sessionId);
      sessionStorage.setItem(STORAGE_KEY_AUTH, authToken);
      sessionStorage.setItem(STORAGE_KEY_HOST, hostName);
      onPairingApproved();
      break;

    case 'pair:rejected':
      sessionStorage.removeItem(STORAGE_KEY_AUTH);
      showToast('Connection was declined by the PC.');
      handshakeTitle.textContent = 'Connection Declined';
      handshakeDesc.textContent = 'The host PC did not approve the connection. Please try again.';
      statusDot.className = 'status-indicator';
      statusText.textContent = 'Declined';
      break;

    case 'file:offered':
      handleIncomingFileOffer(msg.data);
      break;

    case 'text:received':
      handleIncomingText(msg.data);
      break;

    case 'pair:disconnected':
      showToast('Disconnected from host PC');
      resetToPairingView();
      break;
  }
}

// Request pairing to PC
async function requestPairingWithToken(sessId, token) {
  statusText.textContent = 'Requesting...';
  handshakeTitle.textContent = 'Approval Required';
  handshakeDesc.innerHTML = 'Look at your PC screen and click <strong>"Approve Connection"</strong>.';

  try {
    const res = await fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessId,
        pairingToken: token,
        deviceInfo: {
          name: getDeviceDisplayName(),
          type: 'Mobile'
        }
      })
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.error || 'Pairing request failed');
      pinFallbackForm.classList.remove('hidden');
    }
  } catch (err) {
    showToast('Failed to reach PC agent: ' + err.message);
  }
}

// Manual PIN submit
btnSubmitPin.addEventListener('click', async () => {
  const pin = manualPinInput.value.trim().toUpperCase();
  if (pin.length < 4) {
    showToast('Please enter a valid PIN');
    return;
  }
  try {
    const res = await fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingPin: pin,
        deviceInfo: {
          name: getDeviceDisplayName(),
          type: 'Mobile'
        }
      })
    });
    const data = await res.json();
    if (data.success) {
      pinFallbackForm.classList.add('hidden');
      handshakeTitle.textContent = 'Approval Required';
      handshakeDesc.innerHTML = 'Check your PC and click <strong>"Approve Connection"</strong>.';
    } else {
      showToast(data.error || 'Invalid PIN code');
    }
  } catch (e) {
    showToast('Connection failed: ' + e.message);
  }
});

function onPairingApproved() {
  pairingView.classList.add('hidden');
  connectedView.classList.remove('hidden');
  statusDot.className = 'status-indicator connected';
  statusText.textContent = 'Connected';
  if (window.soundChime) window.soundChime.playSuccess();
  showToast('Secure local connection established!');
  fetchPendingFiles();
}

function resetToPairingView() {
  authToken = null;
  sessionStorage.removeItem(STORAGE_KEY_AUTH);
  sessionStorage.removeItem(STORAGE_KEY_SESSION);
  sessionStorage.removeItem(STORAGE_KEY_HOST);
  connectedView.classList.add('hidden');
  pairingView.classList.remove('hidden');
  statusDot.className = 'status-indicator';
  statusText.textContent = 'Disconnected';
}

function setupListeners() {
  // Disconnect
  btnMobileDisconnect.addEventListener('click', async () => {
    try {
      await fetch('/api/pair/disconnect', { method: 'POST' });
    } catch (e) {}
    resetToPairingView();
  });

  // Photo & File Pickers
  mobilePhotoPicker.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      uploadFilesSequentially(e.target.files);
    }
  });

  mobileFilePicker.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      uploadFilesSequentially(e.target.files);
    }
  });

  // Text Send
  btnMobileSendText.addEventListener('click', () => {
    const text = mobileTextInput.value.trim();
    if (!text) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'text:send',
        data: { text, sender: getDeviceDisplayName() }
      }));
      mobileTextInput.value = '';
      showToast('Text sent to PC!');
      if (window.soundChime) window.soundChime.playSuccess();
    }
  });

  // Cancel Transfer
  btnMobileCancel.addEventListener('click', async () => {
    if (!currentTransferId) return;
    activeTransferAbort = true;
    try {
      await fetch('/api/transfer/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': authToken,
          'x-session-id': sessionId
        },
        body: JSON.stringify({ transferId: currentTransferId })
      });
    } catch (e) {}
    transferCard.classList.add('hidden');
    showToast('Transfer cancelled.');
  });
}

// Upload Files Sequentially with Chunked Streaming & SHA-256
async function uploadFilesSequentially(fileList) {
  for (const file of fileList) {
    try {
      await uploadFileChunked(file);
    } catch (err) {
      showToast('Upload error: ' + err.message);
      if (window.soundChime) window.soundChime.playAlert();
      break;
    }
  }
}

async function uploadFileChunked(file) {
  activeTransferAbort = false;
  currentTransferId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  // Show Progress Card
  transferFileName.textContent = file.name;
  transferFileSize.textContent = formatBytes(file.size);
  transferBar.style.width = '0%';
  transferPercent.textContent = '0%';
  transferSpeed.textContent = 'Calculating...';
  transferEta.textContent = 'ETA: ...';
  transferCard.classList.remove('hidden');

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Step 1: Calculate SHA-256 of file using Web Crypto API (for files <= 50MB to protect mobile memory)
  let sha256Hex = '';
  if (file.size <= 50 * 1024 * 1024) {
    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(digest));
      sha256Hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('Could not compute client SHA-256, server will compute:', e);
    }
  }

  // Step 2: Negotiate transfer start
  const startRes = await fetch('/api/transfer/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken,
      'x-session-id': sessionId
    },
    body: JSON.stringify({
      transferId: currentTransferId,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      expectedSha256: sha256Hex
    })
  });

  if (!startRes.ok) {
    const err = await startRes.json();
    throw new Error(err.error || 'Failed to start transfer');
  }

  // Step 3: Stream Chunks with backpressure
  const startTime = Date.now();
  let bytesUploaded = 0;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    if (activeTransferAbort) {
      throw new Error('Cancelled by user');
    }

    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);

    const chunkRes = await fetch('/api/transfer/chunk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-auth-token': authToken,
        'x-session-id': sessionId,
        'x-transfer-id': currentTransferId,
        'x-chunk-index': chunkIndex.toString()
      },
      body: chunkBlob
    });

    if (!chunkRes.ok) {
      const err = await chunkRes.json();
      throw new Error(err.error || 'Chunk upload failed');
    }

    bytesUploaded += (end - start);
    const percent = Math.round((bytesUploaded / file.size) * 100);
    const elapsedSeconds = Math.max(0.1, (Date.now() - startTime) / 1000);
    const speedBps = bytesUploaded / elapsedSeconds;
    const speedMB = (speedBps / (1024 * 1024)).toFixed(1);
    const remainingBytes = file.size - bytesUploaded;
    const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : 0;

    transferBar.style.width = `${percent}%`;
    const pb = document.getElementById('mobileProgressBar');
    if (pb) pb.setAttribute('aria-valuenow', percent);
    transferPercent.textContent = `${percent}%`;
    transferSpeed.textContent = `${speedMB} MB/s`;
    transferEta.textContent = `ETA: ${etaSec}s`;
  }

  // Step 4: Finalize & verify integrity
  const completeRes = await fetch('/api/transfer/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken,
      'x-session-id': sessionId
    },
    body: JSON.stringify({
      transferId: currentTransferId,
      sha256: sha256Hex
    })
  });

  if (!completeRes.ok) {
    const err = await completeRes.json();
    throw new Error(err.error || 'Integrity check failed');
  }

  // Done!
  transferCard.classList.add('hidden');
  showToast(`"${file.name}" sent successfully!`);
  if (window.soundChime) window.soundChime.playSuccess();
}

// Fetch pending/queued files from PC
async function fetchPendingFiles() {
  if (!authToken || !sessionId) return;
  try {
    const res = await fetch(`/api/files/pending?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(authToken)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.files)) {
        for (const fileOffer of data.files) {
          handleIncomingFileOffer(fileOffer);
        }
      }
    }
  } catch (e) {
    console.warn('Failed to fetch pending files:', e);
  }
}

// Handle Incoming File from PC
function handleIncomingFileOffer(fileMeta) {
  if (!fileMeta || !fileMeta.fileId) return;
  if (receivedFileIds.has(fileMeta.fileId)) return;
  receivedFileIds.add(fileMeta.fileId);

  const empty = mobileReceivedList.querySelector('.empty-received');
  if (empty) empty.remove();

  const authQuery = (sessionId && authToken) ? `&sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(authToken)}` : '';
  const initialAuthQuery = (sessionId && authToken) ? `?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(authToken)}` : '';

  const previewSrc = fileMeta.downloadUrl + initialAuthQuery;
  const downloadHref = `${fileMeta.downloadUrl}?download=1${authQuery}`;

  const isImg = (fileMeta.mimeType && fileMeta.mimeType.startsWith('image/')) ||
                /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileMeta.fileName);
  const previewHtml = isImg 
    ? `<img src="${previewSrc}" class="mobile-received-thumb" alt="Preview of ${escapeHtml(fileMeta.fileName)}" onclick="window.open('${previewSrc}', '_blank')" title="Tap to view full image">` 
    : '';

  const item = document.createElement('div');
  item.className = 'received-item';
  item.innerHTML = `
    ${previewHtml}
    <div class="received-text-wrap" style="flex: 1; overflow: hidden; min-width: 0;">
      <span class="received-name" title="${escapeHtml(fileMeta.fileName)}">${escapeHtml(fileMeta.fileName)}</span>
      <span class="received-meta">${formatBytes(fileMeta.fileSize)} • Ready to Save</span>
    </div>
    <a href="${downloadHref}" class="btn btn-sm btn-primary" download="${escapeHtml(fileMeta.fileName)}" style="flex-shrink: 0;" aria-label="Save ${escapeHtml(fileMeta.fileName)}">Save</a>
  `;
  mobileReceivedList.prepend(item);

  if (window.soundChime) window.soundChime.playSuccess();
  showToast(`Received "${fileMeta.fileName}" from PC!`);
}

// Handle Incoming Text from PC
function handleIncomingText(textItem) {
  if (!textItem || !textItem.text) return;
  const tid = textItem.id || (textItem.text + '_' + textItem.timestamp);
  if (receivedTextIds.has(tid)) return;
  receivedTextIds.add(tid);

  const empty = mobileReceivedList.querySelector('.empty-received');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'received-item';
  item.innerHTML = `
    <div class="received-text-wrap" style="flex: 1; overflow: hidden; min-width: 0;">
      <span class="received-name">${escapeHtml(textItem.text)}</span>
      <span class="received-meta">Text from PC</span>
    </div>
    <button class="btn btn-xs btn-primary" onclick="copyTextToClipboard('${encodeURIComponent(textItem.text)}')" style="flex-shrink: 0;">Copy</button>
  `;
  mobileReceivedList.prepend(item);

  if (window.soundChime) window.soundChime.playPing();
  showToast('New text received from PC');
}

window.copyTextToClipboard = function(encodedText) {
  const text = decodeURIComponent(encodedText);
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!');
};

// Utilities
function showToast(msg) {
  mobileToast.textContent = msg;
  mobileToast.classList.remove('hidden');
  setTimeout(() => {
    mobileToast.classList.add('hidden');
  }, 3000);
}

function getDeviceDisplayName() {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android Device';
  return 'Mobile Phone';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
