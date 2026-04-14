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

// ── PATHS ────────────────────────────────────────────────────────────────────
const BASE    = path.join(process.env.HOME, 'Desktop/whatsapp-sender');
const REVIEW  = path.join(BASE, 'daily_review.xlsx');
const MASTER  = path.join(BASE, 'whatsapp_final.xlsx');
const VIDEO   = path.join(BASE, 'media/anugnya_video.mp4');
const SESSION = path.join(BASE, 'session');
const LOG     = path.join(BASE, 'send_log.txt');
const HISTORY = path.join(BASE, 'history.json');

// ── STATE ────────────────────────────────────────────────────────────────────
let state = {
  status:         'idle',
  qrDataUrl:      null,
  currentBatch:   0,
  totalBatches:   0,
  sentToday:      0,
  failedToday:    0,
  totalContacts:  0,
  startTime:      null,
  nextBatchAt:    null,
  pauseRequested: false,
  stopRequested:  false,
};

// In-memory contact list — Python scripts write the Excel file
// server.js only reads from Excel, edits happen in memory
let reviewContacts = [];

let waClient = null;

// ── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const ts   = new Date().toLocaleString('en-IN');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
  broadcast({ type: 'log', msg, level: type, ts });
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

function broadcastState() {
  broadcast({ type: 'state', data: { ...state, qrDataUrl: undefined } });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randDelay(min = 15000, max = 40000) {
  return Math.floor(Math.random() * (max - min)) + min;
}

// Load review contacts from Excel into memory
// daily_pick.py writes phones as plain strings — XLSX reads them correctly
function loadReviewFromFile() {
  if (!fs.existsSync(REVIEW)) { reviewContacts = []; return; }
  try {
    const wb   = XLSX.readFile(REVIEW);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    // File: row 1 = banner, row 2 = headers, row 3+ = data
    // range: 1 skips row 1, uses row 2 as headers
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', range: 1, raw: false });

    // Build set of already-sent phones from master list
    const sentPhones = new Set();
    if (fs.existsSync(MASTER)) {
      const mwb  = XLSX.readFile(MASTER);
      const mws  = mwb.Sheets[mwb.SheetNames[0]];
      const mrows = XLSX.utils.sheet_to_json(mws, { defval: '', raw: false });
      mrows.forEach(r => {
        const st = String(r.status || '').trim();
        if (st === 'sent' || st === 'skip') {
          sentPhones.add(String(r['Phone Number'] || '').trim().slice(-10));
        }
      });
    }

    reviewContacts = rows
      .map(r => {
        r['Phone Number'] = String(r['Phone Number'] || '').trim().replace(/\.0+$/, '');
        return r;
      })
      .filter(r => {
        if (!r['Phone Number'] || r['Phone Number'] === 'nan') return false;
        // Exclude already sent or skipped
        if (sentPhones.has(r['Phone Number'].slice(-10))) return false;
        return true;
      });

    log(`📋 Loaded ${reviewContacts.length} contacts from daily_review.xlsx`);
  } catch (e) {
    log('❌ Error reading review file: ' + e.message, 'error');
    reviewContacts = [];
  }
}

function readMaster() {
  if (!fs.existsSync(MASTER)) return [];
  const wb = XLSX.readFile(MASTER);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

function updateMasterSent(sentPhones) {
  const wb    = XLSX.readFile(MASTER);
  const ws    = wb.Sheets[wb.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const today = new Date().toLocaleDateString('en-IN');
  const updated = rows.map(r => {
    const p = String(r['Phone Number'] || '').trim().slice(-10);
    if (sentPhones.has(p)) return { ...r, status: 'sent', sent_date: today };
    return r;
  });
  const newWs = XLSX.utils.json_to_sheet(updated);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  XLSX.writeFile(wb, MASTER);
}

function saveHistory(record) {
  let history = [];
  if (fs.existsSync(HISTORY)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY)); } catch {}
  }
  history.unshift(record);
  if (history.length > 60) history = history.slice(0, 60);
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
}

// ── MESSAGE TEMPLATE ─────────────────────────────────────────────────────────
function buildMessage(contact) {
  const name = (contact.first_name || contact.Name || 'Friend').toString().trim();
  return `Namaste ${name}, our focus going forward is using energy healing to help cancer patients manage treatment side effects — physically, emotionally and mentally — so treatment stays on track. Keep this for someone who might need it.\n\nRajiv\nwww.anugnyaholisticcare.com`;
}

// ── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
function initClient() {
  if (waClient) { try { waClient.destroy(); } catch {} }

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  waClient.on('qr', async qr => {
    state.status    = 'qr';
    state.qrDataUrl = await qrcode.toDataURL(qr);
    broadcast({ type: 'qr', dataUrl: state.qrDataUrl });
    broadcastState();
    log('📱 QR code ready — scan with WhatsApp');
  });

  waClient.on('ready', () => {
    state.status    = 'ready';
    state.qrDataUrl = null;
    broadcastState();
    log('✅ WhatsApp connected and ready');
  });

  waClient.on('auth_failure', () => {
    state.status = 'error';
    broadcastState();
    log('❌ Authentication failed', 'error');
  });

  waClient.on('disconnected', () => {
    state.status = 'idle';
    broadcastState();
    log('⚠️  WhatsApp disconnected', 'warn');
  });

  waClient.initialize();
  state.status = 'connecting';
  broadcastState();
}

// ── SEND LOOP ────────────────────────────────────────────────────────────────
async function runSend() {
  const contacts = reviewContacts;
  if (!contacts.length) { log('❌ No contacts loaded. Run Pick 50 first.', 'error'); return; }

  if (!fs.existsSync(VIDEO)) { log('❌ Video not found: ' + VIDEO, 'error'); return; }

  const videoMedia = MessageMedia.fromFilePath(VIDEO);
  const BATCH      = 10;
  const batches    = [];
  for (let i = 0; i < contacts.length; i += BATCH) batches.push(contacts.slice(i, i + BATCH));

  state.status        = 'sending';
  state.currentBatch  = 0;
  state.totalBatches  = batches.length;
  state.sentToday     = 0;
  state.failedToday   = 0;
  state.totalContacts = contacts.length;
  state.startTime     = new Date().toISOString();
  state.pauseRequested = false;
  state.stopRequested  = false;
  broadcastState();

  log(`🚀 Starting send — ${contacts.length} contacts in ${batches.length} batches`);

  const sentPhones = new Set();

  for (let b = 0; b < batches.length; b++) {
    if (state.stopRequested) { log('🛑 Stopped by user'); break; }

    while (state.pauseRequested) {
      state.status = 'paused'; broadcastState();
      await sleep(5000);
    }
    state.status       = 'sending';
    state.currentBatch = b + 1;
    broadcastState();
    log(`\n📤 Batch ${b + 1}/${batches.length}`);

    for (const contact of batches[b]) {
      if (state.stopRequested) break;

      const phone  = String(contact['Phone Number']).trim();
      const chatId = `${phone}@c.us`;
      const msg    = buildMessage(contact);
      const name   = (contact.first_name || contact.Name || '').toString().trim();

      try {
        await waClient.sendMessage(chatId, videoMedia);
        await sleep(3000);
        await waClient.sendMessage(chatId, msg);
        sentPhones.add(phone.slice(-10));
        state.sentToday++;
        log(`  ✅ ${name} (${phone})`);
        broadcast({ type: 'contact_sent', phone, name, status: 'sent' });
      } catch (err) {
        state.failedToday++;
        log(`  ❌ ${name} (${phone}): ${err.message}`, 'error');
        broadcast({ type: 'contact_sent', phone, name, status: 'failed' });
      }
      broadcastState();

      if (contact !== batches[b][batches[b].length - 1]) {
        const d = randDelay();
        log(`  ⏳ ${Math.round(d / 1000)}s`);
        await sleep(d);
      }
    }

    updateMasterSent(sentPhones);

    if (b < batches.length - 1 && !state.stopRequested) {
      const next = new Date(Date.now() + 2 * 60 * 60 * 1000);
      state.nextBatchAt = next.toISOString();
      log(`⏰ Next batch at ${next.toLocaleTimeString('en-IN')}`);
      broadcastState();
      await sleep(2 * 60 * 60 * 1000);
    }
  }

  saveHistory({
    date:   new Date().toLocaleDateString('en-IN'),
    sent:   state.sentToday,
    failed: state.failedToday,
    total:  state.totalContacts
  });

  state.status      = 'done';
  state.nextBatchAt = null;
  broadcastState();
  log(`\n🎉 Done — Sent: ${state.sentToday} | Failed: ${state.failedToday}`);
}

// ── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => res.json(state));
app.get('/api/qr',     (req, res) => res.json({ qrDataUrl: state.qrDataUrl }));

app.post('/api/connect', (req, res) => {
  initClient();
  res.json({ ok: true });
});

// Get contacts — returns in-memory list
app.get('/api/contacts', (req, res) => {
  res.json(reviewContacts);
});

// Reload contacts from file (called after pick/replenish)
app.post('/api/contacts/reload', (req, res) => {
  loadReviewFromFile();
  res.json({ ok: true, count: reviewContacts.length });
});

// Update a contact — in memory only
app.patch('/api/contacts/:phone', (req, res) => {
  const phone = req.params.phone;
  const idx   = reviewContacts.findIndex(r => String(r['Phone Number']).trim() === phone);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(reviewContacts[idx], req.body);
  res.json({ ok: true });
});

// Delete a contact — remove from memory and mark as skip in master list
app.delete('/api/contacts/:phone', (req, res) => {
  const phone = req.params.phone;

  // Remove from in-memory list
  reviewContacts = reviewContacts.filter(r => String(r['Phone Number']).trim() !== phone);

  // Mark as skip in master list so it is never picked again
  try {
    const wb   = XLSX.readFile(MASTER);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    const updated = rows.map(r => {
      const p = String(r['Phone Number'] || '').trim();
      if (p === phone || p.slice(-10) === phone.slice(-10)) {
        return { ...r, status: 'skip' };
      }
      return r;
    });
    const newWs = XLSX.utils.json_to_sheet(updated);
    wb.Sheets[wb.SheetNames[0]] = newWs;
    XLSX.writeFile(wb, MASTER);
  } catch (e) {
    log('⚠️ Could not update master list for skip: ' + e.message, 'warn');
  }

  res.json({ ok: true, remaining: reviewContacts.length });
});

// Run daily pick — then reload into memory
app.post('/api/pick', (req, res) => {
  const py = path.join(BASE, 'daily_pick.py');
  execFile('python3', [py], (err, stdout, stderr) => {
    if (err) { log('❌ daily_pick.py failed: ' + stderr, 'error'); return res.status(500).json({ error: stderr }); }
    loadReviewFromFile();
    log('📋 Daily pick complete');
    res.json({ ok: true, count: reviewContacts.length, output: stdout });
  });
});

// Run replenish — write current memory state to disk first, then run replenish.py
app.post('/api/replenish', (req, res) => {
  // Write current in-memory contacts back to daily_review.xlsx
  // so replenish.py sees the correct count after UI deletions
  try {
    const XLSX2  = require('xlsx');
    const wb     = XLSX2.readFile(REVIEW);
    const ws     = wb.Sheets[wb.SheetNames[0]];
    // Read banner and header rows (rows 0 and 1)
    const allRows = XLSX2.utils.sheet_to_json(ws, { defval: '', header: 1 });
    const banner  = allRows[0] || [];
    const headers = allRows[1] || [];
    // Rebuild sheet: banner + headers + current memory contacts
    const dataRows = reviewContacts.map(r => headers.map(h => r[h] !== undefined ? String(r[h]) : ''));
    const aoa      = [banner, headers, ...dataRows];
    const newWs    = XLSX2.utils.aoa_to_sheet(aoa);
    wb.Sheets[wb.SheetNames[0]] = newWs;
    XLSX2.writeFile(wb, REVIEW);
  } catch (e) {
    log('⚠️ Could not sync review file before replenish: ' + e.message, 'warn');
  }

  const py = path.join(BASE, 'replenish.py');
  execFile('python3', [py], (err, stdout, stderr) => {
    if (err) { log('❌ replenish.py failed: ' + stderr, 'error'); return res.status(500).json({ error: stderr }); }
    loadReviewFromFile();
    log('➕ Replenish complete');
    res.json({ ok: true, count: reviewContacts.length, output: stdout });
  });
});

// Send controls
app.post('/api/send/start', (req, res) => {
  if (state.status === 'sending') return res.json({ ok: false, msg: 'Already sending' });
  if (state.status !== 'ready')  return res.json({ ok: false, msg: 'WhatsApp not connected' });
  runSend();
  res.json({ ok: true });
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
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-200).reverse();
  res.json({ lines });
});

// History
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(HISTORY)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(HISTORY))); }
  catch { res.json([]); }
});

// Master stats
app.get('/api/master/stats', (req, res) => {
  try {
    const rows    = readMaster();
    const pending = rows.filter(r => String(r.status || 'pending').trim() === 'pending').length;
    const sent    = rows.filter(r => String(r.status || '').trim() === 'sent').length;
    const failed  = rows.filter(r => String(r.status || '').trim() === 'failed').length;
    const skip    = rows.filter(r => String(r.status || '').trim() === 'skip').length;
    res.json({ total: rows.length, pending, sent, failed, skip });
  } catch { res.json({ total: 0, pending: 0, sent: 0, failed: 0, skip: 0 }); }
});

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', data: state }));
  if (state.qrDataUrl) ws.send(JSON.stringify({ type: 'qr', dataUrl: state.qrDataUrl }));
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n✅ Anugnya WhatsApp Sender running`);
  console.log(`   Open: http://localhost:${PORT}\n`);
  // Load any existing review file on startup
  loadReviewFromFile();
});
