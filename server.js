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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure directories exist
['data', 'logs', 'uploads', '.wwebjs_auth'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Global state
let waClient = null;
let isClientReady = false;
let sendingInProgress = false;
let currentJob = null;
let messageLog = [];
let waInfo = null;
let cachedChats = []; // Cache chats

// Settings
let settings = {
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
  addRandomPause: true,
  sessionName: 'beautylatory-session'
};

// Daily counter
let dailyCounter = { date: new Date().toDateString(), count: 0 };
let sessionCounter = 0;

// Load settings
const settingsPath = './data/settings.json';
if (fs.existsSync(settingsPath)) {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath)) };
}

// Load contacts database
const contactsDbPath = './data/contacts-db.json';
let contactsDb = [];
if (fs.existsSync(contactsDbPath)) {
  contactsDb = JSON.parse(fs.readFileSync(contactsDbPath));
}

// Initialize WhatsApp Client
function initWhatsApp() {
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
      '--single-process',
      '--no-zygote'
    ]
  };
  
  // Use system Chromium if available (for Railway/Docker)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  
  waClient = new Client({
    authStrategy: new LocalAuth({ 
      clientId: settings.sessionName,
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: puppeteerConfig
  });

  waClient.on('qr', async (qr) => {
    const qrDataUrl = await QRCode.toDataURL(qr);
    io.emit('qr', qrDataUrl);
    io.emit('status', { status: 'waiting_qr', message: 'Scan QR Code dengan WhatsApp' });
  });

  waClient.on('ready', async () => {
    isClientReady = true;
    sessionCounter = 0;
    
    // Get WhatsApp user info - FIXED
    try {
      // Wait a bit for client to fully initialize
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const info = waClient.info;
      if (info) {
        waInfo = {
          pushname: info.pushname || 'WhatsApp User',
          wid: info.wid ? info.wid.user : 'Unknown',
          platform: info.platform || 'Unknown'
        };
        log(`Connected as: ${waInfo.pushname} (${waInfo.wid})`);
      }
    } catch (e) {
      log('Could not get WA info: ' + e.message, 'warn');
      waInfo = { pushname: 'WhatsApp User', wid: 'Connected', platform: 'Unknown' };
    }
    
    // Load chats in background
    loadChatsInBackground();
    
    io.emit('status', { 
      status: 'ready', 
      message: 'WhatsApp terhubung!',
      waInfo 
    });
  });

  waClient.on('authenticated', () => {
    io.emit('status', { status: 'authenticated', message: 'Autentikasi berhasil' });
    log('WhatsApp authenticated');
  });

  waClient.on('auth_failure', (msg) => {
    io.emit('status', { status: 'auth_failure', message: 'Autentikasi gagal: ' + msg });
    log('Auth failure: ' + msg, 'error');
  });

  waClient.on('disconnected', (reason) => {
    isClientReady = false;
    waInfo = null;
    cachedChats = [];
    io.emit('status', { status: 'disconnected', message: 'Terputus: ' + reason });
    log('Disconnected: ' + reason, 'warn');
  });

  waClient.initialize();
}

// Load chats in background
async function loadChatsInBackground() {
  if (!isClientReady || !waClient) return;
  
  try {
    log('Loading chat history...');
    const chats = await waClient.getChats();
    
    cachedChats = [];
    for (const chat of chats.slice(0, 50)) {
      try {
        let lastMessage = '';
        let timestamp = '';
        
        // Get last message
        const messages = await chat.fetchMessages({ limit: 1 });
        if (messages && messages.length > 0) {
          const msg = messages[0];
          lastMessage = msg.body ? msg.body.substring(0, 60) : (msg.type || '');
          if (msg.timestamp) {
            const date = new Date(msg.timestamp * 1000);
            timestamp = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          }
        }
        
        cachedChats.push({
          id: chat.id._serialized,
          name: chat.name || (chat.id.user ? chat.id.user : 'Unknown'),
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount || 0,
          lastMessage,
          timestamp
        });
      } catch (e) {
        // Skip problematic chats
      }
    }
    
    log(`Loaded ${cachedChats.length} chats`);
    io.emit('chats_loaded', cachedChats);
  } catch (error) {
    log('Error loading chats: ' + error.message, 'error');
  }
}

// Logging function
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, type, message };
  messageLog.push(logEntry);
  if (messageLog.length > 1000) messageLog.shift();
  
  const logFile = `./logs/${new Date().toISOString().split('T')[0]}.log`;
  fs.appendFileSync(logFile, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`);
  io.emit('log', logEntry);
}


// ============ DELAY & SAFETY FUNCTIONS ============

function getHumanizedDelay() {
  let minDelay, maxDelay;
  
  if (sessionCounter < settings.warmupMessages) {
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

function needsBatchRest(messageIndex) {
  return messageIndex > 0 && messageIndex % settings.batchSize === 0;
}

function getBatchRestDuration() {
  const min = settings.batchRestMin;
  const max = settings.batchRestMax;
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

async function simulateTyping(chatId) {
  if (!settings.simulateTyping) return;
  try {
    const chat = await waClient.getChatById(chatId);
    await chat.sendStateTyping();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await chat.clearState();
  } catch (e) {}
}

function checkDailyLimit() {
  const today = new Date().toDateString();
  if (dailyCounter.date !== today) {
    dailyCounter = { date: today, count: 0 };
    sessionCounter = 0;
  }
  return dailyCounter.count < settings.dailyLimit;
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

function saveContactsDb() {
  fs.writeFileSync(contactsDbPath, JSON.stringify(contactsDb, null, 2));
}

// ============ API ROUTES ============

// Get status
app.get('/api/status', (req, res) => {
  res.json({
    connected: isClientReady,
    sending: sendingInProgress,
    dailyCount: dailyCounter.count,
    dailyLimit: settings.dailyLimit,
    sessionCount: sessionCounter,
    waInfo,
    settings
  });
});

// Get chat history - FIXED
app.get('/api/chats', async (req, res) => {
  try {
    if (!isClientReady) {
      return res.json({ success: true, chats: [] });
    }
    
    // Return cached chats
    if (cachedChats.length > 0) {
      return res.json({ success: true, chats: cachedChats });
    }
    
    // If no cache, try to load
    await loadChatsInBackground();
    res.json({ success: true, chats: cachedChats });
  } catch (error) {
    res.json({ success: false, chats: [], error: error.message });
  }
});

// Refresh chats
app.post('/api/chats/refresh', async (req, res) => {
  try {
    if (!isClientReady) {
      return res.json({ success: false, error: 'WhatsApp not connected' });
    }
    await loadChatsInBackground();
    res.json({ success: true, chats: cachedChats });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Update settings
app.post('/api/settings', (req, res) => {
  settings = { ...settings, ...req.body };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  res.json({ success: true, settings });
});

// Get contacts
app.get('/api/contacts', (req, res) => {
  res.json({ success: true, contacts: contactsDb });
});

// Add single contact
app.post('/api/contacts', (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: 'Nomor diperlukan' });
  
  const newContact = {
    id: Date.now(),
    phone: phone.toString().trim(),
    name: (name || '').trim(),
    createdAt: new Date().toISOString()
  };
  
  contactsDb.push(newContact);
  saveContactsDb();
  res.json({ success: true, contact: newContact });
});

// Add bulk contacts
app.post('/api/contacts/bulk', (req, res) => {
  const { contacts } = req.body;
  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ success: false, error: 'Data tidak valid' });
  }
  
  const newContacts = contacts.map(c => ({
    id: Date.now() + Math.random(),
    phone: c.phone.toString().trim(),
    name: (c.name || '').trim(),
    createdAt: new Date().toISOString()
  }));
  
  contactsDb.push(...newContacts);
  saveContactsDb();
  res.json({ success: true, contacts: newContacts, total: contactsDb.length });
});

// Delete contact
app.delete('/api/contacts/:id', (req, res) => {
  const id = parseFloat(req.params.id);
  contactsDb = contactsDb.filter(c => c.id !== id);
  saveContactsDb();
  res.json({ success: true });
});

// Clear all contacts
app.delete('/api/contacts', (req, res) => {
  contactsDb = [];
  saveContactsDb();
  res.json({ success: true });
});

// Upload contacts file
app.post('/api/upload-contacts', upload.single('file'), (req, res) => {
  try {
    const contacts = parseContactsFile(req.file.path);
    const newContacts = contacts.map(c => ({
      id: Date.now() + Math.random(),
      phone: c.phone.toString().trim(),
      name: (c.name || '').trim(),
      createdAt: new Date().toISOString()
    }));
    
    contactsDb.push(...newContacts);
    saveContactsDb();
    res.json({ success: true, contacts: newContacts, total: contactsDb.length });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Upload media
app.post('/api/upload-media', upload.single('file'), (req, res) => {
  try {
    res.json({ success: true, filePath: req.file.path, fileName: req.file.filename });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});


// Send bulk messages
app.post('/api/send-bulk', async (req, res) => {
  if (!isClientReady) {
    return res.status(400).json({ success: false, error: 'WhatsApp belum terhubung' });
  }
  
  if (sendingInProgress) {
    return res.status(400).json({ success: false, error: 'Pengiriman sedang berjalan' });
  }

  const { contacts, message, mediaPath } = req.body;
  
  if (!contacts || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'Tidak ada kontak' });
  }

  if (!message && !mediaPath) {
    return res.status(400).json({ success: false, error: 'Pesan atau media diperlukan' });
  }

  sendingInProgress = true;
  currentJob = { total: contacts.length, sent: 0, failed: 0, results: [] };

  res.json({ success: true, message: 'Pengiriman dimulai', total: contacts.length });
  processBulkSend(contacts, message, mediaPath);
});

// Process bulk send
async function processBulkSend(contacts, messageTemplate, mediaPath) {
  log(`Memulai pengiriman ke ${contacts.length} kontak`, 'info');
  
  for (let i = 0; i < contacts.length; i++) {
    if (!sendingInProgress) {
      log('Pengiriman dihentikan', 'warn');
      break;
    }

    if (!checkDailyLimit()) {
      log(`Batas harian tercapai (${settings.dailyLimit})`, 'warn');
      io.emit('limit_reached', { limit: settings.dailyLimit });
      break;
    }

    if (needsBatchRest(i)) {
      const restDuration = getBatchRestDuration();
      log(`Istirahat batch ${Math.floor(restDuration/1000)}s`, 'info');
      io.emit('batch_rest', { duration: Math.floor(restDuration/1000), batch: Math.floor(i/settings.batchSize) });
      await new Promise(resolve => setTimeout(resolve, restDuration));
    }

    const contact = contacts[i];
    const phone = formatPhoneNumber(contact.phone);
    const personalizedMessage = replaceVariables(messageTemplate, contact);

    try {
      const isRegistered = await waClient.isRegisteredUser(phone);
      if (!isRegistered) throw new Error('Nomor tidak terdaftar di WhatsApp');

      await simulateTyping(phone);

      if (mediaPath && fs.existsSync(mediaPath)) {
        const media = MessageMedia.fromFilePath(mediaPath);
        await waClient.sendMessage(phone, media, { caption: personalizedMessage });
      } else {
        await waClient.sendMessage(phone, personalizedMessage);
      }

      currentJob.sent++;
      dailyCounter.count++;
      sessionCounter++;
      
      const result = { phone: contact.phone, name: contact.name, status: 'success' };
      currentJob.results.push(result);
      log(`✓ Terkirim ke ${contact.name || contact.phone}`, 'success');
      io.emit('message_sent', { ...result, progress: currentJob });

    } catch (error) {
      currentJob.failed++;
      const result = { phone: contact.phone, name: contact.name, status: 'failed', error: error.message };
      currentJob.results.push(result);
      log(`✗ Gagal: ${contact.phone} - ${error.message}`, 'error');
      io.emit('message_failed', { ...result, progress: currentJob });
    }

    if (i < contacts.length - 1 && sendingInProgress) {
      const delay = getHumanizedDelay();
      const isWarmup = sessionCounter <= settings.warmupMessages;
      log(`Menunggu ${Math.floor(delay/1000)}s${isWarmup ? ' (warmup)' : ''}`, 'info');
      io.emit('waiting', { delay: Math.floor(delay/1000), next: i + 2, total: contacts.length, isWarmup });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  sendingInProgress = false;
  io.emit('bulk_complete', currentJob);
  log(`Selesai. Terkirim: ${currentJob.sent}, Gagal: ${currentJob.failed}`, 'success');
  
  const resultFile = `./logs/result-${Date.now()}.json`;
  fs.writeFileSync(resultFile, JSON.stringify(currentJob, null, 2));
}

// Stop sending
app.post('/api/stop', (req, res) => {
  sendingInProgress = false;
  res.json({ success: true, message: 'Pengiriman dihentikan' });
});

// Get logs
app.get('/api/logs', (req, res) => {
  res.json(messageLog.slice(-100));
});

// Logout
app.post('/api/logout', async (req, res) => {
  try {
    if (waClient) {
      await waClient.logout();
      isClientReady = false;
      waInfo = null;
      cachedChats = [];
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Restart
app.post('/api/restart', async (req, res) => {
  try {
    if (waClient) {
      await waClient.destroy();
    }
    isClientReady = false;
    waInfo = null;
    cachedChats = [];
    sessionCounter = 0;
    initWhatsApp();
    res.json({ success: true, message: 'Restarting...' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  log('Dashboard terhubung');
  socket.emit('status', { 
    status: isClientReady ? 'ready' : 'disconnected',
    message: isClientReady ? 'WhatsApp terhubung' : 'WhatsApp belum terhubung',
    waInfo
  });
  
  // Send cached chats if available
  if (cachedChats.length > 0) {
    socket.emit('chats_loaded', cachedChats);
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🌸 Beautylatory Smart Bulk Sender`);
  console.log(`📍 http://localhost:${PORT}\n`);
  initWhatsApp();
});
