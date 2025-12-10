const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure directories exist
['data', 'logs', 'uploads', 'sessions'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + file.originalname)
});
const upload = multer({ storage });

// ============ MULTI-USER SESSION MANAGEMENT ============
// Store active WhatsApp clients per session
const userSessions = new Map(); // sessionId -> { client, isReady, waInfo, contacts, settings, dailyCounter }

// Default settings
const DEFAULT_SETTINGS = {
  minDelay: 8,
  maxDelay: 15,
  batchSize: 25,
  batchRestMin: 90,
  batchRestMax: 120,
  warmupMessages: 10,
  warmupDelayMin: 15,
  warmupDelayMax: 25,
  dailyLimit: 300,
  simulateTyping: true,
  addRandomPause: true
};

// Generate unique session ID
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// Get or create user session
function getSession(sessionId) {
  if (!userSessions.has(sessionId)) {
    return null;
  }
  return userSessions.get(sessionId);
}

// Create new session
function createSession(sessionId) {
  const session = {
    client: null,
    isReady: false,
    waInfo: null,
    contacts: [],
    settings: { ...DEFAULT_SETTINGS },
    dailyCounter: { date: new Date().toDateString(), count: 0 },
    sessionCounter: 0,
    sendingInProgress: false,
    currentJob: null,
    socketId: null
  };
  userSessions.set(sessionId, session);
  
  // Load saved data if exists
  loadSessionData(sessionId, session);
  
  return session;
}

// Save session data to file
function saveSessionData(sessionId, session) {
  const dataPath = `./data/session-${sessionId}.json`;
  const data = {
    contacts: session.contacts,
    settings: session.settings,
    dailyCounter: session.dailyCounter
  };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// Load session data from file
function loadSessionData(sessionId, session) {
  const dataPath = `./data/session-${sessionId}.json`;
  if (fs.existsSync(dataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath));
      session.contacts = data.contacts || [];
      session.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      session.dailyCounter = data.dailyCounter || { date: new Date().toDateString(), count: 0 };
    } catch (e) {
      console.error('Error loading session data:', e);
    }
  }
}

// Logging function
function log(sessionId, message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type, message };
  
  // Log to file
  const logFile = `./logs/${new Date().toISOString().split('T')[0]}.log`;
  fs.appendFileSync(logFile, `[${timestamp}] [${sessionId?.substring(0, 8) || 'SYSTEM'}] [${type.toUpperCase()}] ${message}\n`);
  
  // Emit to specific session socket
  const session = getSession(sessionId);
  if (session && session.socketId) {
    io.to(session.socketId).emit('log', logEntry);
  }
  
  return logEntry;
}


// ============ WHATSAPP CLIENT MANAGEMENT ============

// Initialize WhatsApp Client for a session
function initWhatsAppForSession(sessionId, socket) {
  const session = getSession(sessionId);
  if (!session) return;
  
  // Destroy existing client if any
  if (session.client) {
    try {
      session.client.destroy();
    } catch (e) {}
  }
  
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--single-process'
    ]
  };
  
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  
  session.client = new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: './sessions'
    }),
    puppeteer: puppeteerConfig
  });
  
  session.client.on('qr', async (qr) => {
    const qrDataUrl = await QRCode.toDataURL(qr);
    socket.emit('qr', qrDataUrl);
    socket.emit('status', { status: 'waiting_qr', message: 'Scan QR Code dengan WhatsApp' });
  });
  
  session.client.on('ready', async () => {
    session.isReady = true;
    session.sessionCounter = 0;
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const info = session.client.info;
      if (info) {
        session.waInfo = {
          pushname: info.pushname || 'WhatsApp User',
          wid: info.wid ? info.wid.user : 'Unknown',
          platform: info.platform || 'Unknown'
        };
      }
    } catch (e) {
      session.waInfo = { pushname: 'WhatsApp User', wid: 'Connected', platform: 'Unknown' };
    }
    
    socket.emit('status', { status: 'ready', message: 'WhatsApp terhubung!', waInfo: session.waInfo });
    log(sessionId, `Connected as: ${session.waInfo?.pushname} (${session.waInfo?.wid})`);
    
    // Load chats
    loadChatsForSession(sessionId, socket);
  });
  
  session.client.on('authenticated', () => {
    socket.emit('status', { status: 'authenticated', message: 'Autentikasi berhasil' });
    log(sessionId, 'WhatsApp authenticated');
  });
  
  session.client.on('auth_failure', (msg) => {
    socket.emit('status', { status: 'auth_failure', message: 'Autentikasi gagal: ' + msg });
    log(sessionId, 'Auth failure: ' + msg, 'error');
  });
  
  session.client.on('disconnected', (reason) => {
    session.isReady = false;
    session.waInfo = null;
    socket.emit('status', { status: 'disconnected', message: 'Terputus: ' + reason });
    log(sessionId, 'Disconnected: ' + reason, 'warn');
  });
  
  session.client.initialize();
}

// Load chats for session
async function loadChatsForSession(sessionId, socket) {
  const session = getSession(sessionId);
  if (!session || !session.isReady || !session.client) return;
  
  try {
    log(sessionId, 'Loading chat history...');
    const chats = await session.client.getChats();
    const chatList = [];
    
    for (const chat of chats.slice(0, 30)) {
      try {
        let lastMessage = '';
        let timestamp = '';
        
        const messages = await chat.fetchMessages({ limit: 1 });
        if (messages && messages.length > 0) {
          const msg = messages[0];
          lastMessage = msg.body ? msg.body.substring(0, 50) : '';
          if (msg.timestamp) {
            const date = new Date(msg.timestamp * 1000);
            timestamp = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          }
        }
        
        chatList.push({
          id: chat.id._serialized,
          name: chat.name || (chat.id.user ? chat.id.user : 'Unknown'),
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          lastMessage,
          timestamp
        });
      } catch (e) {}
    }
    
    socket.emit('chats_loaded', chatList);
    log(sessionId, `Loaded ${chatList.length} chats`);
  } catch (error) {
    log(sessionId, 'Error loading chats: ' + error.message, 'error');
  }
}

// ============ HELPER FUNCTIONS ============

function getHumanizedDelay(session) {
  const settings = session.settings;
  let minDelay, maxDelay;
  
  if (session.sessionCounter < settings.warmupMessages) {
    minDelay = settings.warmupDelayMin;
    maxDelay = settings.warmupDelayMax;
  } else {
    minDelay = settings.minDelay;
    maxDelay = settings.maxDelay;
  }
  
  let delay = Math.floor(Math.random() * (maxDelay - minDelay + 1) + minDelay);
  
  if (settings.addRandomPause && Math.random() < 0.1) {
    delay += Math.floor(Math.random() * 20) + 10;
  }
  
  return delay * 1000;
}

function needsBatchRest(session, messageIndex) {
  return messageIndex > 0 && messageIndex % session.settings.batchSize === 0;
}

function getBatchRestDuration(session) {
  const min = session.settings.batchRestMin;
  const max = session.settings.batchRestMax;
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

async function simulateTyping(session, chatId) {
  if (!session.settings.simulateTyping) return;
  try {
    const chat = await session.client.getChatById(chatId);
    await chat.sendStateTyping();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await chat.clearState();
  } catch (e) {}
}

function checkDailyLimit(session) {
  const today = new Date().toDateString();
  if (session.dailyCounter.date !== today) {
    session.dailyCounter = { date: today, count: 0 };
    session.sessionCounter = 0;
  }
  return session.dailyCounter.count < session.settings.dailyLimit;
}

function formatPhoneNumber(phone) {
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '62' + cleaned.substring(1);
  if (!cleaned.includes('@')) cleaned = cleaned + '@c.us';
  return cleaned;
}

function parseContactsFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let contacts = [];

  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf-8');
    const records = parse(content, { columns: true, skip_empty_lines: true });
    contacts = records.map(r => ({
      phone: r.phone || r.nomor || r.number || r.Phone || r.Nomor || r.Number,
      name: r.name || r.nama || r.Name || r.Nama || ''
    }));
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    contacts = data.map(r => ({
      phone: r.phone || r.nomor || r.number || r.Phone || r.Nomor || r.Number,
      name: r.name || r.nama || r.Name || r.Nama || ''
    }));
  }

  return contacts.filter(c => c.phone);
}

function replaceVariables(template, contact) {
  return template
    .replace(/\{name\}/gi, contact.name || '')
    .replace(/\{nama\}/gi, contact.name || '')
    .replace(/\{phone\}/gi, contact.phone || '')
    .replace(/\{nomor\}/gi, contact.phone || '');
}


// ============ API ROUTES ============

// Create new session
app.post('/api/session/create', (req, res) => {
  const sessionId = generateSessionId();
  createSession(sessionId);
  log(sessionId, 'New session created');
  res.json({ success: true, sessionId });
});

// Check session exists
app.get('/api/session/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.json({ success: false, exists: false });
  }
  
  res.json({
    success: true,
    exists: true,
    connected: session.isReady,
    waInfo: session.waInfo,
    dailyCount: session.dailyCounter.count,
    dailyLimit: session.settings.dailyLimit,
    settings: session.settings
  });
});

// Get contacts for session
app.get('/api/session/:sessionId/contacts', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  res.json({ success: true, contacts: session.contacts });
});

// Add single contact
app.post('/api/session/:sessionId/contacts', (req, res) => {
  const { sessionId } = req.params;
  const { phone, name } = req.body;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone required' });
  }
  
  const newContact = {
    id: Date.now(),
    phone: phone.toString().trim(),
    name: (name || '').trim(),
    createdAt: new Date().toISOString()
  };
  
  session.contacts.push(newContact);
  saveSessionData(sessionId, session);
  
  res.json({ success: true, contact: newContact });
});

// Add bulk contacts
app.post('/api/session/:sessionId/contacts/bulk', (req, res) => {
  const { sessionId } = req.params;
  const { contacts } = req.body;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ success: false, error: 'Invalid data' });
  }
  
  const newContacts = contacts.map(c => ({
    id: Date.now() + Math.random(),
    phone: c.phone.toString().trim(),
    name: (c.name || '').trim(),
    createdAt: new Date().toISOString()
  }));
  
  session.contacts.push(...newContacts);
  saveSessionData(sessionId, session);
  
  res.json({ success: true, contacts: newContacts, total: session.contacts.length });
});

// Delete contact
app.delete('/api/session/:sessionId/contacts/:contactId', (req, res) => {
  const { sessionId, contactId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  session.contacts = session.contacts.filter(c => c.id !== parseFloat(contactId));
  saveSessionData(sessionId, session);
  
  res.json({ success: true });
});

// Clear all contacts
app.delete('/api/session/:sessionId/contacts', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  session.contacts = [];
  saveSessionData(sessionId, session);
  
  res.json({ success: true });
});

// Upload contacts file
app.post('/api/session/:sessionId/upload-contacts', upload.single('file'), (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  try {
    const contacts = parseContactsFile(req.file.path);
    const newContacts = contacts.map(c => ({
      id: Date.now() + Math.random(),
      phone: c.phone.toString().trim(),
      name: (c.name || '').trim(),
      createdAt: new Date().toISOString()
    }));
    
    session.contacts.push(...newContacts);
    saveSessionData(sessionId, session);
    
    res.json({ success: true, contacts: newContacts, total: session.contacts.length });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Upload media
app.post('/api/session/:sessionId/upload-media', upload.single('file'), (req, res) => {
  try {
    res.json({ success: true, filePath: req.file.path, fileName: req.file.filename });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Update settings
app.post('/api/session/:sessionId/settings', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  session.settings = { ...session.settings, ...req.body };
  saveSessionData(sessionId, session);
  
  res.json({ success: true, settings: session.settings });
});

// Refresh chats
app.post('/api/session/:sessionId/chats/refresh', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session || !session.isReady) {
    return res.json({ success: false, chats: [] });
  }
  
  // Will emit via socket
  const socket = io.sockets.sockets.get(session.socketId);
  if (socket) {
    await loadChatsForSession(sessionId, socket);
  }
  
  res.json({ success: true });
});

// Logout WhatsApp
app.post('/api/session/:sessionId/logout', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  try {
    if (session.client) {
      await session.client.logout();
      session.isReady = false;
      session.waInfo = null;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop sending
app.post('/api/session/:sessionId/stop', (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  session.sendingInProgress = false;
  res.json({ success: true });
});


// Send bulk messages
app.post('/api/session/:sessionId/send-bulk', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  if (!session.isReady) {
    return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  }
  
  if (session.sendingInProgress) {
    return res.status(400).json({ success: false, error: 'Sending in progress' });
  }
  
  const { contacts, message, mediaPath } = req.body;
  
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'No contacts' });
  }
  
  if (!message && !mediaPath) {
    return res.status(400).json({ success: false, error: 'Message or media required' });
  }
  
  session.sendingInProgress = true;
  session.currentJob = { total: contacts.length, sent: 0, failed: 0, results: [] };
  
  res.json({ success: true, message: 'Sending started', total: contacts.length });
  
  // Process in background
  processBulkSend(sessionId, contacts, message, mediaPath);
});

// Process bulk send
async function processBulkSend(sessionId, contacts, messageTemplate, mediaPath) {
  const session = getSession(sessionId);
  if (!session) return;
  
  const socket = io.sockets.sockets.get(session.socketId);
  
  log(sessionId, `Starting bulk send to ${contacts.length} contacts`);
  
  for (let i = 0; i < contacts.length; i++) {
    if (!session.sendingInProgress) {
      log(sessionId, 'Sending stopped by user', 'warn');
      break;
    }
    
    if (!checkDailyLimit(session)) {
      log(sessionId, `Daily limit reached (${session.settings.dailyLimit})`, 'warn');
      if (socket) socket.emit('limit_reached', { limit: session.settings.dailyLimit });
      break;
    }
    
    if (needsBatchRest(session, i)) {
      const restDuration = getBatchRestDuration(session);
      log(sessionId, `Batch rest ${Math.floor(restDuration/1000)}s`);
      if (socket) socket.emit('batch_rest', { duration: Math.floor(restDuration/1000), batch: Math.floor(i/session.settings.batchSize) });
      await new Promise(resolve => setTimeout(resolve, restDuration));
    }
    
    const contact = contacts[i];
    const phone = formatPhoneNumber(contact.phone);
    const personalizedMessage = replaceVariables(messageTemplate, contact);
    
    try {
      const isRegistered = await session.client.isRegisteredUser(phone);
      if (!isRegistered) throw new Error('Not registered on WhatsApp');
      
      await simulateTyping(session, phone);
      
      if (mediaPath && fs.existsSync(mediaPath)) {
        const media = MessageMedia.fromFilePath(mediaPath);
        await session.client.sendMessage(phone, media, { caption: personalizedMessage });
      } else {
        await session.client.sendMessage(phone, personalizedMessage);
      }
      
      session.currentJob.sent++;
      session.dailyCounter.count++;
      session.sessionCounter++;
      
      const result = { phone: contact.phone, name: contact.name, status: 'success' };
      session.currentJob.results.push(result);
      log(sessionId, `✓ Sent to ${contact.name || contact.phone}`, 'success');
      if (socket) socket.emit('message_sent', { ...result, progress: session.currentJob });
      
    } catch (error) {
      session.currentJob.failed++;
      const result = { phone: contact.phone, name: contact.name, status: 'failed', error: error.message };
      session.currentJob.results.push(result);
      log(sessionId, `✗ Failed: ${contact.phone} - ${error.message}`, 'error');
      if (socket) socket.emit('message_failed', { ...result, progress: session.currentJob });
    }
    
    if (i < contacts.length - 1 && session.sendingInProgress) {
      const delay = getHumanizedDelay(session);
      const isWarmup = session.sessionCounter <= session.settings.warmupMessages;
      log(sessionId, `Waiting ${Math.floor(delay/1000)}s${isWarmup ? ' (warmup)' : ''}`);
      if (socket) socket.emit('waiting', { delay: Math.floor(delay/1000), next: i + 2, total: contacts.length, isWarmup });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  session.sendingInProgress = false;
  saveSessionData(sessionId, session);
  
  if (socket) socket.emit('bulk_complete', session.currentJob);
  log(sessionId, `Completed. Sent: ${session.currentJob.sent}, Failed: ${session.currentJob.failed}`, 'success');
}

// ============ SOCKET.IO ============

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Client sends their session ID
  socket.on('register_session', (data) => {
    const { sessionId } = data;
    
    if (!sessionId) {
      socket.emit('error', { message: 'Session ID required' });
      return;
    }
    
    let session = getSession(sessionId);
    
    // Create session if doesn't exist
    if (!session) {
      session = createSession(sessionId);
    }
    
    // Store socket ID in session
    session.socketId = socket.id;
    
    // Send current status
    socket.emit('status', {
      status: session.isReady ? 'ready' : 'disconnected',
      message: session.isReady ? 'WhatsApp terhubung' : 'WhatsApp belum terhubung',
      waInfo: session.waInfo
    });
    
    log(sessionId, 'Session registered');
  });
  
  // Start WhatsApp connection
  socket.on('start_whatsapp', (data) => {
    const { sessionId } = data;
    const session = getSession(sessionId);
    
    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }
    
    log(sessionId, 'Starting WhatsApp connection...');
    initWhatsAppForSession(sessionId, socket);
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌸 Beautylatory Smart Bulk Sender (Multi-User)`);
  console.log(`📍 http://localhost:${PORT}\n`);
});
