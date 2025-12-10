// Socket.IO connection
const socket = io();

// State
let contacts = [];
let mediaPath = null;
let mediaPreviewUrl = null;
let totalContacts = 0;

// Safety Presets
const PRESETS = {
  safe: { minDelay: 20, maxDelay: 35, batchSize: 15, batchRest: 180, dailyLimit: 100 },
  balanced: { minDelay: 8, maxDelay: 15, batchSize: 25, batchRest: 90, dailyLimit: 300 },
  fast: { minDelay: 5, maxDelay: 10, batchSize: 35, batchRest: 60, dailyLimit: 500 }
};

// Wait for DOM
document.addEventListener('DOMContentLoaded', function() {
  init();
});

// Initialize
async function init() {
  console.log('Initializing app...');
  try {
    await loadStatus();
    await loadContacts();
    setupEventListeners();
    setupModals();
    setupFormatToolbar();
    setupPresets();
    addSpreadsheetRows(5);
    updateMessagePreview();
    console.log('App initialized successfully');
  } catch (error) {
    console.error('Init error:', error);
  }
}

// DOM helper - single element
function $(selector) {
  return document.querySelector(selector);
}

// DOM helper - multiple elements
function $$(selector) {
  return document.querySelectorAll(selector);
}

// Load status from server
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateConnectionStatus(data.connected, data.waInfo);
    $('#daily-counter').textContent = data.dailyCount + '/' + data.dailyLimit;
    $('#min-delay').value = data.settings.minDelay;
    $('#max-delay').value = data.settings.maxDelay;
    $('#batch-size').value = data.settings.batchSize;
    $('#batch-rest').value = data.settings.batchRestMin;
    $('#daily-limit').value = data.settings.dailyLimit;
    $('#simulate-typing').checked = data.settings.simulateTyping;
  } catch (error) {
    console.error('Failed to load status:', error);
  }
}

// Load contacts from server
async function loadContacts() {
  try {
    const res = await fetch('/api/contacts');
    const data = await res.json();
    contacts = data.contacts || [];
    updateContactsUI();
    console.log('Loaded contacts:', contacts.length);
  } catch (error) {
    console.error('Failed to load contacts:', error);
  }
}

// Update connection status UI
function updateConnectionStatus(connected, waInfo) {
  const statusPill = $('#connection-status');
  const statusText = statusPill.querySelector('.status-text');
  statusPill.classList.remove('connected', 'waiting');
  
  if (connected) {
    statusPill.classList.add('connected');
    statusText.textContent = 'Connected';
    $('#connection-info').style.display = 'flex';
    $('#qr-container').style.display = 'none';
    $('#chat-history-card').style.display = 'block';
    if (waInfo) {
      $('#wa-name').textContent = waInfo.pushname || 'WhatsApp User';
      $('#wa-phone').textContent = '+' + (waInfo.wid || 'Unknown');
    }
    $('#wa-status-badge').textContent = 'Online';
    $('#wa-status-badge').classList.remove('offline');
  } else {
    statusText.textContent = 'Disconnected';
    $('#connection-info').style.display = 'none';
    $('#qr-container').style.display = 'block';
    $('#chat-history-card').style.display = 'none';
  }
  updateSendButton();
}

// Update send button state
function updateSendButton() {
  const isConnected = $('#connection-status').classList.contains('connected');
  $('#btn-send').disabled = !isConnected || contacts.length === 0;
}

// Update contacts UI
function updateContactsUI() {
  $('#contacts-badge').textContent = contacts.length;
  $('#contacts-count').textContent = contacts.length + ' kontak';
  const tbody = $('#contacts-table-body');
  
  if (contacts.length > 0) {
    tbody.innerHTML = '';
    contacts.forEach(function(contact, index) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + (index + 1) + '</td>' +
        '<td class="contact-name-cell">' + (contact.name || '-') + '</td>' +
        '<td class="contact-phone-cell">' + contact.phone + '</td>' +
        '<td><button class="btn-delete-row" onclick="deleteContact(' + contact.id + ')"><i class="fas fa-times"></i></button></td>';
      tbody.appendChild(tr);
    });
  } else {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4" style="text-align:center;color:var(--text-muted);padding:30px">Belum ada kontak. Klik tombol di atas untuk menambahkan.</td></tr>';
  }
  updateSendButton();
}

// Render chat list
function renderChats(chats) {
  const chatList = $('#chat-list');
  if (!chats || chats.length === 0) {
    chatList.innerHTML = '<div class="chat-loading">Tidak ada chat</div>';
    return;
  }
  chatList.innerHTML = '';
  chats.forEach(function(chat) {
    const initials = getInitials(chat.name);
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.innerHTML = '<div class="chat-avatar">' + initials + '</div>' +
      '<div class="chat-info"><div class="chat-name">' + (chat.name || chat.id) + '</div>' +
      '<div class="chat-last-message">' + (chat.lastMessage || 'Tidak ada pesan') + '</div></div>' +
      '<div class="chat-meta"><div class="chat-time">' + (chat.timestamp || '') + '</div>' +
      (chat.unreadCount > 0 ? '<div class="chat-unread">' + chat.unreadCount + '</div>' : '') + '</div>';
    chatList.appendChild(item);
  });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

// Add log entry
function addLog(message, type) {
  type = type || 'info';
  const time = new Date().toLocaleTimeString();
  const container = $('#log-container');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  entry.innerHTML = '<span class="time">' + time + '</span><span class="message">' + message + '</span>';
  container.insertBefore(entry, container.firstChild);
  while (container.children.length > 100) container.removeChild(container.lastChild);
}


// ============ EVENT LISTENERS ============
function setupEventListeners() {
  // Upload zone drag & drop
  const uploadZone = $('#upload-zone');
  const contactsFile = $('#contacts-file');
  
  uploadZone.addEventListener('dragover', function(e) {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', function() {
    uploadZone.classList.remove('dragover');
  });
  uploadZone.addEventListener('drop', function(e) {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleContactsFile(e.dataTransfer.files[0]);
  });
  
  $('#browse-link').addEventListener('click', function(e) {
    e.preventDefault();
    contactsFile.click();
  });
  contactsFile.addEventListener('change', function(e) {
    if (e.target.files.length) handleContactsFile(e.target.files[0]);
  });
  
  // Manual contact
  $('#btn-add-contact').addEventListener('click', addManualContact);
  $('#manual-phone').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') addManualContact();
  });
  
  // Spreadsheet
  $('#btn-add-row').addEventListener('click', function() { addSpreadsheetRows(1); });
  $('#btn-save-spreadsheet').addEventListener('click', saveSpreadsheetContacts);
  
  // Media
  $('#btn-attach').addEventListener('click', function() { $('#media-file').click(); });
  $('#media-file').addEventListener('change', handleMediaFile);
  $('#btn-remove-media').addEventListener('click', removeMedia);
  
  // Message preview
  $('#message-template').addEventListener('input', function() {
    $('#char-count').textContent = this.value.length;
    updateMessagePreview();
  });
  
  // Main buttons
  $('#btn-restart').addEventListener('click', restartWhatsApp);
  $('#btn-logout').addEventListener('click', logoutWhatsApp);
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-clear-contacts').addEventListener('click', clearAllContacts);
  $('#btn-send').addEventListener('click', startSending);
  $('#btn-stop').addEventListener('click', stopSending);
  $('#btn-clear-log').addEventListener('click', function() { $('#log-container').innerHTML = ''; });
  $('#btn-refresh-chats').addEventListener('click', refreshChats);
}

// ============ MODALS ============
function setupModals() {
  $('#btn-open-upload').addEventListener('click', function() { openModal('modal-upload'); });
  $('#btn-open-manual').addEventListener('click', function() { openModal('modal-manual'); });
  $('#btn-open-spreadsheet').addEventListener('click', function() { openModal('modal-spreadsheet'); });
  
  $$('.modal-close').forEach(function(btn) {
    btn.addEventListener('click', closeAllModals);
  });
  $$('.modal-overlay').forEach(function(overlay) {
    overlay.addEventListener('click', closeAllModals);
  });
}

function openModal(id) {
  closeAllModals();
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('active');
}

function closeAllModals() {
  $$('.modal').forEach(function(m) { m.classList.remove('active'); });
}

// ============ FORMAT TOOLBAR ============
function setupFormatToolbar() {
  $$('.format-btn[data-format]').forEach(function(btn) {
    btn.addEventListener('click', function() { applyFormat(btn.dataset.format); });
  });
  $$('.format-btn[data-var]').forEach(function(btn) {
    btn.addEventListener('click', function() { insertVariable(btn.dataset.var); });
  });
}

function applyFormat(format) {
  const ta = $('#message-template');
  const start = ta.selectionStart, end = ta.selectionEnd;
  const text = ta.value, selected = text.substring(start, end);
  let wrapper = '';
  if (format === 'bold') wrapper = '*';
  else if (format === 'italic') wrapper = '_';
  else if (format === 'strike') wrapper = '~';
  else if (format === 'mono') wrapper = '```';
  ta.value = text.substring(0, start) + wrapper + selected + wrapper + text.substring(end);
  ta.focus();
  ta.setSelectionRange(start + wrapper.length, end + wrapper.length);
  $('#char-count').textContent = ta.value.length;
  updateMessagePreview();
}

function insertVariable(varName) {
  const ta = $('#message-template');
  const start = ta.selectionStart;
  const variable = '{' + varName + '}';
  ta.value = ta.value.substring(0, start) + variable + ta.value.substring(start);
  ta.focus();
  ta.setSelectionRange(start + variable.length, start + variable.length);
  $('#char-count').textContent = ta.value.length;
  updateMessagePreview();
}

// ============ PRESETS ============
function setupPresets() {
  $$('.preset-card').forEach(function(card) {
    card.addEventListener('click', function() {
      const preset = card.dataset.preset;
      const s = PRESETS[preset];
      $$('.preset-card').forEach(function(c) { c.classList.remove('active'); });
      card.classList.add('active');
      $('#min-delay').value = s.minDelay;
      $('#max-delay').value = s.maxDelay;
      $('#batch-size').value = s.batchSize;
      $('#batch-rest').value = s.batchRest;
      $('#daily-limit').value = s.dailyLimit;
      addLog('Preset "' + preset + '" diterapkan', 'success');
    });
  });
}

// ============ MESSAGE PREVIEW ============
function updateMessagePreview() {
  let text = $('#message-template').value;
  const previewEl = $('#message-preview-content');
  
  if (!text.trim() && !mediaPreviewUrl) {
    previewEl.innerHTML = '<span class="preview-placeholder">Preview akan muncul di sini...</span>';
    return;
  }
  
  text = text.replace(/\{nama\}/gi, '<strong style="color:#d4838f">John Doe</strong>');
  text = text.replace(/\{name\}/gi, '<strong style="color:#d4838f">John Doe</strong>');
  text = text.replace(/\{nomor\}/gi, '<strong style="color:#d4838f">08123456789</strong>');
  text = text.replace(/\{phone\}/gi, '<strong style="color:#d4838f">08123456789</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');
  text = text.replace(/~([^~]+)~/g, '<del>$1</del>');
  text = text.replace(/```([^`]+)```/g, '<code style="background:#e0e0e0;padding:2px 4px;border-radius:3px;font-family:monospace">$1</code>');
  text = text.replace(/\n/g, '<br>');
  
  let mediaHtml = '';
  if (mediaPreviewUrl) {
    mediaHtml = '<img src="' + mediaPreviewUrl + '" alt="Media" style="max-width:100%;border-radius:6px;margin-bottom:8px">';
  }
  previewEl.innerHTML = mediaHtml + text;
}


// ============ CONTACTS FUNCTIONS ============

// Handle file upload - FIXED
async function handleContactsFile(file) {
  console.log('Uploading file:', file.name);
  const formData = new FormData();
  formData.append('file', file);
  
  try {
    const res = await fetch('/api/upload-contacts', { method: 'POST', body: formData });
    const data = await res.json();
    console.log('Upload response:', data);
    
    if (data.success) {
      await loadContacts(); // Reload from server
      addLog(data.contacts.length + ' kontak dimuat dari file', 'success');
      closeAllModals(); // Close modal after success
    } else {
      addLog('Gagal: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Upload error:', error);
    addLog('Error: ' + error.message, 'error');
  }
}

// Add manual contact - FIXED
async function addManualContact() {
  const nameInput = $('#manual-name');
  const phoneInput = $('#manual-phone');
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  
  console.log('Adding manual contact:', name, phone);
  
  if (!phone) {
    addLog('Nomor telepon diperlukan', 'warn');
    return;
  }
  
  try {
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, phone: phone })
    });
    const data = await res.json();
    console.log('Add contact response:', data);
    
    if (data.success) {
      contacts.push(data.contact);
      updateContactsUI();
      nameInput.value = '';
      phoneInput.value = '';
      addLog('Kontak ditambahkan: ' + (name || phone), 'success');
      closeAllModals(); // Close modal after success
    } else {
      addLog('Gagal: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Add contact error:', error);
    addLog('Error: ' + error.message, 'error');
  }
}

// Delete contact - global function
window.deleteContact = async function(id) {
  console.log('Deleting contact:', id);
  try {
    await fetch('/api/contacts/' + id, { method: 'DELETE' });
    contacts = contacts.filter(function(c) { return c.id !== id; });
    updateContactsUI();
    addLog('Kontak dihapus', 'info');
  } catch (error) {
    console.error('Delete error:', error);
    addLog('Error: ' + error.message, 'error');
  }
};

// Clear all contacts
async function clearAllContacts() {
  if (!confirm('Hapus semua kontak?')) return;
  try {
    await fetch('/api/contacts', { method: 'DELETE' });
    contacts = [];
    updateContactsUI();
    addLog('Semua kontak dihapus', 'info');
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

// ============ SPREADSHEET ============
function addSpreadsheetRows(count) {
  const tbody = $('#spreadsheet-body');
  for (let i = 0; i < count; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input type="text" class="ss-name" placeholder="Nama"></td>' +
      '<td><input type="text" class="ss-phone" placeholder="08xxx"></td>' +
      '<td><button class="btn-delete-row" type="button"><i class="fas fa-times"></i></button></td>';
    tbody.appendChild(tr);
    
    tr.querySelector('.btn-delete-row').addEventListener('click', function() {
      this.closest('tr').remove();
    });
    
    tr.querySelector('.ss-phone').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSpreadsheetRows(1);
        const lastRow = tbody.lastElementChild;
        if (lastRow) {
          const nameInput = lastRow.querySelector('.ss-name');
          if (nameInput) nameInput.focus();
        }
      }
    });
  }
}

// Save spreadsheet contacts - FIXED
async function saveSpreadsheetContacts() {
  const rows = $('#spreadsheet-body').querySelectorAll('tr');
  const newContacts = [];
  
  rows.forEach(function(row) {
    const nameInput = row.querySelector('.ss-name');
    const phoneInput = row.querySelector('.ss-phone');
    if (nameInput && phoneInput) {
      const name = nameInput.value.trim();
      const phone = phoneInput.value.trim();
      if (phone) newContacts.push({ name: name, phone: phone });
    }
  });
  
  console.log('Saving spreadsheet contacts:', newContacts);
  
  if (newContacts.length === 0) {
    addLog('Tidak ada kontak untuk disimpan', 'warn');
    return;
  }
  
  try {
    const res = await fetch('/api/contacts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: newContacts })
    });
    const data = await res.json();
    console.log('Bulk save response:', data);
    
    if (data.success) {
      await loadContacts(); // Reload from server
      addLog(newContacts.length + ' kontak ditambahkan', 'success');
      $('#spreadsheet-body').innerHTML = '';
      addSpreadsheetRows(5);
      closeAllModals(); // Close modal after success
    } else {
      addLog('Gagal: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Bulk save error:', error);
    addLog('Error: ' + error.message, 'error');
  }
}

// ============ MEDIA ============
function handleMediaFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  $('#media-preview').style.display = 'flex';
  $('#btn-attach').style.display = 'none';
  $('#media-preview-name').textContent = file.name;
  $('#media-preview-size').textContent = formatFileSize(file.size);
  
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = function(e) {
      mediaPreviewUrl = e.target.result;
      $('#media-preview-image').src = mediaPreviewUrl;
      $('#media-preview-image').style.display = 'block';
      updateMessagePreview();
    };
    reader.readAsDataURL(file);
  } else {
    $('#media-preview-image').style.display = 'none';
    mediaPreviewUrl = null;
  }
  uploadMedia(file);
}

function removeMedia() {
  mediaPath = null;
  mediaPreviewUrl = null;
  $('#media-preview').style.display = 'none';
  $('#btn-attach').style.display = 'block';
  $('#media-file').value = '';
  updateMessagePreview();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function uploadMedia(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload-media', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success) {
      mediaPath = data.filePath;
      addLog('Media berhasil diupload', 'success');
    }
  } catch (error) {
    addLog('Gagal upload: ' + error.message, 'error');
  }
}


// ============ SETTINGS ============
async function saveSettings() {
  const settings = {
    minDelay: parseInt($('#min-delay').value),
    maxDelay: parseInt($('#max-delay').value),
    batchSize: parseInt($('#batch-size').value),
    batchRestMin: parseInt($('#batch-rest').value),
    batchRestMax: parseInt($('#batch-rest').value) + 30,
    dailyLimit: parseInt($('#daily-limit').value),
    simulateTyping: $('#simulate-typing').checked
  };
  
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await res.json();
    if (data.success) addLog('Pengaturan disimpan', 'success');
  } catch (error) {
    addLog('Gagal: ' + error.message, 'error');
  }
}

// ============ WHATSAPP FUNCTIONS ============
async function refreshChats() {
  $('#chat-list').innerHTML = '<div class="chat-loading"><i class="fas fa-spinner fa-spin"></i> Memuat chat...</div>';
  try {
    const res = await fetch('/api/chats/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      renderChats(data.chats);
      addLog(data.chats.length + ' chat dimuat', 'success');
    }
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

async function restartWhatsApp() {
  try {
    $('#qr-placeholder').innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:48px;color:var(--pink-300)"></i><p>Memulai koneksi...</p>';
    $('#qr-placeholder').style.display = 'block';
    $('#qr-code').style.display = 'none';
    await fetch('/api/restart', { method: 'POST' });
    addLog('Memulai koneksi WhatsApp...', 'info');
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

async function logoutWhatsApp() {
  if (!confirm('Yakin ingin logout?')) return;
  try {
    await fetch('/api/logout', { method: 'POST' });
    addLog('Berhasil logout', 'info');
    updateConnectionStatus(false, null);
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

// ============ SENDING ============
async function startSending() {
  const message = $('#message-template').value.trim();
  if (!message && !mediaPath) { alert('Masukkan pesan atau pilih media'); return; }
  if (contacts.length === 0) { alert('Tidak ada kontak'); return; }
  if (!confirm('Kirim pesan ke ' + contacts.length + ' kontak?')) return;
  
  try {
    const res = await fetch('/api/send-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: contacts, message: message, mediaPath: mediaPath })
    });
    const data = await res.json();
    if (data.success) {
      totalContacts = contacts.length;
      $('#btn-send').disabled = true;
      $('#btn-stop').disabled = false;
      $('#progress-section').style.display = 'block';
      resetProgress();
      addLog('Pengiriman dimulai...', 'info');
    } else {
      addLog('Error: ' + data.error, 'error');
    }
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

async function stopSending() {
  try {
    await fetch('/api/stop', { method: 'POST' });
    $('#btn-stop').disabled = true;
    addLog('Menghentikan...', 'warn');
  } catch (error) {
    addLog('Error: ' + error.message, 'error');
  }
}

// ============ PROGRESS ============
function resetProgress() {
  updateProgressRing(0);
  $('#progress-percent').textContent = '0%';
  $('#progress-sent').textContent = '0';
  $('#progress-failed').textContent = '0';
  $('#progress-remaining').textContent = totalContacts;
}

function updateProgressRing(percent) {
  const offset = 326.73 - (percent / 100) * 326.73;
  $('#progress-ring').style.strokeDashoffset = offset;
}

function updateProgress(progress) {
  const percent = Math.round(((progress.sent + progress.failed) / progress.total) * 100);
  updateProgressRing(percent);
  $('#progress-percent').textContent = percent + '%';
  $('#progress-sent').textContent = progress.sent;
  $('#progress-failed').textContent = progress.failed;
  $('#progress-remaining').textContent = progress.total - progress.sent - progress.failed;
}

// ============ SOCKET.IO EVENTS ============
socket.on('status', function(data) {
  updateConnectionStatus(data.status === 'ready', data.waInfo);
  addLog(data.message, data.status === 'ready' ? 'success' : 'info');
  if (data.status === 'waiting_qr') {
    $('#connection-status').classList.add('waiting');
    $('#connection-status').classList.remove('connected');
    $('#connection-status').querySelector('.status-text').textContent = 'Scan QR';
  }
});

socket.on('qr', function(qrDataUrl) {
  $('#qr-code').src = qrDataUrl;
  $('#qr-code').style.display = 'block';
  $('#qr-placeholder').style.display = 'none';
});

socket.on('chats_loaded', function(chats) {
  renderChats(chats);
});

socket.on('log', function(data) {
  addLog(data.message, data.type);
});

socket.on('message_sent', function(data) {
  updateProgress(data.progress);
});

socket.on('message_failed', function(data) {
  updateProgress(data.progress);
});

socket.on('waiting', function(data) {
  $('#waiting-info').style.display = 'flex';
  $('#wait-seconds').textContent = data.delay;
  if (data.isWarmup) {
    $('#warmup-badge').style.display = 'inline';
    $('#warmup-badge').textContent = 'Warmup';
  } else {
    $('#warmup-badge').style.display = 'none';
  }
  let remaining = data.delay;
  const countdown = setInterval(function() {
    remaining--;
    $('#wait-seconds').textContent = remaining;
    if (remaining <= 0) { clearInterval(countdown); $('#waiting-info').style.display = 'none'; }
  }, 1000);
});

socket.on('batch_rest', function(data) {
  $('#waiting-info').style.display = 'flex';
  $('#wait-seconds').textContent = data.duration;
  $('#warmup-badge').textContent = 'Batch ' + data.batch;
  $('#warmup-badge').style.display = 'inline';
  let remaining = data.duration;
  const countdown = setInterval(function() {
    remaining--;
    $('#wait-seconds').textContent = remaining;
    if (remaining <= 0) { clearInterval(countdown); $('#waiting-info').style.display = 'none'; $('#warmup-badge').style.display = 'none'; }
  }, 1000);
});

socket.on('bulk_complete', function(job) {
  $('#btn-send').disabled = false;
  $('#btn-stop').disabled = true;
  $('#waiting-info').style.display = 'none';
  addLog('✅ Selesai! Terkirim: ' + job.sent + ', Gagal: ' + job.failed, 'success');
  loadStatus();
});

socket.on('limit_reached', function(data) {
  alert('Batas harian tercapai (' + data.limit + '). Lanjutkan besok.');
  $('#btn-send').disabled = true;
  $('#btn-stop').disabled = true;
});
