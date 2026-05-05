'use strict';

/**
 * WhatsApp Sender v3
 * server.js
 *
 * Port: 3004
 * Features: Campaign management, Excel/CSV import, labels, WA check,
 *           media (image/video/PDF), auto/manual pace mode, batch sending
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const multer    = require('multer');
const XLSX      = require('xlsx');
const qrcode    = require('qrcode');
const { execSync } = require('child_process');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const db        = require('./database/db');

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Paths ─────────────────────────────────────────────────────────────────────
const BASE        = __dirname;
const SESSION_DIR = path.join(BASE, 'sessions');
const UPLOADS_DIR = path.join(BASE, 'uploads');
const LOG_FILE    = path.join(BASE, 'send.log');

[SESSION_DIR, UPLOADS_DIR, path.join(BASE, 'data')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── File uploads (contacts + media) ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ══════════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════════

let state = {
  whatsapp: 'disconnected', // disconnected | connecting | qr | ready | error
  qrDataUrl: null,
  sending: null  // null or { campaignId, campaignName, status, currentBatch,
                 //           totalBatches, sent, failed, skipped, total,
                 //           startTime, nextBatchAt, pauseRequested, stopRequested }
};

let waClient = null;

// ══════════════════════════════════════════════════════════════════════════════
// LOGGING & BROADCAST
// ══════════════════════════════════════════════════════════════════════════════

function log(msg, type = 'info') {
  const ts   = new Date().toLocaleString('en-IN');
  const line = `[${ts}] [${type.toUpperCase()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  broadcast({ type: 'log', msg, level: type, ts });
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}

function broadcastState() {
  broadcast({ type: 'state', data: { ...state, qrDataUrl: undefined } });
  if (state.qrDataUrl) broadcast({ type: 'qr', dataUrl: state.qrDataUrl });
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function randDelay(minSec, maxSec) {
  return (Math.floor(Math.random() * (maxSec - minSec)) + minSec) * 1000;
}

/**
 * Build the message text for a contact.
 * Supports {name}, {first_name}, {last_name}, {label} placeholders.
 */
function buildMessage(campaign, contact) {
  const firstName = contact.first_name || contact.name?.split(' ')[0] || 'Friend';
  const lastName  = contact.last_name  || '';
  const fullName  = contact.name       || `${firstName} ${lastName}`.trim();
  const label     = contact.label      || '';

  let msg = '';

  if (campaign.salutation) {
    msg += `${campaign.salutation} ${firstName},\n\n`;
  }

  msg += (campaign.message_template || '')
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{last_name\}/gi,  lastName)
    .replace(/\{name\}/gi,       fullName)
    .replace(/\{label\}/gi,      label);

  if (campaign.signature) {
    msg += `\n\n${campaign.signature}`;
  }

  return msg.trim();
}

/**
 * Parse an uploaded Excel or CSV file into an array of row objects.
 */
function parseUploadedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const wb  = XLSX.readFile(filePath);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

// ══════════════════════════════════════════════════════════════════════════════
// WHATSAPP CLIENT
// ══════════════════════════════════════════════════════════════════════════════

function initWhatsApp() {
  if (waClient) { log('⚠️ WhatsApp client already exists'); return; }

  // Clear browser lock files that prevent restart
  const lockFiles = ['SingletonLock','SingletonSocket','SingletonCookie'];
  const sessionPath = path.join(SESSION_DIR, 'session');
  lockFiles.forEach(f => {
    const p = path.join(sessionPath, f);
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
  });

  log('🔄 Initialising WhatsApp...');
  state.whatsapp  = 'connecting';
  state.qrDataUrl = null;
  broadcastState();

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  waClient.on('qr', async (qr) => {
    log('📱 QR code ready — scan with WhatsApp');
    state.whatsapp  = 'qr';
    state.qrDataUrl = await qrcode.toDataURL(qr);
    broadcastState();
  });

  waClient.on('ready', () => {
    log('✅ WhatsApp connected and ready');
    state.whatsapp  = 'ready';
    state.qrDataUrl = null;
    db.setSetting('whatsapp_status', 'ready');
    broadcastState();
  });

  waClient.on('authenticated', () => {
    log('🔐 WhatsApp authenticated');
    state.whatsapp = 'connecting';
    broadcastState();
  });

  waClient.on('auth_failure', (msg) => {
    log(`❌ WhatsApp auth failed: ${msg}`, 'error');
    state.whatsapp = 'error';
    waClient       = null;
    broadcastState();
  });

  waClient.on('disconnected', (reason) => {
    log(`❌ WhatsApp disconnected: ${reason}`, 'error');
    state.whatsapp  = 'disconnected';
    state.qrDataUrl = null;
    waClient        = null;
    db.setSetting('whatsapp_status', 'disconnected');
    broadcastState();
  });

  waClient.initialize().catch(err => {
    log(`❌ WhatsApp init error: ${err.message}`, 'error');
    state.whatsapp = 'error';
    waClient       = null;
    broadcastState();
  });
}

/**
 * Send a single WhatsApp message with optional media.
 */
async function sendMessage(phone, message, mediaPath = null, mediaFirst = false) {
  if (!waClient || state.whatsapp !== 'ready') {
    return { success: false, error: 'WhatsApp not connected' };
  }

  try {
    const chatId = phone + '@c.us';
    let   media  = null;

    if (mediaPath && fs.existsSync(mediaPath)) {
      media = MessageMedia.fromFilePath(mediaPath);
    }

    if (media && mediaFirst) {
      await waClient.sendMessage(chatId, media);
      await sleep(1500);
      await waClient.sendMessage(chatId, message);
    } else if (media && !mediaFirst) {
      await waClient.sendMessage(chatId, message);
      await sleep(1500);
      await waClient.sendMessage(chatId, media);
    } else {
      await waClient.sendMessage(chatId, message);
    }

    return { success: true };
  } catch (err) {
    const errText = err.message || String(err) || 'Send failed';
    console.error('[sendMessage] Error for', phone, '—', errText, '| raw:', JSON.stringify(err));

    // Detached frame = Chrome page died — force reconnect
    if (errText.includes('detached Frame') || errText.includes('Execution context was destroyed')) {
      log('⚠️ Detached frame detected — reconnecting WhatsApp...', 'error');
      state.whatsapp = 'disconnected';
      broadcastState();
      try { await waClient.destroy(); } catch {}
      waClient = null;
      setTimeout(initWhatsApp, 3000);
    }

    return { success: false, error: errText };
  }
}

/**
 * Check if a phone number is registered on WhatsApp.
 */
async function checkWaNumber(phone) {
  if (!waClient || state.whatsapp !== 'ready') return null;
  try {
    const isRegistered = await waClient.isRegisteredUser(phone + '@c.us');
    return isRegistered;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// SENDING ENGINE
// ══════════════════════════════════════════════════════════════════════════════

async function runCampaign(campaignId) {
  const campaign = db.getCampaign(campaignId);
  if (!campaign) { log(`❌ Campaign ${campaignId} not found`, 'error'); return; }

  const settings  = db.getCampaignSettings(campaignId);
  const daily     = settings.daily_limit;
  const mediaFirst = parseInt(settings.media_first) === 1 || parseInt(campaign.media_first) === 1;
  const mediaPath  = campaign.media_path || null;

  // Get queued contacts (picked for today's review)
  const contacts = db.getQueuedContacts(campaignId);
  if (!contacts.length) {
    log(`⚠️ No queued contacts in campaign "${campaign.name}". Use Pick Contacts to build today's list.`);
    state.sending = null;
    broadcastState();
    return;
  }

  // Split into batches
  const batchSize = settings.batch_size;
  const batches   = [];
  for (let i = 0; i < contacts.length; i += batchSize) {
    batches.push(contacts.slice(i, i + batchSize));
  }

  state.sending = {
    campaignId,
    campaignName:  campaign.name,
    status:        'sending',
    currentBatch:  0,
    totalBatches:  batches.length,
    sent:          0,
    failed:        0,
    skipped:       0,
    noweb:         0,
    total:         contacts.length,
    startTime:     new Date().toISOString(),
    nextBatchAt:   null,
    pauseRequested: false,
    stopRequested:  false
  };

  db.updateCampaign(campaignId, { status: 'active' });
  broadcastState();
  log(`🚀 Campaign "${campaign.name}" — ${contacts.length} contacts, ${batches.length} batches`);

  for (let b = 0; b < batches.length; b++) {
    if (state.sending.stopRequested) { log('🛑 Stopped by user'); break; }

    // Wait while paused
    while (state.sending.pauseRequested) {
      await sleep(3000);
      if (state.sending.stopRequested) break;
    }
    if (state.sending.stopRequested) break;

    state.sending.currentBatch = b + 1;
    broadcastState();
    log(`📦 Batch ${b + 1}/${batches.length} — ${batches[b].length} contacts`);

    for (const contact of batches[b]) {
      if (state.sending.stopRequested) break;

      // WA check if enabled
      if (settings.wa_check_enabled && contact.wa_valid === null) {
        const isWa = await checkWaNumber(contact.phone);
        if (isWa !== null) db.setWaValid(campaignId, contact.phone, isWa);
        if (isWa === false) {
          db.updateContactStatus(contact.id, 'noweb');
          db.recordHistory({
            campaign_id: campaignId, campaign_contact_id: contact.id,
            campaign_name: campaign.name, phone: contact.phone,
            name: contact.name, label: contact.label, status: 'noweb'
          });
          state.sending.noweb++;
          log(`📵 Not on WA: ${contact.first_name} (${contact.phone})`);
          broadcastState();
          continue;
        }
      }

      // Stop immediately if WhatsApp disconnected mid-send
      if (state.whatsapp !== 'ready') {
        log('⚠️ WhatsApp disconnected during send — stopping campaign', 'error');
        state.sending.stopRequested = true;
        break;
      }

      // Build and send message
      const message = buildMessage(campaign, contact);
      const result  = await sendMessage(contact.phone, message, mediaPath, mediaFirst);

      if (result.success) {
        db.updateContactStatus(contact.id, 'sent');
        db.recordHistory({
          campaign_id: campaignId, campaign_contact_id: contact.id,
          campaign_name: campaign.name, phone: contact.phone,
          name: contact.name, label: contact.label, status: 'sent'
        });
        state.sending.sent++;
        log(`  ✅ ${contact.first_name || contact.name} (${contact.phone})`);
      } else {
        db.updateContactStatus(contact.id, 'failed', result.error);
        db.recordHistory({
          campaign_id: campaignId, campaign_contact_id: contact.id,
          campaign_name: campaign.name, phone: contact.phone,
          name: contact.name, label: contact.label, status: 'failed', error: result.error
        });
        state.sending.failed++;
        log(`  ❌ ${contact.first_name || contact.name}: ${result.error}`, 'error');
      }

      broadcastState();

      // Delay between messages
      if (!state.sending.stopRequested) {
        await sleep(randDelay(settings.delay_min, settings.delay_max));
      }
    }

    // Batch interval (not after last batch)
    if (b < batches.length - 1 && !state.sending.stopRequested) {
      const nextAt = new Date(Date.now() + settings.batch_interval_min * 60 * 1000);
      state.sending.nextBatchAt = nextAt.toISOString();
      broadcastState();
      log(`⏸ Batch done. Next batch at ${nextAt.toLocaleTimeString('en-IN')} (${settings.batch_interval_min} mins)`);
      await sleep(settings.batch_interval_min * 60 * 1000);
      state.sending.nextBatchAt = null;
    }
  }

  const finalStatus = state.sending.stopRequested ? 'paused' : 'completed';
  db.updateCampaign(campaignId, { status: finalStatus });

  log(`✅ Campaign "${campaign.name}" ${finalStatus} — ${state.sending.sent} sent, ${state.sending.failed} failed, ${state.sending.noweb} not on WA`);
  state.sending = null;
  broadcastState();
}

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — STATUS & WHATSAPP
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  res.json({ ...state, qrDataUrl: undefined });
});

app.get('/api/qr', (req, res) => {
  res.json({ qrDataUrl: state.qrDataUrl, status: state.whatsapp });
});

app.post('/api/whatsapp/connect', (req, res) => {
  if (state.whatsapp === 'ready')      return res.json({ ok: true, msg: 'Already connected' });
  if (state.whatsapp === 'connecting' ||
      state.whatsapp === 'qr')         return res.json({ ok: true, msg: 'Connecting...' });
  initWhatsApp();
  res.json({ ok: true });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  if (waClient) {
    try { await waClient.logout(); } catch {}
    waClient        = null;
    state.whatsapp  = 'disconnected';
    state.qrDataUrl = null;
    broadcastState();
  }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/settings', (req, res) => {
  res.json(db.getAllSettings());
});

app.post('/api/settings', (req, res) => {
  const allowed = [
    'default_country_code', 'default_batch_size', 'default_batch_interval_min',
    'default_delay_min', 'default_delay_max', 'default_daily_limit',
    'default_media_first', 'default_wa_check'
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.setSetting(key, req.body[key]);
  }
  res.json({ ok: true, settings: db.getAllSettings() });
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — CAMPAIGNS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/campaigns', (req, res) => {
  res.json(db.getAllCampaigns());
});

app.post('/api/campaigns', (req, res) => {
  try {
    const campaign = db.createCampaign(req.body);
    res.json(campaign);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = db.getCampaign(+req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

app.patch('/api/campaigns/:id', (req, res) => {
  const campaign = db.updateCampaign(+req.params.id, req.body);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

app.delete('/api/campaigns/:id', (req, res) => {
  db.deleteCampaign(+req.params.id);
  res.json({ ok: true });
});

// Get effective settings for a campaign (resolves auto vs manual)
app.get('/api/campaigns/:id/settings', (req, res) => {
  const settings = db.getCampaignSettings(+req.params.id);
  if (!settings) return res.status(404).json({ error: 'Campaign not found' });
  res.json(settings);
});

// ── Media upload for campaign ─────────────────────────────────────────────────
app.post('/api/campaigns/:id/media', upload.single('media'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const mime     = req.file.mimetype;
  const mediaType = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/')               ? 'video'
    : mime === 'application/pdf'              ? 'document'
    : null;

  if (!mediaType) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Unsupported file type. Use image, video, or PDF.' });
  }

  // Delete old media if exists
  const existing = db.getCampaign(+req.params.id);
  if (existing?.media_path && fs.existsSync(existing.media_path)) {
    try { fs.unlinkSync(existing.media_path); } catch {}
  }

  const campaign = db.updateCampaign(+req.params.id, {
    media_path:          req.file.path,
    media_type:          mediaType,
    media_original_name: req.file.originalname
  });

  res.json({ ok: true, campaign });
});

app.delete('/api/campaigns/:id/media', (req, res) => {
  const campaign = db.getCampaign(+req.params.id);
  if (campaign?.media_path && fs.existsSync(campaign.media_path)) {
    try { fs.unlinkSync(campaign.media_path); } catch {}
  }
  db.updateCampaign(+req.params.id, { media_path: null, media_type: null, media_original_name: null });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — CONTACTS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/campaigns/:id/contacts', (req, res) => {
  const { status, label, wa_valid, limit = 100, offset = 0, exclude_sent, search } = req.query;
  const result = db.getCampaignContacts(+req.params.id, {
    status:       status       || null,
    label:        label        || null,
    wa_valid:     wa_valid !== undefined ? +wa_valid : null,
    exclude_sent: exclude_sent === '1',
    search:       search       || null,
    limit:        +limit,
    offset:       +offset
  });
  res.json(result);
});

app.get('/api/campaigns/:id/labels', (req, res) => {
  res.json(db.getCampaignLabels(+req.params.id));
});

// Import contacts from Excel/CSV
app.post('/api/campaigns/:id/contacts/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const rows        = parseUploadedFile(req.file.path);
    const countryCode = req.body.country_code || db.getSetting('default_country_code') || '91';
    const result      = db.importContacts(+req.params.id, rows, req.file.originalname, countryCode);

    // Clean up uploaded contacts file
    try { fs.unlinkSync(req.file.path); } catch {}

    res.json({ ok: true, ...result });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/campaigns/:id/contacts', (req, res) => {
  db.clearContacts(+req.params.id);
  res.json({ ok: true });
});

// Delete individual contact
app.delete('/api/contacts/:id', (req, res) => {
  try {
    db.getDb().prepare('DELETE FROM campaign_contacts WHERE id = ?').run(+req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Edit individual contact name
app.patch('/api/contacts/:id', (req, res) => {
  const { first_name, last_name, name } = req.body;
  try {
    db.getDb().prepare(`
      UPDATE campaign_contacts
      SET first_name = ?, last_name = ?, name = ?
      WHERE id = ?
    `).run(first_name || null, last_name || null, name || null, +req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Reset failed contacts back to pending
app.post('/api/campaigns/:id/contacts/reset-failed', (req, res) => {
  const count = db.resetFailed(+req.params.id);
  res.json({ ok: true, reset: count });
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — QUEUE (PICK / REVIEW WORKFLOW)
// ══════════════════════════════════════════════════════════════════════════════

// Pick N contacts from pending → queued
app.post('/api/campaigns/:id/pick', (req, res) => {
  if (!req.body.count) return res.status(400).json({ error: 'count required' });
  const picked = db.pickContactsForReview(+req.params.id, +req.body.count);
  const queued = db.getQueuedContacts(+req.params.id);
  log(`📋 Picked ${picked} contacts for review (${queued.length} total queued)`);
  res.json({ ok: true, picked, totalQueued: queued.length });
});

// Get queued contacts
app.get('/api/campaigns/:id/queue', (req, res) => {
  res.json(db.getQueuedContacts(+req.params.id));
});

// Replenish queue to target count
app.post('/api/campaigns/:id/replenish', (req, res) => {
  const target = +req.body.count || 50;
  const added  = db.replenishQueue(+req.params.id, target);
  const queued = db.getQueuedContacts(+req.params.id);
  log(`➕ Replenished: added ${added} contacts (${queued.length} total queued)`);
  res.json({ ok: true, added, totalQueued: queued.length });
});

// Clear queue → move queued back to pending
app.post('/api/campaigns/:id/queue/clear', (req, res) => {
  const cleared = db.clearQueue(+req.params.id);
  log(`🗑️ Queue cleared: ${cleared} contacts moved back to pending`);
  res.json({ ok: true, cleared });
});

// Skip a contact (do not send in this campaign)
app.post('/api/contacts/:id/skip', (req, res) => {
  db.skipContact(+req.params.id);
  res.json({ ok: true });
});

// Manual send — send next N queued contacts immediately (bypasses batch schedule)
app.post('/api/campaigns/:id/send/manual', async (req, res) => {
  if (state.whatsapp !== 'ready') return res.status(400).json({ error: 'WhatsApp not connected' });
  if (state.sending)              return res.status(400).json({ error: 'Already sending' });

  const campaign = db.getCampaign(+req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const count    = Math.min(+req.body.count || 10, 100);
  const settings = db.getCampaignSettings(+req.params.id);
  const contacts = db.getQueuedContacts(+req.params.id).slice(0, count);

  if (!contacts.length) return res.status(400).json({ error: 'No queued contacts. Use Pick first.' });

  res.json({ ok: true, sending: contacts.length });

  // Run in background
  (async () => {
    const mediaPath  = campaign.media_path || null;
    const mediaFirst = parseInt(settings.media_first) === 1 || parseInt(campaign.media_first) === 1;
    let sent = 0; let failed = 0;

    log(`📤 Manual send — ${contacts.length} contacts`);

    for (const contact of contacts) {
      const message = buildMessage(campaign, contact);
      const result  = await sendMessage(contact.phone, message, mediaPath, mediaFirst);

      if (result.success) {
        db.updateContactStatus(contact.id, 'sent');
        db.recordHistory({ campaign_id: +req.params.id, campaign_contact_id: contact.id,
          campaign_name: campaign.name, phone: contact.phone, name: contact.name,
          label: contact.label, status: 'sent' });
        sent++;
        log(`  ✅ ${contact.first_name || contact.name} (${contact.phone})`);
      } else {
        db.updateContactStatus(contact.id, 'failed', result.error);
        db.recordHistory({ campaign_id: +req.params.id, campaign_contact_id: contact.id,
          campaign_name: campaign.name, phone: contact.phone, name: contact.name,
          label: contact.label, status: 'failed', error: result.error });
        failed++;
        log(`  ❌ ${contact.first_name || contact.name}: ${result.error}`, 'error');
      }

      await sleep(randDelay(settings.delay_min, settings.delay_max));
    }

    log(`✅ Manual send complete — ${sent} sent, ${failed} failed`);
    broadcast({ type: 'manual_send_complete', sent, failed });
  })();
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — WHATSAPP NUMBER CHECK
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Run WA check on all unchecked contacts in a campaign.
 * This can take a while for large lists — runs in background.
 */
app.post('/api/campaigns/:id/contacts/wa-check', async (req, res) => {
  if (state.whatsapp !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  const campaignId = +req.params.id;
  res.json({ ok: true, msg: 'WA check started in background' });

  // Run in background
  (async () => {
    const { contacts } = db.getCampaignContacts(campaignId, { wa_valid: null, limit: 5000 });
    log(`🔍 WA check: ${contacts.length} contacts to check`);
    let valid = 0; let invalid = 0;

    for (const contact of contacts) {
      const isWa = await checkWaNumber(contact.phone);
      if (isWa !== null) {
        db.setWaValid(campaignId, contact.phone, isWa);
        if (isWa) valid++; else invalid++;
      }
      await sleep(500); // Rate limit — 2 checks per second
    }

    log(`✅ WA check complete: ${valid} valid, ${invalid} not registered`);
    broadcast({ type: 'wa_check_complete', campaignId, valid, invalid });
  })();
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — SENDING
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/campaigns/:id/send/start', (req, res) => {
  if (state.whatsapp !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp not connected. Scan QR code first.' });
  }
  if (state.sending) {
    return res.status(400).json({ error: `Already sending campaign "${state.sending.campaignName}". Stop it first.` });
  }

  const campaign = db.getCampaign(+req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!campaign.message_template) return res.status(400).json({ error: 'Campaign has no message template' });

  const queuedContacts = db.getQueuedContacts(+req.params.id);
  if (!queuedContacts.length) return res.status(400).json({ error: 'No queued contacts. Use Pick Contacts first.' });

  res.json({ ok: true });
  runCampaign(+req.params.id); // background
});

app.post('/api/campaigns/:id/send/pause', (req, res) => {
  if (!state.sending || state.sending.campaignId !== +req.params.id) {
    return res.status(400).json({ error: 'This campaign is not currently sending' });
  }
  state.sending.pauseRequested = !state.sending.pauseRequested;
  const paused = state.sending.pauseRequested;
  log(paused ? '⏸ Campaign paused' : '▶️ Campaign resumed');
  broadcastState();
  res.json({ ok: true, paused });
});

app.post('/api/campaigns/:id/send/stop', (req, res) => {
  if (!state.sending || state.sending.campaignId !== +req.params.id) {
    return res.status(400).json({ error: 'This campaign is not currently sending' });
  }
  if (state.sending.stopRequested) {
    return res.json({ ok: true, msg: 'Already stopping' });
  }
  state.sending.stopRequested = true;
  log('🛑 Stop requested');
  broadcastState();
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// API ROUTES — HISTORY & LOGS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/history', (req, res) => {
  const { limit = 200, campaign_id } = req.query;
  res.json(db.getHistory({ limit: +limit, campaign_id: campaign_id ? +campaign_id : null }));
});

app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json({ lines: [] });
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-200).reverse();
    res.json({ lines });
  } catch { res.json({ lines: [] }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'state', data: { ...state, qrDataUrl: undefined } }));
  if (state.qrDataUrl) ws.send(JSON.stringify({ type: 'qr', dataUrl: state.qrDataUrl }));
});

// ══════════════════════════════════════════════════════════════════════════════
// START — with port conflict protection
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3004;

// Kill anything on this port before starting
try {
  execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
} catch {}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} in use — retrying in 3s...`);
    try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' }); } catch {}
    setTimeout(() => server.listen(PORT, onListening), 3000);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Health check — verify WhatsApp page is still alive every 5 minutes
setInterval(async () => {
  if (!waClient || state.whatsapp !== 'ready') return;
  try {
    await waClient.pupPage.evaluate(() => document.title);
  } catch (err) {
    log('⚠️ WhatsApp health check failed — reconnecting...', 'error');
    state.whatsapp = 'disconnected';
    broadcastState();
    try { await waClient.destroy(); } catch {}
    waClient = null;
    setTimeout(initWhatsApp, 3000);
  }
}, 5 * 60 * 1000);

function onListening() {
  console.log(`\n✅ WhatsApp Sender v3 running`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Port: ${PORT}\n`);

  db.init();

  // WhatsApp starts disconnected — user connects manually via dashboard
}

server.listen(PORT, onListening);
