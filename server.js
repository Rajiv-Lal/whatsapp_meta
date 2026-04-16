const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const XLSX       = require('xlsx');
const fs         = require('fs');
const path       = require('path');
const qrcode     = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { execFile } = require('child_process');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── PATHS ─────────────────────────────────────────────────────────────────────
const BASE    = __dirname;
const REVIEW  = path.join(BASE, 'daily_review.xlsx');
const MASTER  = path.join(BASE, 'whatsapp_final.json');
const VIDEO   = path.join(BASE, 'media', 'anugnya_video.mp4');
const SESSION = path.join(BASE, 'session');
const LOG     = path.join(BASE, 'send_log.txt');
const HISTORY = path.join(BASE, 'history.json');
const CONFIG  = path.join(BASE, 'config.json');

// ── CONFIG — all settings editable from UI ────────────────────────────────────
const DEFAULT_CONFIG = {
  senderName:      'Rajiv',
  messageTemplate: 'Namaste {name}, our focus going forward is using energy healing to help cancer patients manage treatment side effects — physically, emotionally and mentally — so treatment stays on track. Keep this for someone who might need it.',
  websiteUrl:      'www.anugnyaholisticcare.com',
  dailyLimit:      50,
  batchSize:       10,
  batchIntervalMin: 120,
  delayMinSec:     15,
  delayMaxSec:     40
};

function loadConfig() {
  if (fs.existsSync(CONFIG)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG)) }; } catch {}
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2)); }

// ── STATE ─────────────────────────────────────────────────────────────────────
let state = {
  status: 'idle', qrDataUrl: null, currentBatch: 0, totalBatches: 0,
  sentToday: 0, failedToday: 0, totalContacts: 0, startTime: null,
  nextBatchAt: null, pauseRequested: false, stopRequested: false,
};
let reviewContacts = [];
let waClient = null;

// ── LOGGING ───────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const ts = new Date().toLocaleString('en-IN');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
  broadcast({ type: 'log', msg, level: type, ts });
}
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}
function broadcastState() { broadcast({ type: 'state', data: { ...state, qrDataUrl: undefined } }); }

// ── HELPERS ───────────────────────────────────────────────────────────────────
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
        if (st === 'sent' || st === 'skip') sentPhones.add(String(r['Phone Number'] || '').trim().slice(-10));
      });
    }
    reviewContacts = rows
      .map(r => { r['Phone Number'] = String(r['Phone Number'] || '').trim().replace(/\.0+$/, ''); return r; })
      .filter(r => r['Phone Number'] && r['Phone Number'] !== 'nan' && !sentPhones.has(r['Phone Number'].slice(-10)));
    log(`📋 Loaded ${reviewContacts.length} contacts from daily_review.xlsx`);
  } catch (e) { log('❌ Error reading review file: ' + e.message, 'error'); reviewContacts = []; }
}

function readMaster() {
  if (!fs.existsSync(MASTER)) return [];
  return JSON.parse(fs.readFileSync(MASTER));
}
function saveMaster(rows) { fs.writeFileSync(MASTER, JSON.stringify(rows)); }

function updateMasterSent(sentPhones) {
  const rows  = readMaster();
  const today = new Date().toLocaleDateString('en-IN');
  saveMaster(rows.map(r => {
    const p = String(r['Phone Number'] || '').trim().slice(-10);
    return sentPhones.has(p) ? { ...r, status: 'sent', sent_date: today } : r;
  }));
}

function saveHistory(record) {
  let h = [];
  if (fs.existsSync(HISTORY)) { try { h = JSON.parse(fs.readFileSync(HISTORY)); } catch {} }
  h.unshift(record);
  if (h.length > 60) h = h.slice(0, 60);
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2));
}

function buildMessage(contact) {
  const cfg  = loadConfig();
  const name = (contact.first_name || contact.Name || 'Friend').toString().trim();
  return `${cfg.messageTemplate.replace(/{name}/g, name)}\n\n${cfg.senderName}\n${cfg.websiteUrl}`;
}

// ── WHATSAPP CLIENT ───────────────────────────────────────────────────────────
function initClient() {
  if (waClient) { try { waClient.destroy(); } catch {} }
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
  });
  waClient.on('qr', async qr => {
    state.status = 'qr'; state.qrDataUrl = await qrcode.toDataURL(qr);
    broadcast({ type: 'qr', dataUrl: state.qrDataUrl }); broadcastState();
    log('📱 QR code ready — scan with WhatsApp');
  });
  waClient.on('ready', () => { state.status = 'ready'; state.qrDataUrl = null; broadcastState(); log('✅ WhatsApp connected and ready'); });
  waClient.on('auth_failure', () => { state.status = 'error'; broadcastState(); log('❌ Authentication failed', 'error'); });
  waClient.on('disconnected', () => { state.status = 'idle'; broadcastState(); log('⚠️  WhatsApp disconnected', 'warn'); });
  waClient.initialize();
  state.status = 'connecting'; broadcastState();
}

// ── SEND ONE CONTACT ──────────────────────────────────────────────────────────
async function sendToContact(contact, videoMedia) {
  const phone  = String(contact['Phone Number']).trim();
  const chatId = `${phone}@c.us`;
  const name   = (contact.first_name || contact.Name || '').toString().trim();
  try {
    await waClient.sendMessage(chatId, videoMedia);
    await sleep(3000);
    await waClient.sendMessage(chatId, buildMessage(contact));
    state.sentToday++;
    log(`  ✅ ${name} (${phone})`);
    broadcast({ type: 'contact_sent', phone, name, status: 'sent' });
    return true;
  } catch (err) {
    state.failedToday++;
    log(`  ❌ ${name} (${phone}): ${err.message}`, 'error');
    broadcast({ type: 'contact_sent', phone, name, status: 'failed' });
    return false;
  }
}

// ── SEND LOOP — uses config for all timing and volume ─────────────────────────
async function runSend() {
  const cfg      = loadConfig();
  const contacts = reviewContacts.slice(0, cfg.dailyLimit);
  if (!contacts.length) { log('❌ No contacts loaded. Run Pick first.', 'error'); return; }
  if (!fs.existsSync(VIDEO)) { log('❌ Video not found: ' + VIDEO, 'error'); return; }

  const videoMedia = MessageMedia.fromFilePath(VIDEO);
  const batches = [];
  for (let i = 0; i < contacts.length; i += cfg.batchSize) batches.push(contacts.slice(i, i + cfg.batchSize));

  state.status = 'sending'; state.currentBatch = 0; state.totalBatches = batches.length;
  state.sentToday = 0; state.failedToday = 0; state.totalContacts = contacts.length;
  state.startTime = new Date().toISOString(); state.pauseRequested = false; state.stopRequested = false;
  broadcastState();
  log(`🚀 Starting send — ${contacts.length} contacts in ${batches.length} batches (${cfg.batchSize}/batch, ${cfg.batchIntervalMin}min intervals)`);

  const sentPhones = new Set();
  for (let b = 0; b < batches.length; b++) {
    if (state.stopRequested) { log('🛑 Stopped by user'); break; }
    while (state.pauseRequested) { state.status = 'paused'; broadcastState(); await sleep(5000); }
    state.status = 'sending'; state.currentBatch = b + 1; broadcastState();
    log(`\n📤 Batch ${b + 1}/${batches.length}`);
    for (const contact of batches[b]) {
      if (state.stopRequested) break;
      const phone = String(contact['Phone Number']).trim();
      if (await sendToContact(contact, videoMedia)) sentPhones.add(phone.slice(-10));
      broadcastState();
      if (contact !== batches[b][batches[b].length - 1]) {
        const d = randDelay(cfg.delayMinSec, cfg.delayMaxSec);
        log(`  ⏳ ${Math.round(d/1000)}s`); await sleep(d);
      }
    }
    updateMasterSent(sentPhones);
    if (b < batches.length - 1 && !state.stopRequested) {
      const intervalMs = cfg.batchIntervalMin * 60 * 1000;
      const next = new Date(Date.now() + intervalMs);
      state.nextBatchAt = next.toISOString();
      log(`⏰ Next batch at ${next.toLocaleTimeString('en-IN')}`); broadcastState();
      await sleep(intervalMs);
    }
  }
  saveHistory({ date: new Date().toLocaleDateString('en-IN'), sent: state.sentToday, failed: state.failedToday, total: state.totalContacts });
  state.status = 'done'; state.nextBatchAt = null; broadcastState();
  log(`\n🎉 Done — Sent: ${state.sentToday} | Failed: ${state.failedToday}`);
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json(state));
app.get('/api/qr',     (req, res) => res.json({ qrDataUrl: state.qrDataUrl }));
app.post('/api/connect', (req, res) => { initClient(); res.json({ ok: true }); });

// Config
app.get('/api/config',  (req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  // Ensure numbers are stored as numbers
  ['dailyLimit','batchSize','batchIntervalMin','delayMinSec','delayMaxSec'].forEach(k => {
    if (cfg[k] !== undefined) cfg[k] = parseInt(cfg[k]);
  });
  saveConfig(cfg);
  res.json({ ok: true, config: cfg });
});

// Contacts
app.get('/api/contacts', (req, res) => res.json(reviewContacts));
app.post('/api/contacts/reload', (req, res) => { loadReviewFromFile(); res.json({ ok: true, count: reviewContacts.length }); });
app.patch('/api/contacts/:phone', (req, res) => {
  const idx = reviewContacts.findIndex(r => String(r['Phone Number']).trim() === req.params.phone);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(reviewContacts[idx], req.body); res.json({ ok: true });
});
app.delete('/api/contacts/:phone', (req, res) => {
  const phone = req.params.phone;
  reviewContacts = reviewContacts.filter(r => String(r['Phone Number']).trim() !== phone);
  try {
    const rows = readMaster();
    saveMaster(rows.map(r => { const p = String(r['Phone Number']||'').trim(); return (p===phone||p.slice(-10)===phone.slice(-10)) ? {...r,status:'skip'} : r; }));
  } catch (e) { log('⚠️ Could not update master for skip: ' + e.message, 'warn'); }
  res.json({ ok: true, remaining: reviewContacts.length });
});

// Pick
app.post('/api/pick', (req, res) => {
  execFile('python3', [path.join(BASE, 'daily_pick.py')], (err, stdout, stderr) => {
    if (err) { log('❌ daily_pick.py failed: ' + stderr, 'error'); return res.status(500).json({ error: stderr }); }
    loadReviewFromFile(); log('📋 Daily pick complete');
    res.json({ ok: true, count: reviewContacts.length });
  });
});

// Replenish
app.post('/api/replenish', (req, res) => {
  try {
    const wb = XLSX.readFile(REVIEW); const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
    const banner = allRows[0]||[]; const headers = allRows[1]||[];
    wb.Sheets[wb.SheetNames[0]] = XLSX.utils.aoa_to_sheet([banner, headers, ...reviewContacts.map(r => headers.map(h => r[h]!==undefined ? String(r[h]) : ''))]);
    XLSX.writeFile(wb, REVIEW);
  } catch (e) { log('⚠️ Could not sync review before replenish: ' + e.message, 'warn'); }
  execFile('python3', [path.join(BASE, 'replenish.py')], (err, stdout, stderr) => {
    if (err) { log('❌ replenish.py failed: ' + stderr, 'error'); return res.status(500).json({ error: stderr }); }
    loadReviewFromFile(); log('➕ Replenish complete');
    res.json({ ok: true, count: reviewContacts.length });
  });
});

// Send controls
app.post('/api/send/start', (req, res) => {
  if (state.status === 'sending') return res.json({ ok: false, msg: 'Already sending' });
  if (state.status !== 'ready')  return res.json({ ok: false, msg: 'WhatsApp not connected' });
  runSend(); res.json({ ok: true });
});

// Manual send — N contacts immediately
app.post('/api/send/manual', async (req, res) => {
  if (state.status !== 'ready') return res.json({ ok: false, msg: 'WhatsApp not connected' });
  if (!fs.existsSync(VIDEO))    return res.json({ ok: false, msg: 'Video not found' });
  const cfg    = loadConfig();
  const count  = Math.min(parseInt(req.body.count) || 1, 50);
  const toSend = reviewContacts.filter(c => !c._sent).slice(0, count);
  if (!toSend.length) return res.json({ ok: false, msg: 'No contacts to send to' });
  res.json({ ok: true, sending: toSend.length });
  const videoMedia = MessageMedia.fromFilePath(VIDEO);
  const sentPhones = new Set();
  log(`📤 Manual send — ${toSend.length} contacts`);
  for (const contact of toSend) {
    const phone = String(contact['Phone Number']).trim();
    if (await sendToContact(contact, videoMedia)) { sentPhones.add(phone.slice(-10)); contact._sent = true; }
    await sleep(randDelay(cfg.delayMinSec, cfg.delayMaxSec));
  }
  updateMasterSent(sentPhones);
  log(`✅ Manual send complete`);
});

app.post('/api/send/pause', (req, res) => { state.pauseRequested = !state.pauseRequested; log(state.pauseRequested ? '⏸ Paused' : '▶️ Resumed'); res.json({ ok: true, paused: state.pauseRequested }); });
app.post('/api/send/stop',  (req, res) => { state.stopRequested = true; log('🛑 Stop requested'); res.json({ ok: true }); });

// Log
app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG)) return res.json({ lines: [] });
  res.json({ lines: fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-200).reverse() });
});

// History
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(HISTORY)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(HISTORY))); } catch { res.json([]); }
});

// Master stats
app.get('/api/master/stats', (req, res) => {
  try {
    const rows = readMaster();
    res.json({
      total:   rows.length,
      pending: rows.filter(r => String(r.status||'pending').trim() === 'pending').length,
      sent:    rows.filter(r => String(r.status||'').trim() === 'sent').length,
      failed:  rows.filter(r => String(r.status||'').trim() === 'failed').length,
      skip:    rows.filter(r => String(r.status||'').trim() === 'skip').length,
    });
  } catch { res.json({ total:0, pending:0, sent:0, failed:0, skip:0 }); }
});

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', data: state }));
  if (state.qrDataUrl) ws.send(JSON.stringify({ type: 'qr', dataUrl: state.qrDataUrl }));
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅ Anugnya WhatsApp Sender running`);
  console.log(`   Open: http://localhost:${PORT}\n`);
  loadReviewFromFile();
});
