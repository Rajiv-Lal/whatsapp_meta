'use strict';

/**
 * Anugnya WhatsApp Sender
 * server.js — Clean rewrite with robust startup
 *
 * Fix: Added server error handler + port-kill on startup
 * to prevent EADDRINUSE crash loop with LaunchAgent.
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const XLSX      = require('xlsx');
const fs        = require('fs');
const path      = require('path');
const qrcode    = require('qrcode');
const { execSync, execFile } = require('child_process');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════════════
// PATHS
// ══════════════════════════════════════════════════════════════════════════════

const BASE    = __dirname;
const REVIEW  = path.join(BASE, 'daily_review.xlsx');
const MASTER  = path.join(BASE, 'whatsapp_final.json');
const VIDEO   = path.join(BASE, 'media', 'anugnya_video.mp4');
const SESSION = path.join(BASE, 'session');
const LOG     = path.join(BASE, 'send_log.txt');
const HISTORY = path.join(BASE, 'history.json');
const CONFIG  = path.join(BASE, 'config.json');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG — all settings editable from UI
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  senderName:       'Rajiv',
  messageTemplate:  'Namaste {name}, our focus going forward is using energy healing to help cancer patients manage treatment side effects — physically, emotionally and mentally — so treatment stays on track. Keep this for someone who might need it.',
  websiteUrl:       'www.anugnyaholisticcare.com',
  dailyLimit:       50,
  batchSize:        10,
  batchIntervalMin: 120,
  delayMinSec:      15,
  delayMaxSec:      40
};

function loadConfig() {
  if (fs.existsSync(CONFIG)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

let state = {
  status:       'idle',  // idle | connecting | qr | ready | sending | paused | error
  qrDataUrl:    null,
  currentBatch: 0,
  totalBatches: 0,
  sentToday:    0,
  failedToday:  0,
  totalContacts: 0,
  startTime:    null,
  nextBatchAt:  null,
  pauseRequested: false,
  stopRequested:  false
};

let reviewContacts = [];
let waClient       = null;

// ══════════════════════════════════════════════════════════════════════════════
// LOGGING & BROADCAST
// ══════════════════════════════════════════════════════════════════════════════

function log(msg, type = 'info') {
  const ts   = new Date().toLocaleString('en-IN');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  broadcast({ type: 'log', msg, level: type, ts });
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

function broadcastState() {
  broadcast({ type: 'state', data: { ...state, qrDataUrl: undefined } });
  if (state.qrDataUrl) broadcast({ type: 'qr', dataUrl: state.qrDataUrl });
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randDelay(minSec, maxSec) {
  return (Math.floor(Math.random() * (maxSec - minSec)) + minSec) * 1000;
}

function loadReviewFromFile() {
  if (!fs.existsSync(REVIEW)) { reviewContacts = []; return; }
  try {
    const wb   = XLSX.readFile(REVIEW);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: 1, raw: false });

    const sentPhones = new Set();
    if (fs.existsSync(MASTER)) {
      JSON.parse(fs.readFileSync(MASTER)).forEach(r => {
        const st = String(r.status || '').trim();
        if (st === 'sent' || st === 'skip' || st === 'noweb') {
          sentPhones.add(String(r['Phone Number'] || '').trim().slice(-10));
        }
      });
    }

    reviewContacts = rows
      .map(r => {
        r['Phone Number'] = String(r['Phone Number'] || '').trim().replace(/\.0+$/, '');
        return r;
      })
      .filter(r => r['Phone Number'] && r['Phone Number'] !== 'nan' && !sentPhones.has(r['Phone Number'].slice(-10)));

    log(`📋 Loaded ${reviewContacts.length} contacts from daily_review.xlsx`);
  } catch (e) {
    log('❌ Error reading review file: ' + e.message, 'error');
    reviewContacts = [];
  }
}

function readMaster() {
  if (!fs.existsSync(MASTER)) return [];
  try { return JSON.parse(fs.readFileSync(MASTER)); } catch { return []; }
}

function saveMaster(rows) {
  fs.writeFileSync(MASTER, JSON.stringify(rows));
}

function updateMasterSent(sentPhones) {
  const rows  = readMaster();
  const today = new Date().toLocaleDateString('en-IN');
  saveMaster(rows.map(r => {
    const p = String(r['Phone Number'] || '').trim().slice(-10);
    return sentPhones.has(p)
      ? { ...r, status: 'sent', dateSent: today }
      : r;
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// WHATSAPP CLIENT
// ══════════════════════════════════════════════════════════════════════════════

function initWhatsApp() {
  if (waClient) {
    log('⚠️ WhatsApp already initialised');
    return;
  }

  log('🔄 Initialising WhatsApp...');
  state.status    = 'connecting';
  state.qrDataUrl = null;
  broadcastState();

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  waClient.on('qr', async (qr) => {
    log('📱 QR code ready — scan with WhatsApp');
    state.status    = 'qr';
    state.qrDataUrl = await qrcode.toDataURL(qr);
    broadcastState();
  });

  waClient.on('ready', () => {
    log('✅ WhatsApp connected');
    state.status    = 'ready';
    state.qrDataUrl = null;
    broadcastState();
  });

  waClient.on('authenticated', () => {
    log('🔐 WhatsApp authenticated');
    state.status = 'connecting';
    broadcastState();
  });

  waClient.on('auth_failure', (msg) => {
    log(`❌ Auth failed: ${msg}`, 'error');
    state.status = 'error';
    waClient     = null;
    broadcastState();
  });

  waClient.on('disconnected', (reason) => {
    log(`❌ WhatsApp disconnected: ${reason}`, 'error');
    state.status    = 'idle';
    state.qrDataUrl = null;
    waClient        = null;
    broadcastState();
  });

  waClient.initialize().catch(err => {
    log(`❌ Init error: ${err.message}`, 'error');
    state.status = 'error';
    waClient     = null;
    broadcastState();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SEND LOGIC
// ══════════════════════════════════════════════════════════════════════════════

async function sendToContact(contact, videoMedia) {
  const cfg   = loadConfig();
  const phone = String(contact['Phone Number']).trim();
  const name  = String(contact['Full Name'] || contact['Name'] || '').split(' ')[0].trim() || 'Friend';

  const chatId  = (phone.startsWith('91') ? phone : '91' + phone.slice(-10)) + '@c.us';
  const message = cfg.messageTemplate.replace('{name}', name);

  try {
    // Send video first
    if (videoMedia && fs.existsSync(VIDEO)) {
      await waClient.sendMessage(chatId, videoMedia);
      await sleep(2000);
    }
    // Send text
    await waClient.sendMessage(chatId, message);

    state.sentToday++;
    log(`  ✅ ${name} (${phone})`);

    // Append to history
    const history = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY)) : [];
    history.unshift({ phone, name, status: 'sent', ts: new Date().toISOString() });
    fs.writeFileSync(HISTORY, JSON.stringify(history.slice(0, 5000)));

    return true;
  } catch (err) {
    state.failedToday++;
    log(`  ❌ ${name} (${phone}): ${err.message}`, 'error');

    const history = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY)) : [];
    history.unshift({ phone, name, status: 'failed', error: err.message, ts: new Date().toISOString() });
    fs.writeFileSync(HISTORY, JSON.stringify(history.slice(0, 5000)));

    return false;
  }
}

async function runSend() {
  const cfg   = loadConfig();
  const limit = cfg.dailyLimit;

  if (!fs.existsSync(VIDEO)) {
    log('❌ Video file not found at ' + VIDEO, 'error');
    state.status = 'ready';
    broadcastState();
    return;
  }

  const toSend = reviewContacts.filter(c => !c._sent).slice(0, limit);
  if (!toSend.length) {
    log('❌ No contacts to send to', 'error');
    state.status = 'ready';
    broadcastState();
    return;
  }

  const batchSize   = cfg.batchSize;
  const batches     = [];
  for (let i = 0; i < toSend.length; i += batchSize) {
    batches.push(toSend.slice(i, i + batchSize));
  }

  state.status       = 'sending';
  state.totalBatches = batches.length;
  state.totalContacts = toSend.length;
  state.startTime    = new Date().toISOString();
  state.sentToday    = 0;
  state.failedToday  = 0;
  state.pauseRequested = false;
  state.stopRequested  = false;
  broadcastState();

  log(`🚀 Starting send — ${toSend.length} contacts in ${batches.length} batches`);

  const videoMedia   = MessageMedia.fromFilePath(VIDEO);
  const sentPhones   = new Set();

  for (let b = 0; b < batches.length; b++) {
    if (state.stopRequested) { log('🛑 Stopped'); break; }
    while (state.pauseRequested) {
      await sleep(5000);
      if (state.stopRequested) break;
    }

    state.currentBatch = b + 1;
    broadcastState();
    log(`📦 Batch ${b + 1}/${batches.length}`);

    for (const contact of batches[b]) {
      if (state.stopRequested) break;

      const phone = String(contact['Phone Number']).trim();
      const sent  = await sendToContact(contact, videoMedia);
      if (sent) { sentPhones.add(phone.slice(-10)); contact._sent = true; }
      broadcastState();
      await sleep(randDelay(cfg.delayMinSec, cfg.delayMaxSec));
    }

    if (b < batches.length - 1 && !state.stopRequested) {
      const nextAt = new Date(Date.now() + cfg.batchIntervalMin * 60 * 1000);
      state.nextBatchAt = nextAt.toISOString();
      broadcastState();
      log(`⏸ Batch done. Next at ${nextAt.toLocaleTimeString('en-IN')}`);
      await sleep(cfg.batchIntervalMin * 60 * 1000);
      state.nextBatchAt = null;
    }
  }

  updateMasterSent(sentPhones);
  log(`✅ Send complete — ${state.sentToday} sent, ${state.failedToday} failed`);
  state.status    = 'ready';
  state.startTime = null;
  broadcastState();
}

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Status
app.get('/api/status', (req, res) => {
  res.json({ ...state, contactsLoaded: reviewContacts.length });
});

app.get('/api/qr', (req, res) => {
  res.json({ qrDataUrl: state.qrDataUrl, status: state.status });
});

// WhatsApp connection
app.post('/api/connect', (req, res) => {
  if (state.status === 'ready') return res.json({ ok: true, msg: 'Already connected' });
  if (state.status === 'connecting' || state.status === 'qr') return res.json({ ok: true, msg: 'Connecting...' });
  initWhatsApp();
  res.json({ ok: true });
});

app.post('/api/disconnect', async (req, res) => {
  if (waClient) {
    try { await waClient.logout(); } catch {}
    waClient     = null;
    state.status = 'idle';
    state.qrDataUrl = null;
    broadcastState();
  }
  res.json({ ok: true });
});

// Config / Settings
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

app.post('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// Contacts — reload from xlsx
app.post('/api/contacts/reload', (req, res) => {
  loadReviewFromFile();
  res.json({ ok: true, count: reviewContacts.length });
});

app.get('/api/contacts', (req, res) => {
  const limit  = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  res.json({
    total:    reviewContacts.length,
    contacts: reviewContacts.slice(offset, offset + limit)
  });
});

// Master stats
app.get('/api/stats', (req, res) => {
  try {
    const rows = readMaster();
    res.json({
      total:   rows.length,
      pending: rows.filter(r => !String(r.status || '').trim() || String(r.status).trim() === 'pending').length,
      sent:    rows.filter(r => String(r.status || '').trim() === 'sent').length,
      failed:  rows.filter(r => String(r.status || '').trim() === 'failed').length,
      skip:    rows.filter(r => String(r.status || '').trim() === 'skip').length
    });
  } catch { res.json({ total: 0, pending: 0, sent: 0, failed: 0, skip: 0 }); }
});

// Replenish contacts from Python script
app.post('/api/replenish', (req, res) => {
  const scriptPath = path.join(BASE, 'replenish.py');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'replenish.py not found' });
  }
  execFile('python3', [scriptPath], (err, stdout, stderr) => {
    if (err) {
      log('❌ replenish.py failed: ' + stderr, 'error');
      return res.status(500).json({ error: stderr });
    }
    loadReviewFromFile();
    log('➕ Replenish complete — ' + reviewContacts.length + ' contacts');
    res.json({ ok: true, count: reviewContacts.length });
  });
});

// Send controls
app.post('/api/send/start', (req, res) => {
  if (state.status === 'sending') return res.json({ ok: false, msg: 'Already sending' });
  if (state.status !== 'ready')  return res.json({ ok: false, msg: 'WhatsApp not connected' });
  runSend();
  res.json({ ok: true });
});

// Manual send — N contacts immediately
app.post('/api/send/manual', async (req, res) => {
  if (state.status !== 'ready')   return res.json({ ok: false, msg: 'WhatsApp not connected' });
  if (state.status === 'sending') return res.json({ ok: false, msg: 'Already sending' });
  if (!fs.existsSync(VIDEO))      return res.json({ ok: false, msg: 'Video file not found' });

  const cfg     = loadConfig();
  const count   = Math.min(parseInt(req.body.count) || 1, 50);
  const toSend  = reviewContacts.filter(c => !c._sent).slice(0, count);
  if (!toSend.length) return res.json({ ok: false, msg: 'No contacts to send to' });

  res.json({ ok: true, sending: toSend.length });

  const videoMedia = MessageMedia.fromFilePath(VIDEO);
  const sentPhones = new Set();
  state.sentToday  = state.sentToday  || 0;
  state.failedToday = state.failedToday || 0;

  log(`📤 Manual send — ${toSend.length} contacts`);

  for (const contact of toSend) {
    const phone = String(contact['Phone Number']).trim();
    if (await sendToContact(contact, videoMedia)) {
      sentPhones.add(phone.slice(-10));
      contact._sent = true;
    }
    broadcastState();
    await sleep(randDelay(cfg.delayMinSec, cfg.delayMaxSec));
  }

  updateMasterSent(sentPhones);
  log('✅ Manual send complete');
});

app.post('/api/send/pause', (req, res) => {
  state.pauseRequested = !state.pauseRequested;
  log(state.pauseRequested ? '⏸ Paused' : '▶️ Resumed');
  res.json({ ok: true, paused: state.pauseRequested });
});

app.post('/api/send/stop', (req, res) => {
  state.stopRequested = true;
  log('🛑 Stop requested');
  res.json({ ok: true });
});

// Log
app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG)) return res.json({ lines: [] });
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-200).reverse();
    res.json({ lines });
  } catch { res.json({ lines: [] }); }
});

// History
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(HISTORY)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(HISTORY))); } catch { res.json([]); }
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', data: { ...state, qrDataUrl: undefined } }));
  if (state.qrDataUrl) ws.send(JSON.stringify({ type: 'qr', dataUrl: state.qrDataUrl }));
});

// ══════════════════════════════════════════════════════════════════════════════
// START — with port conflict protection
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

// Kill anything holding this port before we try to bind
try {
  execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
  // Give OS time to release the port
  const waitStart = Date.now();
  while (Date.now() - waitStart < 1500) { /* sync wait 1.5s */ }
} catch {}

// Error handler — if port still in use, kill and retry once
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} still in use — retrying in 3 seconds...`);
    try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    setTimeout(() => {
      server.close();
      server.listen(PORT, onListening);
    }, 3000);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

function onListening() {
  console.log(`\n✅ Anugnya WhatsApp Sender running`);
  console.log(`   Open: http://localhost:${PORT}\n`);
  loadReviewFromFile();
  // Auto-init WhatsApp on startup if session exists
  const sessionExists = fs.existsSync(path.join(SESSION, 'session'));
  if (sessionExists) {
    log('🔄 Existing session found — reconnecting WhatsApp...');
    initWhatsApp();
  }
}

server.listen(PORT, onListening);
